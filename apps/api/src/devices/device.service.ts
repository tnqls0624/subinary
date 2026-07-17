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
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type {
  DeviceRegisterRequest,
  DeviceSecretResponse,
  DeviceSummary,
} from '@family/contracts';
import { schema, type Db } from '@family/database';

import { TokenService } from '../auth/token.service';
import { DB } from '../database/database.constants';
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
   */
  async registerDevice(
    userId: string,
    input: DeviceRegisterRequest,
  ): Promise<DeviceSecretResponse> {
    const membership = await this.resolveMembership(input.householdId, userId);

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

  /** Lists every device in the caller's household (any active member). */
  async listDevices(
    userId: string,
    householdId: string,
  ): Promise<DeviceSummary[]> {
    await this.resolveMembership(householdId, userId);

    const rows = await this.db
      .select()
      .from(schema.registeredDevices)
      .where(eq(schema.registeredDevices.householdId, householdId))
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

    await this.db.transaction(async (tx) => {
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
