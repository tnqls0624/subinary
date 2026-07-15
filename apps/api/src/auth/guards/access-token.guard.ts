import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';

import type { AppConfig } from '@family/config';

import { IS_PUBLIC_KEY } from '../auth.constants';
import type { RequestWithUser } from '../decorators/current-user.decorator';

/** Access-token payload shape (`sub` = user id). */
interface AccessTokenPayload {
  sub: string;
  email: string;
}

/**
 * Global authentication guard (Phase 1 Build Spec §4.1 / §4.2).
 *
 * - Routes (or controllers) marked with `@Public()` pass through untouched.
 * - Otherwise an `Authorization: Bearer <jwt>` header is required and verified
 *   against `config.auth.accessSecret`; the decoded principal is attached to
 *   `request.user` for `@CurrentUser()`.
 * - Any failure raises a generic `UnauthorizedException` — token contents and
 *   verification errors are never surfaced to the caller or the logs.
 */
@Injectable()
export class AccessTokenGuard implements CanActivate {
  private readonly accessSecret: string;

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    const auth = configService.get<AppConfig['auth']>('auth');
    if (!auth) {
      throw new Error('Auth configuration is missing');
    }
    this.accessSecret = auth.accessSecret;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const token = this.extractBearerToken(request);
    if (!token) {
      throw new UnauthorizedException('unauthorized');
    }

    try {
      const payload = await this.jwtService.verifyAsync<AccessTokenPayload>(
        token,
        { secret: this.accessSecret },
      );
      request.user = { userId: payload.sub, email: payload.email };
    } catch {
      // 검증 실패 세부 정보(만료/서명 오류 등)는 노출하지 않는다.
      throw new UnauthorizedException('unauthorized');
    }

    return true;
  }

  /** Extracts the bearer token from the `Authorization` header, if well-formed. */
  private extractBearerToken(request: RequestWithUser): string | null {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || header.length === 0) {
      return null;
    }
    const [scheme, value] = header.split(' ');
    if (scheme !== 'Bearer' || !value) {
      return null;
    }
    const token = value.trim();
    return token.length > 0 ? token : null;
  }
}
