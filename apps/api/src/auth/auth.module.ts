import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, type JwtModuleOptions } from '@nestjs/jwt';

import type { AppConfig } from '@family/config';

import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AccessTokenGuard } from './guards/access-token.guard';
import { PasswordService } from './password.service';
import { TokenService } from './token.service';

/**
 * Auth module (Phase 1 Build Spec §4.1 / §4.2).
 *
 * - Configures `JwtModule` from `config.auth` (access secret + TTL).
 * - Registers {@link AccessTokenGuard} as a global `APP_GUARD`, so every route
 *   is protected unless annotated with `@Public()`.
 * - Exports `TokenService` (invitation hashing reuse) and `JwtModule`.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService): JwtModuleOptions => {
        const auth = configService.get<AppConfig['auth']>('auth');
        if (!auth) {
          throw new Error('Auth configuration is missing');
        }
        return {
          secret: auth.accessSecret,
          signOptions: { expiresIn: auth.accessTtlSec },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    TokenService,
    PasswordService,
    AuthService,
    AccessTokenGuard,
    // 전역 인증 가드: @Public()이 아닌 모든 라우트를 보호.
    { provide: APP_GUARD, useClass: AccessTokenGuard },
  ],
  exports: [TokenService, JwtModule],
})
export class AuthModule {}
