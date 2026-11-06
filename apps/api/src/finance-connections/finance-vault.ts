import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { configSchema, type AppConfig } from '@family/config';

export interface VaultEnvelope {
  /** The dedicated key version, also authenticated in the additional data. */
  version: number;
  iv: string;
  tag: string;
  ciphertext: string;
}
export interface VaultContext {
  ownerUserId: string;
  /** 수자인(sujain)은 토스증권·신한과 공급자를 섞지 않는 별도 바인딩이다. */
  provider: 'toss_securities' | 'shinhan_bank' | 'sujain';
  connectionId: string;
  purpose: 'credentials' | 'token' | 'accounts';
}

const MAX_PLAINTEXT_BYTES = 256 * 1024;
const MAX_CIPHERTEXT_BASE64 = Math.ceil(MAX_PLAINTEXT_BYTES / 3) * 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PURPOSES = new Set(['credentials', 'token', 'accounts']);
const PROVIDERS = new Set(['toss_securities', 'shinhan_bank', 'sujain']);
const CREDENTIALS_ONLY = new Set(['shinhan_bank', 'sujain']);
const fail = () => new Error('Finance vault operation failed');

function additionalData(context: VaultContext, version: number): Buffer {
  if (!context || typeof context.ownerUserId !== 'string' || context.ownerUserId.length !== 36 || !UUID.test(context.ownerUserId)
    || typeof context.connectionId !== 'string' || context.connectionId.length !== 36 || !UUID.test(context.connectionId)
    || !PROVIDERS.has(context.provider) || !PURPOSES.has(context.purpose)
    || (CREDENTIALS_ONLY.has(context.provider) && context.purpose !== 'credentials')) throw fail();
  return Buffer.from(JSON.stringify(['family.finance-vault', 1, context.ownerUserId.toLowerCase(),
    context.provider, context.connectionId.toLowerCase(), context.purpose, version]), 'utf8');
}

/** Node's base64 decoder is permissive; persisted envelopes must use canonical base64. */
function decode(value: unknown, exactLength?: number): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_CIPHERTEXT_BASE64
    || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw fail();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value || (exactLength !== undefined && decoded.length !== exactLength)
    || decoded.length > MAX_PLAINTEXT_BYTES) throw fail();
  return decoded;
}

function validateEnvelope(value: VaultEnvelope): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'ciphertext,iv,tag,version'
    || !Number.isInteger(value.version) || value.version < 1 || value.version > 2_147_483_647) throw fail();
}

/**
 * At-rest encryption for this feature only. Keys never come from device/SMS configuration.
 * Private fields keep keys out of incidental object serialization. This cannot erase JS
 * strings held by request/config owners; callers must not log, cache or persist plaintext.
 */
@Injectable()
export class FinanceVault {
  #enabled = false;
  #activeVersion: number | null = null;
  #keys = new Map<number, Buffer>();

  constructor(configService: ConfigService) {
    const raw = configService.get<AppConfig['financeConnections']>('financeConnections');
    const parsed = configSchema.shape.financeConnections.safeParse(raw);
    if (!parsed.success) throw new Error('Finance vault configuration unavailable');
    const config = parsed.data;
    if (!config.enabled) return;
    // The schema verifies the active key. Recheck without echoing input at the boundary.
    if (!config.activeKeyVersion || !config.keyring || !Object.hasOwn(config.keyring, String(config.activeKeyVersion))) {
      throw new Error('Finance vault configuration unavailable');
    }
    for (const [version, key] of Object.entries(config.keyring)) this.#keys.set(Number(version), Buffer.from(key, 'hex'));
    this.#activeVersion = config.activeKeyVersion;
    this.#enabled = true;
  }

  get enabled(): boolean { return this.#enabled; }

  encrypt(value: unknown, context: VaultContext): VaultEnvelope {
    let plaintext: Buffer | undefined;
    try {
      const version = this.#activeVersion;
      const key = version === null ? undefined : this.#keys.get(version);
      if (!this.enabled || version === null || !key) throw fail();
      const serialized = JSON.stringify(value);
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_PLAINTEXT_BYTES) throw fail();
      plaintext = Buffer.from(serialized, 'utf8');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      cipher.setAAD(additionalData(context, version));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return { version, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
        ciphertext: ciphertext.toString('base64') };
    } catch { throw fail(); }
    finally { plaintext?.fill(0); }
  }

  decrypt<T>(envelope: VaultEnvelope, context: VaultContext): T {
    let plaintext: Buffer | undefined;
    let partial: Buffer | undefined;
    try {
      if (!this.enabled) throw fail();
      validateEnvelope(envelope);
      const key = this.#keys.get(envelope.version);
      if (!key) throw fail();
      const iv = decode(envelope.iv, 12), tag = decode(envelope.tag, 16), ciphertext = decode(envelope.ciphertext);
      const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
      decipher.setAAD(additionalData(context, envelope.version));
      decipher.setAuthTag(tag);
      partial = decipher.update(ciphertext);
      plaintext = Buffer.concat([partial, decipher.final()]);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)) as T;
    } catch { throw fail(); }
    finally { partial?.fill(0); plaintext?.fill(0); }
  }
}
