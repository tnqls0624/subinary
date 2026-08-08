/**
 * Device collect-token authentication guard (addendum — Shortcuts/MacroDroid
 * token ingest §4.2).
 *
 * Authenticates the low-friction card-SMS path for automation tools that cannot
 * compute an HMAC signature (iOS Shortcuts / Android MacroDroid):
 *
 *   Authorization: Bearer <collect token>
 *
 * The guard hashes the presented token with sha256 and matches it against
 * `registered_devices.collect_token_hash` for an `active` device. Only the hash
 * is stored (the raw token never touches the database), and neither the token
 * nor its hash is ever logged. Every failure path raises a single generic
 * `UnauthorizedException` so an attacker learns nothing about which check failed
 * or whether the device exists.
 *
 * On success `request.device = { deviceId, householdId, memberId }` is injected
 * for the `@Device()` decorator — the same principal shape `DeviceHmacGuard`
 * produces, so `CardSmsIngestService.ingest` is reused unchanged.
 *
 * Trade-off vs. the HMAC path: there is no signature/nonce/timestamp, so
 * per-request replay is not blocked here. Replay is instead neutralised by the
 * `UNIQUE(device_id, event_id)` idempotency on `card_sms_events`, and a leaked
 * token is handled by rotate/revoke.
 */
import { createHash } from 'node:crypto';

import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { schema, type Db } from '@family/database';

import { DB } from '../database/database.constants';
import type { RequestWithDevice } from './decorators/device.decorator';

/** Parses `Authorization: Bearer <token>` (scheme case-insensitive). */
const BEARER_PATTERN = /^Bearer\s+(\S+)\s*$/i;

@Injectable()
export class DeviceTokenGuard implements CanActivate {
  constructor(@Inject(DB) private readonly db: Db) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithDevice>();

    // 1. Bearer collect token is required.
    const token = this.bearerToken(request);
    if (!token) {
      this.fail();
    }

    // 2. Match sha256(token) against an active device *whose owning member is
    //    still an active household member* (existence never leaks).
    //    가구를 나가거나 제거된 구성원의 장치는 여기서 끊긴다. 제거 트랜잭션이
    //    장치를 함께 폐기하지만(HouseholdService.removeMember), 그 이전에 만들어진
    //    장치나 다른 경로로 생긴 누락은 이 조인이 최종 방어선이다.
    //    비용은 member_id(PK) 단건 조회라 수집 요청마다 붙어도 무시할 수준이다.
    const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
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
          eq(schema.registeredDevices.collectTokenHash, tokenHash),
          eq(schema.registeredDevices.status, 'active'),
          eq(schema.householdMembers.status, 'active'),
          // 장치와 멤버십이 같은 가구를 가리키는지도 확인한다(가구 경계 불변식).
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

    // 3. Best-effort last-seen touch (never fails an otherwise valid request).
    try {
      await this.db
        .update(schema.registeredDevices)
        .set({ lastSeenAt: new Date() })
        .where(eq(schema.registeredDevices.id, device.id));
    } catch {
      // Ignore — a failed touch must not reject authentication.
    }

    // 4. Inject the authenticated device principal.
    request.device = {
      deviceId: device.id,
      householdId: device.householdId,
      memberId: device.memberId,
    };
    return true;
  }

  /** Reads the Bearer token from the Authorization header, or `null`. */
  private bearerToken(request: FastifyRequest): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string') {
      return null;
    }
    const match = BEARER_PATTERN.exec(header.trim());
    return match ? match[1] : null;
  }

  /** Raises the single generic authentication error used by every failure path. */
  private fail(): never {
    throw new UnauthorizedException('device authentication failed');
  }
}
