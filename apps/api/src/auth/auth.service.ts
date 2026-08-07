import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq, isNull } from 'drizzle-orm';

import type {
  AuthTokens,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  UserSummary,
} from '@family/contracts';
import type { AppConfig } from '@family/config';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * refresh 토큰 회전 직후의 유예 창(ms).
 *
 * 액세스 토큰(15분)이 만료되는 순간, 여러 탭·대시보드 병렬 쿼리·SSE가 거의 동시에
 * 같은(방금 회전된) refresh 토큰을 제시하는 것은 정상 동작이다. 회전은 즉시 기존
 * 세션을 revoke하므로, 이 동시성 상황이 그대로 '재사용 공격'으로 오탐되면 전 세션이
 * 무효화되어 로그인이 풀린다(클라이언트 single-flight는 탭 단위라 다중 탭을 못 막음).
 *
 * 더 큰 유실 경로는 모바일이다: 회전 요청은 서버에 도달해 기존 토큰이 revoke됐지만,
 * 응답이 오기 전 iOS가 앱을 백그라운드 suspend/강제 종료하면 새 토큰을 저장하지 못하고
 * stale 토큰이 남는다. 30분~1시간 뒤 재개해 그 stale 토큰을 재제시하면 30초 창으로는
 * 못 덮어 '탈취'로 오판→전 세션 몰살(모바일·웹 동반 로그아웃)로 이어졌다.
 *
 * 따라서 이 창 안의 재제시는 탈취가 아니라 '응답 유실 후 재시도'로 보고, 401로 끊지
 * 않고 새 세션을 발급해 조용히 복구한다(refresh 참조). 가족 2인 + 토큰이
 * Keychain(whenUnlockedThisDeviceOnly)/HttpOnly 쿠키에 있어 1회용 토큰 추출 난도가 매우
 * 높은 위협 모델이라, 24h 복구 창의 재사용 노출은 자동 로그아웃 제거의 이득에 비해
 * 수용 가능한 교환이다.
 *
 * 창을 넘긴 재제시도 **그것만으로는 탈취가 아니다**(REUSE_BURST_* 주석 참조).
 */
const REFRESH_REUSE_GRACE_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * 재사용 '폭주' 판정 창(ms)과 임계값 — 유예 창 밖 재제시 중 진짜 탈취만 골라낸다.
 *
 * 왜 창 밖 단건으로는 전 세션을 죽이지 않는가:
 * 운영 DB 실측(2026-08-07)에서 user_sessions 465행 중 460이 revoked였고, 같은 초에
 * 2~4개 세션이 한꺼번에 폐기된 사건이 07-21~08-07에 12회 있었다. 동시 폐기는
 * revokeAllSessions 흔적이고 호출처는 재사용 탐지와 비밀번호 변경 둘뿐인데 사용자는
 * 비밀번호를 12번 바꾸지 않았다 → 전부 재사용 탐지 오탐이다. 실제 모양은 이렇다:
 * 앱을 하루 넘게 열지 않으면 회전 응답을 못 받고 남은 stale 토큰이 유예 24h를 넘기고,
 * 복귀 첫 refresh가 '탈취'로 오판돼 **웹까지 포함한 모든 기기**가 로그아웃됐다.
 * 위 위협 모델에서 전 세션 몰살의 대가(가족 전원 재로그인)가 방어 이득보다 크다.
 * → 회전으로 죽은 토큰의 지연 재제시는 그 요청만 401로 거절한다.
 *
 * 그럼 무엇을 탈취로 보는가 — **정상 클라이언트는 refresh 토큰을 한 개만 들고 있다**는
 * 사실을 쓴다(웹은 HttpOnly 쿠키 1개 + 탭 간 Web Locks 직렬화, 모바일은 보안 저장소
 * 1개이며 refresh가 401이면 세션을 정리하고 재로그인한다).
 *  - 같은 죽은 토큰을 여러 탭·병렬 요청이 동시에 제시 → 세션 1개로 센다. 오탐의
 *    주범이던 이 패턴은 임계값에 절대 닿지 않는다.
 *  - 서로 다른 죽은 토큰 3개가 15분 안에 온다 → 클라이언트 하나로는 만들 수 없는
 *    모양이다. 그 사용자의 과거 토큰 '뭉치'를 쥔 쪽(DB/백업 유출, 저장소 덤프)만
 *    가능하므로 이때는 계정 침해로 보고 전 세션을 무효화한다. 기기 2대(안드로이드+웹)
 *    위협 모델에서는 둘 다 동시에 stale이어도 2라서 오탐이 나지 않는다.
 *
 * 카운터는 프로세스 메모리에 둔다(운영 api 인스턴스 1개, prod compose에 replicas 없음).
 * 재시작하면 잊지만 그 방향의 오차는 '탐지를 놓친다'뿐이고 없는 탈취를 만들어내지는
 * 않는다 — 자동 로그아웃 제거가 목적이므로 실패는 이 방향이어야 한다.
 */
