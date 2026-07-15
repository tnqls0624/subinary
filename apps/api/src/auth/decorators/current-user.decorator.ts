import {
  createParamDecorator,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/**
 * Authenticated principal injected onto the request by {@link AccessTokenGuard}
 * after a successful access-token verification.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/** Fastify request carrying the authenticated principal. */
export type RequestWithUser = FastifyRequest & { user?: AuthenticatedUser };

/**
 * `@CurrentUser()` param decorator → resolves `request.user`
 * (`{ userId, email }`). Throws `UnauthorizedException` if the guard did not
 * populate the principal (should never happen on a guarded route).
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;
    if (!user) {
      throw new UnauthorizedException('unauthorized');
    }
    return user;
  },
);
