import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createZodDto } from 'nestjs-zod';

import type { AppConfig } from '@family/config';
import {
  changePasswordRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  type AuthResult,
  type MeResponse,
} from '@family/contracts';

import {
  REFRESH_COOKIE,
  REFRESH_COOKIE_PATH,
} from './auth.constants';
import { AuthService } from './auth.service';
import {
  CurrentUser,
  type AuthenticatedUser,
} from './decorators/current-user.decorator';
import { Public } from './decorators/public.decorator';

/** Validated request bodies (zod → nestjs-zod DTO). */
class RegisterDto extends createZodDto(registerRequestSchema) {}
class LoginDto extends createZodDto(loginRequestSchema) {}
class ChangePasswordDto extends createZodDto(changePasswordRequestSchema) {}

/** Acknowledgement body for endpoints without a resource payload. */
interface AckResponse {
  success: true;
}

/**
 * Auth endpoints (Phase 1 Build Spec §4.2).
 *
 * register/login/refresh are `@Public()`; logout/me/change-password require a
 * valid access token (enforced by the global {@link AccessTokenGuard}).
 * The opaque refresh token lives only in an HttpOnly cookie scoped to
 * `/v1/auth`; it is never returned in a response body.
 */
@Controller('auth')
export class AuthController {
  private readonly isProduction: boolean;
  private readonly refreshTtlSec: number;

  constructor(
    private readonly authService: AuthService,
    configService: ConfigService,
  ) {
    const app = configService.get<AppConfig['app']>('app');
    const auth = configService.get<AppConfig['auth']>('auth');
    if (!app || !auth) {
      throw new Error('Auth/app configuration is missing');
    }
    this.isProduction = app.nodeEnv === 'production';
    this.refreshTtlSec = auth.refreshTtlSec;
  }

  /** POST /v1/auth/register — create account, set refresh cookie. */
  @Public()
  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  async register(
    @Body() body: RegisterDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResult> {
    const result = await this.authService.register(
      body,
      request.headers['user-agent'],
    );
    this.setRefreshCookie(reply, result.refresh.raw);
    return { user: result.user, tokens: result.tokens };
  }

  /** POST /v1/auth/login — authenticate, set refresh cookie. */
  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResult> {
    const result = await this.authService.login(
      body,
      request.headers['user-agent'],
    );
    this.setRefreshCookie(reply, result.refresh.raw);
    return { user: result.user, tokens: result.tokens };
  }

  /** POST /v1/auth/refresh — rotate refresh cookie, issue new access token. */
  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AuthResult> {
    const rawRefresh = request.cookies?.[REFRESH_COOKIE];
    if (!rawRefresh) {
      throw new UnauthorizedException('invalid session');
    }
    const result = await this.authService.refresh(
      rawRefresh,
      request.headers['user-agent'],
    );
    this.setRefreshCookie(reply, result.refresh.raw);
    return { user: result.user, tokens: result.tokens };
  }

  /** POST /v1/auth/logout — revoke session + clear refresh cookie. */
  @Post('logout')
  @HttpCode(HttpStatus.OK)
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AckResponse> {
    await this.authService.logout(request.cookies?.[REFRESH_COOKIE]);
    this.clearRefreshCookie(reply);
    return { success: true };
  }

  /** GET /v1/auth/me — current user + active memberships. */
  @Get('me')
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponse> {
    return this.authService.me(user.userId);
  }

  /** POST /v1/auth/change-password — rotate password, revoke all sessions. */
  @Post('change-password')
  @HttpCode(HttpStatus.OK)
  async changePassword(
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: ChangePasswordDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AckResponse> {
    await this.authService.changePassword(
      user.userId,
      body.currentPassword,
      body.newPassword,
    );
    this.clearRefreshCookie(reply);
    return { success: true };
  }

  /** Sets the HttpOnly refresh cookie scoped to `/v1/auth`. */
  private setRefreshCookie(reply: FastifyReply, raw: string): void {
    reply.setCookie(REFRESH_COOKIE, raw, {
      httpOnly: true,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      secure: this.isProduction,
      maxAge: this.refreshTtlSec,
    });
  }

  /** Clears the refresh cookie using the same scope it was set with. */
  private clearRefreshCookie(reply: FastifyReply): void {
    reply.clearCookie(REFRESH_COOKIE, {
      httpOnly: true,
      sameSite: 'lax',
      path: REFRESH_COOKIE_PATH,
      secure: this.isProduction,
    });
  }
}
