/**
 * Device HMAC authentication guard (Phase 2 Build Spec §4.4).
 *
 * Verifies smartphone requests signed with a per-device symmetric secret:
 *
 *   X-Signature = HMAC-SHA256(secret, `${X-Timestamp}.${X-Nonce}.${rawBody}`)
 *
 * The raw request body (`request.rawBody`, enabled via `rawBody: true` in
 * `main.ts`) is signed *before* parsing, so the guard reproduces the exact
 * bytes. Every failure path raises a single generic `UnauthorizedException` and
 * never logs the secret, signature, key, or timestamp — an attacker learns
 * nothing about which check failed or whether the device exists.
 *
 * On success `request.device = { deviceId, householdId, memberId }` is injected
 * for the `@Device()` decorator, and Phase 3 (`card-sms`) reuses this guard.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { AppConfig } from '@family/config';
import {
  isUniqueViolation,
  schema,
  type Db,
  type DeviceCredential,
} from '@family/database';

import { DB } from '../database/database.constants';
import { DeviceSecretCipher } from './device-secret.cipher';
import { DeviceService } from './device.service';
import type { RequestWithDevice } from './decorators/device.decorator';

/** Fastify request with raw body access and the injected device principal. */
type HmacRequest = RequestWithDevice & { rawBody?: Buffer };

@Injectable()
export class DeviceHmacGuard implements CanActivate {
  private readonly toleranceSec: number;
  private readonly nonceTtlSec: number;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly cipher: DeviceSecretCipher,
    private readonly deviceService: DeviceService,
    configService: ConfigService,
  ) {
    const device = configService.get<AppConfig['device']>('device');
    if (!device) {
      throw new Error('Device configuration is missing');
    }
    this.toleranceSec = device.hmacTimestampToleranceSec;
    this.nonceTtlSec = device.nonceTtlSec;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<HmacRequest>();

    // 1. Required signature headers.
    const deviceId = this.header(request, 'x-device-id');
    const timestamp = this.header(request, 'x-timestamp');
    const nonce = this.header(request, 'x-nonce');
    const signature = this.header(request, 'x-signature');
    if (!deviceId || !timestamp || !nonce || !signature) {
      this.fail();
    }

    // 2. Content-Type must be JSON (the signed body is a JSON payload).
    const contentType = this.header(request, 'content-type');
    if (!contentType || !contentType.toLowerCase().startsWith('application/json')) {
      this.fail();
    }

    // 3. Device must exist, be active, and its owning member must still be an
    //    active household member (existence is never disclosed).
    //    구성원 제거 트랜잭션이 장치도 함께 폐기하지만, 그 이전에 만들어진 장치나
    //    다른 경로로 생긴 누락은 이 조인이 최종 방어선이다. member_id는 PK 조회라
    //    서명 검증 경로에 붙는 비용이 무시할 수준이다.
    const [device] = await this.db
      .select({
        id: schema.registeredDevices.id,
        householdId: schema.registeredDevices.householdId,
        memberId: schema.registeredDevices.memberId,
      })
      .from(schema.registeredDevices)
      .innerJoin(
        schema.householdMembers,
        eq(schema.householdMembers.id, schema.registeredDevices.memberId),
      )
      .where(
        and(
          eq(schema.registeredDevices.id, deviceId),
          eq(schema.registeredDevices.status, 'active'),
          eq(schema.householdMembers.status, 'active'),
          eq(
            schema.householdMembers.householdId,
            schema.registeredDevices.householdId,
          ),
        ),
      )
      .limit(1);
    if (!device) {
      this.fail();
    }

    // 4. Recover the active credential's secret.
    const credential = await this.deviceService.loadActiveCredential(device.id);
    if (!credential) {
      this.fail();
    }
    const secret = this.decryptSecret(credential);

    // 5. Timestamp freshness (epoch seconds within tolerance).
    const ts = Number(timestamp);
    if (!Number.isInteger(ts)) {
      this.fail();
    }
    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > this.toleranceSec) {
      this.fail();
    }

    // 6. Recompute and compare the signature in constant time.
    const rawBody = request.rawBody ?? Buffer.alloc(0);
    const signingString = `${timestamp}.${nonce}.${rawBody.toString('utf8')}`;
    const expected = createHmac('sha256', secret)
      .update(signingString, 'utf8')
      .digest();
    const provided = Buffer.from(signature, 'hex');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      this.fail();
    }

    // 7. Nonce replay protection — unique (deviceId, nonce) insert.
    try {
      await this.db.insert(schema.deviceNonces).values({
        deviceId: device.id,
        nonce,
        expiresAt: new Date((ts + this.nonceTtlSec) * 1000),
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        this.fail();
      }
      throw error;
    }

    // 8. Best-effort last-seen touch (never fails authentication).
    try {
      await this.deviceService.touchLastSeen(device.id);
    } catch {
      // Ignore — a failed touch must not reject an otherwise valid request.
    }

    // 9. Inject the authenticated device principal.
    request.device = {
      deviceId: device.id,
      householdId: device.householdId,
      memberId: device.memberId,
    };
    return true;
  }

  /**
   * Decrypts the stored secret. A GCM auth-tag failure (tampering, wrong key)
   * reads as an authentication failure and never surfaces secret material.
   */
  private decryptSecret(credential: DeviceCredential): Buffer {
    try {
      return this.cipher.decrypt({
        ciphertext: credential.secretCiphertext,
        iv: credential.secretIv,
        authTag: credential.secretAuthTag,
      });
    } catch {
      this.fail();
    }
  }

  /** Reads a header as a single string, or `null` if absent/multi-valued. */
  private header(request: FastifyRequest, name: string): string | null {
    const value = request.headers[name];
    return typeof value === 'string' ? value : null;
  }

  /** Raises the single generic authentication error used by every failure path. */
  private fail(): never {
    throw new UnauthorizedException('device authentication failed');
  }
}
