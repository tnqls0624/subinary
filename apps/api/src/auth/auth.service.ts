import {
  ConflictException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';

import type {
  AuthTokens,
  LoginRequest,
  MeResponse,
  RegisterRequest,
  UserSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

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
 * - Refresh tokens rotate on every use; replay of a rotated (revoked) token
 *   triggers revocation of every session for that user.
 * - Passwords, hashes and tokens are never written to logs or error messages.
 */
@Injectable()
export class AuthService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tokenService: TokenService,
    private readonly passwordService: PasswordService,
  ) {}

  /** Creates an account, then opens an authenticated session. */
  async register(
    input: RegisterRequest,
    userAgent?: string,
    extendedTtl = false,
  ): Promise<AuthSessionResult> {
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

    // 재사용 탐지: 이미 revoke된 세션의 토큰이 다시 제시되면 전체 세션 무효화.
    if (session.revokedAt) {
      await this.revokeAllSessions(session.userId);
      throw new UnauthorizedException('invalid session');
    }
    if (session.expiresAt.getTime() <= Date.now()) {
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
    await this.db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
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
    await this.db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
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

    await this.revokeAllSessions(userId);
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

  /** Revokes every still-active session for a user. */
  private async revokeAllSessions(userId: string): Promise<void> {
    await this.db
      .update(schema.userSessions)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.userSessions.userId, userId),
          isNull(schema.userSessions.revokedAt),
        ),
      );
  }

  /** Lowercases + trims an email for canonical storage/lookup. */
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