const REUSE_BURST_WINDOW_MS = 15 * 60 * 1000; // 15m
const REUSE_BURST_THRESHOLD = 3;

/** Freshly minted access tokens + the raw refresh token for the cookie. */
interface IssuedSession {
  tokens: AuthTokens;
  refresh: { raw: string; expiresAt: Date };
}

/** Result of register/login/refresh: public user + tokens + refresh material. */
export interface AuthSessionResult {
  user: UserSummary;
  tokens: AuthTokens;
  refresh: { raw: string; expiresAt: Date };
}

/**
 * Authentication service (Phase 1 Build Spec §4.2).
 *
 * Security posture:
 * - Email is normalised to lowercase before any lookup/insert.
 * - Login/refresh/change-password failures return a generic 401 that never
 *   reveals whether an account exists.
 * - Refresh tokens rotate on every use; replay of a rotated (revoked) token is
 *   refused (401) and only a burst of distinct dead tokens — which a single
 *   legitimate client cannot produce — revokes every session for that user.
 * - Passwords, hashes and tokens are never written to logs or error messages.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  /**
   * 유예 창 밖 재사용 기록: userId → (sessionId → 마지막 목격 시각 ms).
   * sessionId로 dedupe하므로 같은 토큰을 동시에 여러 번 제시해도 1로 센다.
   */
  private readonly reuseBurst = new Map<string, Map<string, number>>();

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokenService: TokenService,
    private readonly passwordService: PasswordService,
    private readonly configService: ConfigService,
  ) {}

  /** Creates an account, then opens an authenticated session. */
  async register(
    input: RegisterRequest,
    userAgent?: string,
    extendedTtl = false,
  ): Promise<AuthSessionResult> {
    await this.assertRegistrationAllowed(input.inviteToken);

    const email = this.normalizeEmail(input.email);

    const existing = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictException('email already registered');
    }

    const passwordHash = await this.passwordService.hash(input.password);
    const inserted = await this.db
      .insert(schema.users)
      .values({ email, passwordHash, name: input.name })
      .returning();
    const user = inserted[0];
    if (!user) {
      throw new Error('failed to persist user');
    }

    const session = await this.createSession(
      { id: user.id, email: user.email },
      userAgent,
      extendedTtl,
    );
    return {
      user: this.toUserSummary(user),
      tokens: session.tokens,
      refresh: session.refresh,
    };
  }

  /** Verifies credentials, then opens an authenticated session. */
  async login(
    input: LoginRequest,
    userAgent?: string,
    extendedTtl = false,
  ): Promise<AuthSessionResult> {
    const email = this.normalizeEmail(input.email);

    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, email))
      .limit(1);
    const user = rows[0];
    // 존재 여부를 노출하지 않도록 미존재/삭제/비밀번호 오류를 동일 메시지로 처리.
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('invalid credentials');
    }

    const valid = await this.passwordService.verify(
      user.passwordHash,
      input.password,
    );
    if (!valid) {
      throw new UnauthorizedException('invalid credentials');
    }

    const session = await this.createSession(
      { id: user.id, email: user.email },
      userAgent,
      extendedTtl,
    );
    return {
      user: this.toUserSummary(user),
      tokens: session.tokens,
      refresh: session.refresh,
    };
  }

  /**
   * Rotates a refresh token: revokes the presented session and issues a new
   * one. Replay of an already-revoked token revokes every session for the
   * user (reuse detection). All failure modes return a generic 401.
   */
  async refresh(
    rawRefresh: string,
    userAgent?: string,
  ): Promise<AuthSessionResult> {
    if (!rawRefresh) {
      throw new UnauthorizedException('invalid session');
    }
    const tokenHash = this.tokenService.hashToken(rawRefresh);

    const rows = await this.db
      .select()
      .from(schema.userSessions)
      .where(eq(schema.userSessions.refreshTokenHash, tokenHash))
      .limit(1);
    const session = rows[0];
    if (!session) {
      throw new UnauthorizedException('invalid session');
    }

    // 재사용 탐지: 이미 revoke된 세션의 토큰이 다시 제시된 경우.
    // - 유예 창(REFRESH_REUSE_GRACE_MS) 안: 다중 탭 동시 회전 / 모바일 회전 응답
    //   유실(백그라운드 suspend·앱 종료로 새 토큰 저장 실패) 후 재시도로 보고, 401로
    //   끊지 않고 아래 정상 회전 경로로 흘려보내 새 세션을 발급한다. 재-revoke는 멱등.
    // - 유예 창 밖: 이 요청만 401. 전 세션 무효화는 아래 두 경우로 한정한다.
    if (session.revokedAt) {
      const reason = session.revokedReason;
      // 유예는 **회전으로 죽은 세션에만** 적용한다. 로그아웃·비밀번호 변경으로 죽은
      // 세션까지 살려주면 그 조치가 24시간 동안 무효가 된다("모든 기기에서
      // 로그아웃"이 거짓이 됨). `revokedReason`이 NULL인 행은 이 컬럼 도입 이전
      // 세션이므로 기존 동작(유예 적용)을 유지한다 — 마이그레이션만으로 살아 있는
      // 세션을 끊지 않기 위해서다.
      const graceEligible = reason === 'rotated' || reason === null;
      const withinGrace =
        Date.now() - session.revokedAt.getTime() <= REFRESH_REUSE_GRACE_MS;

      if (!graceEligible || !withinGrace) {
        if (reason === 'rotated') {
          // 창 밖의 회전 토큰 재제시 = 앱이 하루 넘게 백그라운드에 있다 복귀한 정상
          // 시나리오다(REUSE_BURST_* 주석의 실측 12건이 전부 이 패턴). 단건으로는
          // 전 세션을 죽이지 않고 이 요청만 거절한다. 서로 다른 죽은 토큰이 짧은
          // 창 안에 쌓일 때만 계정 침해로 판단한다.
          if (this.recordReuse(session.userId, session.id)) {
            this.logger.warn(
              `refresh 재사용 폭주 감지 — 전 세션 무효화 (userId=${session.userId}, ` +
                `distinct=${REUSE_BURST_THRESHOLD}+/${REUSE_BURST_WINDOW_MS / 60_000}m)`,
            );
            await this.revokeAllSessions(session.userId, 'reuse_detected');
          }
        } else if (reason === null) {
          // 0045 이전 행은 회전인지 로그아웃인지 알 수 없다. 판단 근거가 없는 행에
          // 새 완화 정책을 적용하지 않고 기존 동작(창 밖 = 전 세션 무효화)을 남긴다.
          // 회전 시마다 reason이 채워지므로 이 행들은 자연 소멸한다.
          await this.revokeAllSessions(session.userId, 'reuse_detected');
        }
        // logout / password_change / reuse_detected: 이미 명시적으로 끊긴 세션이다.
        // 탈취 신호가 아니므로 전 세션을 몰살하지 않고 이 요청만 거절한다.
        throw new UnauthorizedException('invalid session');
      }
      // 유예 창 안 → 복구 경로로 폴백(throw 하지 않음).
    } else if (session.expiresAt.getTime() <= Date.now()) {
      throw new UnauthorizedException('invalid session');
    }
    // refresh 요청의 위조 가능한 platform/origin 헤더로 세션 수명을 승격하지 않는다.
    // 최초 발급 시 DB에 고정된 수명을 회전 세션이 그대로 계승한다.
    const extendedTtl =
      session.expiresAt.getTime() - session.createdAt.getTime() >
      this.tokenService.refreshTtlSeconds * 1_000;

    const userRows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, session.userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('invalid session');
    }

    // 회전: 기존 세션 revoke 후 새 세션 발급.
    // `rotated`만 재사용 유예 대상이다 — 로그아웃·비밀번호 변경으로 죽은 세션까지
    // 유예하면 그 조치들이 24시간 동안 무효가 된다.
    await this.db
      .update(schema.userSessions)
      .set({ revokedAt: new Date(), revokedReason: 'rotated' })
      .where(eq(schema.userSessions.id, session.id));

    const next = await this.createSession(
      { id: user.id, email: user.email },
      userAgent,
      extendedTtl,
    );
    return {
      user: this.toUserSummary(user),
      tokens: next.tokens,
      refresh: next.refresh,
    };
  }

  /** Revokes the session behind a refresh token, if any. Idempotent. */
  async logout(rawRefresh: string | undefined): Promise<void> {
    if (!rawRefresh) {
      return;
    }
    const tokenHash = this.tokenService.hashToken(rawRefresh);
    // `logout`은 유예 대상이 아니다 — 사용자가 명시적으로 끊은 세션이 되살아나면
    // 로그아웃 버튼이 거짓말이 된다.
    await this.db
      .update(schema.userSessions)
      .set({ revokedAt: new Date(), revokedReason: 'logout' })
      .where(
        and(
          eq(schema.userSessions.refreshTokenHash, tokenHash),
          isNull(schema.userSessions.revokedAt),
        ),
      );
  }

  /**
   * Changes a password after verifying the current one, then revokes every
   * session so all devices must re-authenticate.
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const user = rows[0];
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('invalid credentials');
    }

    const valid = await this.passwordService.verify(
      user.passwordHash,
      currentPassword,
    );
    if (!valid) {
      throw new UnauthorizedException('invalid credentials');
    }

    const passwordHash = await this.passwordService.hash(newPassword);
    await this.db
      .update(schema.users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(schema.users.id, userId));

    await this.revokeAllSessions(userId, 'password_change');
  }

  /** Returns the current user plus their active household memberships. */
  async me(userId: string): Promise<MeResponse> {
    const userRows = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    const user = userRows[0];
    if (!user || user.deletedAt) {
      throw new UnauthorizedException('unauthorized');
    }

    const memberships = await this.db
      .select({
        householdId: schema.householdMembers.householdId,
        name: schema.households.name,
        role: schema.householdMembers.role,
        status: schema.householdMembers.status,
      })
      .from(schema.householdMembers)
      .innerJoin(
        schema.households,
        eq(schema.households.id, schema.householdMembers.householdId),
      )
      .where(
        and(
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      );

    return {
      user: this.toUserSummary(user),
      memberships: memberships.map((m) => ({
        householdId: m.householdId,
        name: m.name,
        role: m.role,
        status: m.status,
      })),
    };
  }

  /**
   * Session-creation helper: issues an access token, generates + persists a
   * refresh session (expiry = now + refresh TTL), and returns both.
   */
  private async createSession(
    user: { id: string; email: string },
    userAgent?: string,
    // 모바일(Capacitor) 자동로그인은 1년 TTL, 웹(쿠키)은 기본 30일.
    extendedTtl = false,
  ): Promise<IssuedSession> {
    const { accessToken, expiresInSec } =
      await this.tokenService.issueAccessToken(user);
    const { raw, hash } = this.tokenService.generateRefreshToken();
    const ttlSec = extendedTtl
      ? this.tokenService.refreshTtlMobileSeconds
      : this.tokenService.refreshTtlSeconds;
    const expiresAt = new Date(Date.now() + ttlSec * 1000);

    await this.db.insert(schema.userSessions).values({
      userId: user.id,
      refreshTokenHash: hash,
      expiresAt,
      userAgent: userAgent ?? null,
    });

    const tokens: AuthTokens = {
      accessToken,
      tokenType: 'Bearer',
      expiresInSec,
    };
    return { tokens, refresh: { raw, expiresAt } };
  }

  /**
   * 유예 창 밖 재사용을 기록하고, 그 사용자가 폭주 임계값에 닿았는지 알려준다.
   *
   * 세션 단위로 dedupe한다 — 다중 탭이 같은 죽은 토큰을 동시에 밀어 넣어도 1건이다.
   * 임계값에 닿으면 엔트리를 비워, 이어지는 재제시가 (이미 전 세션이 죽은 뒤에도)
   * 반복해서 무효화를 재발화하지 않게 한다.
   *
   * @returns 전 세션 무효화가 필요하면 true
   */
  private recordReuse(userId: string, sessionId: string): boolean {
    const now = Date.now();
    // 재사용 거절은 드문 경로라 전체 스윕 비용이 무시할 만하다. 창을 넘긴 항목을
    // 여기서 걷어내 맵이 무한히 커지지 않게 한다(만료 전용 타이머를 두지 않는 이유).
    for (const [uid, seen] of this.reuseBurst) {
      for (const [sid, at] of seen) {
        if (now - at > REUSE_BURST_WINDOW_MS) seen.delete(sid);
      }
      if (seen.size === 0) this.reuseBurst.delete(uid);
    }

    const seen = this.reuseBurst.get(userId) ?? new Map<string, number>();
    seen.set(sessionId, now);
    this.reuseBurst.set(userId, seen);

    if (seen.size < REUSE_BURST_THRESHOLD) return false;
    this.reuseBurst.delete(userId);
    return true;
  }

  /**
   * Revokes every still-active session for a user.
   *
   * `reason`은 재사용 유예 판정에 쓰인다 — 여기서 죽는 세션은 회전이 아니라
   * 비밀번호 변경이나 탈취 탐지 결과이므로, 어느 쪽이든 유예 없이 즉시 401이어야 한다.
   */
  private async revokeAllSessions(
    userId: string,
    reason: 'password_change' | 'reuse_detected',
  ): Promise<void> {
    await this.db
      .update(schema.userSessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
        ),
      );
  }

  /** Lowercases + trims an email for canonical storage/lookup. */
  /**
   * 가입 개방 정책을 강제한다(config `auth.registrationMode`).
   *
   * 기본 `invite`에서는 **유효한 pending 초대 토큰**이 있어야 계정을 만들 수 있다.
   * 여기서 초대를 소비(수락)하지는 않는다 — 가입은 신원 생성, 수락은 가구 참여로
   * 분리돼 있고 수락은 기존 `/join` 흐름이 담당한다. 소비하면 링크를 재사용하는
   * 정상 흐름(가입 후 수락)이 깨진다.
   *
   * 토큰 유무를 응답으로 구분하지 않는다 — 유효/무효 모두 같은 403이라 초대 토큰
   * 존재 여부를 탐지하는 오라클이 되지 않는다.
   */
  private async assertRegistrationAllowed(inviteToken?: string): Promise<void> {
    const mode =
      this.configService.get<AppConfig['auth']>('auth')?.registrationMode ?? 'invite';
    if (mode === 'open') return;
    if (mode === 'closed') {
      throw new ForbiddenException('registration is closed');
    }

    if (!inviteToken) {
      throw new ForbiddenException('an invitation is required to register');
    }
    const tokenHash = this.tokenService.hashToken(inviteToken);
    const [invitation] = await this.db
      .select({
        status: schema.householdInvitations.status,
        expiresAt: schema.householdInvitations.expiresAt,
        revokedAt: schema.householdInvitations.revokedAt,
      })
      .from(schema.householdInvitations)
      .where(eq(schema.householdInvitations.tokenHash, tokenHash))
      .limit(1);

    const usable =
      invitation !== undefined &&
      invitation.status === 'pending' &&
      invitation.revokedAt === null &&
      invitation.expiresAt.getTime() > Date.now();
    if (!usable) {
      throw new ForbiddenException('an invitation is required to register');
    }
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  /** Projects a user row into the public-safe summary (never the hash). */
  private toUserSummary(user: {
    id: string;
    email: string;
    name: string;
    createdAt: Date;
  }): UserSummary {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt.toISOString(),
    };
  }
}
