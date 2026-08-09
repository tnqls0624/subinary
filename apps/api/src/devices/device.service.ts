/**
 * Device domain service (Phase 2 Build Spec §4.3).
 *
 * Authorization is enforced *here* in the service layer against `actorUserId`
 * (PRD §26) — controllers and guards never make trust decisions. Every path
 * resolves the caller's active household membership first, so a non-member
 * always receives a 403 and the device secret is never disclosed.
 *
 * Secret hygiene: raw device secrets are generated locally, returned exactly
 * once (on register/rotate), and only their AES-256-GCM ciphertext is
 * persisted. Neither the raw secret nor the ciphertext is ever logged.
 *
 * Collect-token hygiene (addendum — Shortcuts/MacroDroid token ingest): a raw
 * collect token is generated locally, returned exactly once alongside the
 * secret, and only its sha256 hash is persisted on `registered_devices`. The
 * raw token and its hash are never logged. `DeviceTokenGuard` authenticates the
 * low-friction `POST /v1/mobile-events/card-sms-token` path against that hash.
 */
import { createHash, randomBytes } from 'node:crypto';

import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';

import type {
  DeviceRegisterRequest,
  DeviceSecretResponse,
  DeviceSummary,
} from '@family/contracts';
import { isUniqueViolation, schema, type Db } from '@family/database';

import { TokenService } from '../auth/token.service';
import { DB } from '../database/database.constants';
import {
  hasActiveConsent,
  loadConsentHistory,
} from '../household/household-consent';
import { DeviceSecretCipher } from './device-secret.cipher';

/** Length of the raw device secret in bytes (hex-encoded → 64 chars). */
const SECRET_BYTES = 32;

/** Length of the raw collect token in bytes (256-bit → 64 hex chars). */
const COLLECT_TOKEN_BYTES = 32;

/**
 * sha256(token) as lowercase hex. Only this hash of a collect token is ever
 * persisted; the raw token is never stored and never logged.
 */
function hashCollectToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** HMAC algorithm advertised to clients (matches the guard's verification). */
const SIGNING_ALGORITHM = 'HMAC-SHA256' as const;

/** Human-readable recipe for deriving `X-Signature` (Phase 2 Build Spec §3). */
const SIGNING_RECIPE =
  'HMAC-SHA256(secret, `${X-Timestamp}.${X-Nonce}.${rawBody}`)';

/** Projects a device row onto the credential-free public summary. */
function toDeviceSummary(device: schema.RegisteredDevice): DeviceSummary {
  return {
    id: device.id,
    householdId: device.householdId,
    memberId: device.memberId,
    name: device.name,
    platform: device.platform,
    status: device.status,
    lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
    // 인증 성공(lastSeenAt)과 문자 수신(first/lastEventAt)은 다른 신호다. 하나만
    // 내보내면 화면이 "인증은 되는데 문자 트리거가 안 걸림"을 정상으로 표시한다.
    firstEventAt: device.firstEventAt ? device.firstEventAt.toISOString() : null,
    lastEventAt: device.lastEventAt ? device.lastEventAt.toISOString() : null,
    createdAt: device.createdAt.toISOString(),
  };
}

@Injectable()
export class DeviceService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cipher: DeviceSecretCipher,
    private readonly tokenService: TokenService,
  ) {}

  /* ---------------------------------------------------------------------- */
  /* Authorization helpers                                                   */
  /* ---------------------------------------------------------------------- */

  /**
   * Resolves the caller's active membership in `householdId`. Non-members get a
   * 403 that does not disclose whether the household (or its devices) exist.
   */
  private async resolveMembership(
    householdId: string,
    userId: string,
  ): Promise<schema.HouseholdMember> {
    const [member] = await this.db
      .select()
      .from(schema.householdMembers)
      .where(
        and(
          eq(schema.householdMembers.householdId, householdId),
          eq(schema.householdMembers.userId, userId),
          eq(schema.householdMembers.status, 'active'),
        ),
      )
      .limit(1);

    if (!member) {
      throw new ForbiddenException('not a household member');
    }
    return member;
  }

  /**
   * Loads a device by id (404 if unknown) and asserts the caller may manage it:
   * the device's own member, or the household owner. The membership lookup runs
   * against the device's household, so a caller outside that household is
   * rejected with a 403.
   */
  private async requireManageableDevice(
    userId: string,
    deviceId: string,
  ): Promise<schema.RegisteredDevice> {
    const device = await this.loadDevice(deviceId);
    const membership = await this.resolveMembership(device.householdId, userId);

    const isDeviceOwner = membership.id === device.memberId;
    const isHouseholdOwner = membership.role === 'owner';
    if (!isDeviceOwner && !isHouseholdOwner) {
      throw new ForbiddenException('insufficient permission');
    }
    return device;
  }

  /* ---------------------------------------------------------------------- */
  /* Device management                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Registers a smartphone under the caller's household and issues its first
   * secret and collect token. Both raw credentials are returned exactly once.
   *
   * 동의를 철회한 사용자는 등록할 수 없다(C-3). 철회는 기존 기기를 폐기하지만, 그
   * 직후 새 기기를 등록할 수 있으면 철회가 연극이 된다 — 사용자는 수집을 껐다고 믿는데
   * 다음 등록 한 번으로 조용히 되살아난다. 판정은 `household-consent.ts`의 함수를
   * 그대로 쓴다(Control Center와 같은 정의).
   */
  async registerDevice(
    userId: string,
    input: DeviceRegisterRequest,
  ): Promise<DeviceSecretResponse> {
    const membership = await this.resolveMembership(input.householdId, userId);

    const consentHistory = await loadConsentHistory(
      this.db,
      input.householdId,
      userId,
    );
    if (!hasActiveConsent(consentHistory)) {
      throw new ForbiddenException('household consent has been revoked');
    }

    const rawSecret = randomBytes(SECRET_BYTES).toString('hex');
    const encrypted = this.cipher.encrypt(rawSecret);

    const rawCollectToken = randomBytes(COLLECT_TOKEN_BYTES).toString('hex');
    const collectTokenHash = hashCollectToken(rawCollectToken);

    const device = await this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(schema.registeredDevices)
        .values({
          householdId: input.householdId,
          memberId: membership.id,
          name: input.name,
          platform: input.platform,
          status: 'active',
          collectTokenHash,
          createdBy: userId,
        })
        .returning();
      if (!created) {
        throw new Error('failed to register device');
      }

      await tx.insert(schema.deviceCredentials).values({
        deviceId: created.id,
        secretCiphertext: encrypted.ciphertext,
        secretIv: encrypted.iv,
        secretAuthTag: encrypted.authTag,
        keyVersion: encrypted.keyVersion,
        status: 'active',
      });

      return created;
    });

    return this.buildSecretResponse(device, rawSecret, rawCollectToken);
  }

  /**
   * Lists the caller's household devices (any active member). Revoked devices
   * are excluded — revoke is a soft delete (the row stays for audit/history and
   * to keep nonce/credential FKs intact), but a polished list only shows active
   * ones. To surface revoked devices later, add an explicit `?includeRevoked`.
   */
  async listDevices(
    userId: string,
    householdId: string,
  ): Promise<DeviceSummary[]> {
    await this.resolveMembership(householdId, userId);

    const rows = await this.db
      .select()
      .from(schema.registeredDevices)
      .where(
        and(
          eq(schema.registeredDevices.householdId, householdId),
          eq(schema.registeredDevices.status, 'active'),
        ),
      )
      .orderBy(schema.registeredDevices.createdAt);

    return rows.map(toDeviceSummary);
  }

  /**
   * Rotates a device's credentials: the current active secret credential is
   * revoked and a new active credential is issued, and the collect token is
   * re-minted (its stored hash replaced). The new raw secret and collect token
   * are returned exactly once; the previous collect token stops authenticating.
   */
  async rotateSecret(
    userId: string,
    deviceId: string,
  ): Promise<DeviceSecretResponse> {
    const device = await this.requireManageableDevice(userId, deviceId);

    const rawSecret = randomBytes(SECRET_BYTES).toString('hex');
    const encrypted = this.cipher.encrypt(rawSecret);

    const rawCollectToken = randomBytes(COLLECT_TOKEN_BYTES).toString('hex');
    const collectTokenHash = hashCollectToken(rawCollectToken);
    const now = new Date();

    try {
      await this.db.transaction(async (tx) => {
        // 장치 행을 잠가 장치별로 회전을 직렬화한다. 잠그지 않으면 두 회전이 서로의
        // revoke 이전 스냅샷을 보고 각각 active credential을 남겨, 서버가 임의로
        // 고른 쪽과 클라이언트가 받은 secret이 달라 401이 난다.
        // revokeDevice도 같은 행을 잠그므로 회전/폐기가 교차하지 않는다.
        const [locked] = await tx
          .select({ id: schema.registeredDevices.id })
          .from(schema.registeredDevices)
          .where(eq(schema.registeredDevices.id, deviceId))
          .for('update')
          .limit(1);
        if (!locked) {
          throw new NotFoundException('device not found');
        }

        await tx
          .update(schema.deviceCredentials)
          .set({ status: 'revoked', revokedAt: now })
          .where(
            and(
              eq(schema.deviceCredentials.deviceId, deviceId),
              eq(schema.deviceCredentials.status, 'active'),
            ),
          );

        await tx.insert(schema.deviceCredentials).values({
          deviceId,
          secretCiphertext: encrypted.ciphertext,
          secretIv: encrypted.iv,
          secretAuthTag: encrypted.authTag,
          keyVersion: encrypted.keyVersion,
          status: 'active',
        });

        await tx
          .update(schema.registeredDevices)
          .set({ collectTokenHash, updatedAt: now })
          .where(eq(schema.registeredDevices.id, deviceId));
      });
    } catch (error) {
      // 부분 유니크(device_credentials_device_active_unique) 위반은 잠금이 있는 한
      // 애플리케이션 경합으로는 나올 수 없다 — 마이그레이션 이전에 생긴 잔여 중복이나
      // 앱 밖 쓰기가 원인이다. 재시도하면 같은 데이터 문제로 계속 실패하므로 409로
      // 돌려주고 운영자가 정리하게 한다(secret은 이미 폐기되지 않았다 — 롤백됐다).
      if (isUniqueViolation(error)) {
        throw new ConflictException('device credential rotation conflicted');
      }
      throw error;
    }

    return this.buildSecretResponse(device, rawSecret, rawCollectToken);
  }

  /**
   * Revokes a device and all of its credentials. Subsequent signed requests
   * fail the HMAC guard (device status !== 'active'). Idempotent.
   */
  async revokeDevice(
    userId: string,
    deviceId: string,
  ): Promise<{ revoked: true }> {
    await this.requireManageableDevice(userId, deviceId);

    const now = new Date();
    await this.db.transaction(async (tx) => {
      // rotateSecret과 같은 잠금 지점 — 폐기 직후 회전이 새 active를 끼워 넣는 것을 막는다.
      await tx
        .select({ id: schema.registeredDevices.id })
        .from(schema.registeredDevices)
        .where(eq(schema.registeredDevices.id, deviceId))
        .for('update')
        .limit(1);

      await tx
        .update(schema.registeredDevices)
        .set({ status: 'revoked', revokedAt: now, updatedAt: now })
        .where(eq(schema.registeredDevices.id, deviceId));

      await tx
        .update(schema.deviceCredentials)
        .set({ status: 'revoked', revokedAt: now })
        .where(
          and(
            eq(schema.deviceCredentials.deviceId, deviceId),
            eq(schema.deviceCredentials.status, 'active'),
          ),
        );
    });

    return { revoked: true };
  }

  /* ---------------------------------------------------------------------- */
  /* Guard-facing helpers (DeviceHmacGuard)                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * Returns the device's currently active credential, or `null`. Used by
   * {@link DeviceHmacGuard} to recover the secret for signature verification.
   */
  async loadActiveCredential(
    deviceId: string,
  ): Promise<schema.DeviceCredential | null> {
    const [credential] = await this.db
      .select()
      .from(schema.deviceCredentials)
      .where(
        and(
          eq(schema.deviceCredentials.deviceId, deviceId),
          eq(schema.deviceCredentials.status, 'active'),
        ),
      )
      // 부분 유니크가 붙은 뒤에는 최대 1행이지만, 그 이전에 생긴 잔여 중복이 있으면
      // 정렬 없는 limit(1)은 요청마다 다른 credential을 고를 수 있다. 최신 것을
      // 고정 선택해 마이그레이션의 정리 규칙(가장 최근 회전분을 남긴다)과 맞춘다.
      .orderBy(desc(schema.deviceCredentials.createdAt))
      .limit(1);

    return credential ?? null;
  }

  /** Best-effort `lastSeenAt` touch after a device authenticates. */
  async touchLastSeen(deviceId: string): Promise<void> {
    await this.db
      .update(schema.registeredDevices)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.registeredDevices.id, deviceId));
  }

  /* ---------------------------------------------------------------------- */
  /* Internal loaders                                                        */
  /* ---------------------------------------------------------------------- */

  private async loadDevice(deviceId: string): Promise<schema.RegisteredDevice> {
    const [device] = await this.db
      .select()
      .from(schema.registeredDevices)
      .where(eq(schema.registeredDevices.id, deviceId))
      .limit(1);
    if (!device) {
      throw new NotFoundException('device not found');
    }
    return device;
  }

  private buildSecretResponse(
    device: schema.RegisteredDevice,
    rawSecret: string,
    rawCollectToken: string,
  ): DeviceSecretResponse {
    return {
      device: toDeviceSummary(device),
      deviceId: device.id,
      secret: rawSecret,
      algorithm: SIGNING_ALGORITHM,
      signingRecipe: SIGNING_RECIPE,
      collectToken: rawCollectToken,
    };
  }
}
