/**
 * Device secret cipher (Phase 2 Build Spec §4.2).
 *
 * Device HMAC secrets cannot be hashed — the server must recompute the same
 * signature with the *same symmetric key*. Per PRD §9 the raw secret is never
 * persisted; instead it is encrypted at rest with AES-256-GCM and only the
 * `{ciphertext, iv, authTag}` triple (base64) is stored.
 *
 * Secret hygiene: no method ever logs the key, the plaintext, or the ciphertext,
 * and decryption failures throw a generic error that carries no secret material.
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { AppConfig } from '@family/config';

/** AES-256-GCM parameters. */
const GCM_ALGORITHM = 'aes-256-gcm' as const;
const GCM_IV_BYTES = 12;
const AES_256_KEY_BYTES = 32;

/** Encrypted secret payload persisted on `device_credentials` (all base64). */
export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Input required to reverse {@link DeviceSecretCipher.encrypt}. */
export interface EncryptedSecretInput {
  ciphertext: string;
  iv: string;
  authTag: string;
}

@Injectable()
export class DeviceSecretCipher {
  /** Current key version — bump when `DEVICE_SECRET_ENC_KEY` is rotated. */
  static readonly KEY_VERSION = 1;

  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const device = configService.get<AppConfig['device']>('device');
    if (!device) {
      throw new Error('Device configuration is missing');
    }
    const key = Buffer.from(device.secretEncKey, 'hex');
    // Defensive: never echo the key or its material in the error.
    if (key.length !== AES_256_KEY_BYTES) {
      throw new Error('DEVICE_SECRET_ENC_KEY must decode to 32 bytes');
    }
    this.key = key;
  }

  /**
   * Encrypts a device secret with a fresh random IV. Returns base64 fields plus
   * the key version so a future key rotation can select the right key.
   */
  encrypt(plaintext: Buffer | string): EncryptedSecret {
    const input =
      typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    const iv = randomBytes(GCM_IV_BYTES);
    const cipher = createCipheriv(GCM_ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return {
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      keyVersion: DeviceSecretCipher.KEY_VERSION,
    };
  }

  /**
   * Decrypts a stored secret, verifying the GCM auth tag. Any failure (tampered
   * ciphertext, wrong key, corrupt tag) throws a generic error with no secret
   * material — callers treat this as an authentication failure.
   */
  decrypt(input: EncryptedSecretInput): Buffer {
    try {
      const iv = Buffer.from(input.iv, 'base64');
      const authTag = Buffer.from(input.authTag, 'base64');
      const ciphertext = Buffer.from(input.ciphertext, 'base64');
      const decipher = createDecipheriv(GCM_ALGORITHM, this.key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    } catch {
      throw new Error('failed to decrypt device secret');
    }
  }
}
