import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

import type { AppConfig } from '@family/config';

/** Subject required to mint an access token. */
export interface AccessTokenSubject {
  id: string;
  email: string;
}

/** Signed access token plus its lifetime (seconds). */
export interface IssuedAccessToken {
  accessToken: string;
  expiresInSec: number;
}

/** Opaque refresh token: `raw` is returned once, only `hash` is persisted. */
export interface GeneratedRefreshToken {
  raw: string;
  hash: string;
}

/**
 * Token minting/hashing (Phase 1 Build Spec §4.2).
 *
 * - Access tokens are short-lived signed JWTs (`config.auth.accessSecret`).
 * - Refresh tokens are opaque random values; only their sha256 hash is stored.
 * - `hashToken` is shared by refresh sessions and household invitations.
 */
@Injectable()
export class TokenService {
  private readonly accessSecret: string;
  private readonly accessTtlSec: number;
  private readonly refreshTtlSec: number;

  constructor(
    private readonly jwtService: JwtService,
    configService: ConfigService,
  ) {
    const auth = configService.get<AppConfig['auth']>('auth');
    if (!auth) {
      throw new Error('Auth configuration is missing');
    }
    this.accessSecret = auth.accessSecret;
    this.accessTtlSec = auth.accessTtlSec;
    this.refreshTtlSec = auth.refreshTtlSec;
  }

  /** Refresh-token lifetime in seconds (used for session expiry + cookie maxAge). */
  get refreshTtlSeconds(): number {
    return this.refreshTtlSec;
  }

  /** Signs a short-lived access token carrying `{ sub, email }`. */
  async issueAccessToken(user: AccessTokenSubject): Promise<IssuedAccessToken> {
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, email: user.email },
      { secret: this.accessSecret, expiresIn: this.accessTtlSec },
    );
    return { accessToken, expiresInSec: this.accessTtlSec };
  }

  /** Generates a fresh opaque refresh token and its persisted hash. */
  generateRefreshToken(): GeneratedRefreshToken {
    const raw = randomBytes(32).toString('hex');
    return { raw, hash: this.hashToken(raw) };
  }

  /** sha256 hex digest of a raw token (refresh / invitation). */
  hashToken(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }
}
