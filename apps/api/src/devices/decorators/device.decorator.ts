import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Authenticated device principal injected onto the request by
 * {@link DeviceHmacGuard} after a successful HMAC verification (Phase 2 Build
 * Spec §4.4). Carries no credential material.
 */
export interface DeviceContext {
  deviceId: string;
  householdId: string;
  memberId: string;
}

/** Fastify request carrying the authenticated device principal. */
export type RequestWithDevice = FastifyRequest & { device?: DeviceContext };

/**
 * `@Device()` param decorator → resolves `request.device`
 * (`{ deviceId, householdId, memberId }`). Throws `UnauthorizedException` if the
 * guard did not populate it (should never happen on a guarded route).
 */
export const Device = createParamDecorator(
  (_data: unknown, context: ExecutionContext): DeviceContext => {
    const request = context.switchToHttp().getRequest<RequestWithDevice>();
    const device = request.device;
    if (!device) {
      throw new UnauthorizedException('device authentication failed');
    }
    return device;
  },
);
