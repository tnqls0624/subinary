import { Injectable } from '@nestjs/common';
import { Algorithm, hash, verify } from '@node-rs/argon2';

/**
 * Password hashing/verification via argon2id (Phase 1 Build Spec §4.2).
 *
 * `@node-rs/argon2` ships prebuilt binaries (no node-gyp). The algorithm and
 * parameters are encoded into the hash string, so `verify` reads them back.
 * Raw passwords and hashes are never logged.
 */
@Injectable()
export class PasswordService {
  /** Hashes a plaintext password with argon2id. */
  async hash(password: string): Promise<string> {
    return hash(password, { algorithm: Algorithm.Argon2id });
  }

  /** Verifies a plaintext password against a stored argon2id hash. */
  async verify(passwordHash: string, password: string): Promise<boolean> {
    try {
      return await verify(passwordHash, password);
    } catch {
      // 손상/형식오류 해시는 검증 실패로 간주(에러 세부·Secret 미출력).
      return false;
    }
  }
}
