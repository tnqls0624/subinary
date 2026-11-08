import { createCipheriv, createDecipheriv } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ConfigService } from '@nestjs/config';
import { FinanceVault, type VaultContext, type VaultEnvelope } from './finance-vault';

// Entirely synthetic keys and data. These tests never load process.env or provider credentials.
const KEY_ONE = '11'.repeat(32), KEY_TWO = '22'.repeat(32);
const context: VaultContext = { ownerUserId: '11111111-1111-4111-8111-111111111111',
  provider: 'toss_securities', connectionId: '22222222-2222-4222-8222-222222222222', purpose: 'credentials' };
function vault(config: unknown = { enabled: true, activeKeyVersion: 1, keyring: { '1': KEY_ONE } }): FinanceVault {
  return new FinanceVault({ get: (name: string) => name === 'financeConnections' ? config : undefined } as ConfigService);
}
function failed(operation: () => unknown): void {
  expect(operation).toThrowError('Finance vault operation failed');
}

describe('dedicated finance vault', () => {
  it('bank passwords are encrypted with a separate provider binding from securities', () => {
    const instance = vault();
    const bankContext: VaultContext = { ...context, provider: 'shinhan_bank' };
    const value = { loginId: 'synthetic-bank-id', password: 'SYNTHETIC_BANK_SECRET' };
    const envelope = instance.encrypt(value, bankContext);
    expect(instance.decrypt(envelope, bankContext)).toEqual(value);
    expect(JSON.stringify(envelope)).not.toContain(value.password);
    failed(() => instance.decrypt(envelope, context));
    failed(() => instance.decrypt(instance.encrypt(value, context), bankContext));
    failed(() => instance.encrypt(value, { ...bankContext, purpose: 'token' }));
  });

  it('sujain housing credentials stay isolated from toss and shinhan provider bindings', () => {
    const instance = vault();
    const sujain: VaultContext = { ...context, provider: 'sujain' };
    const bank: VaultContext = { ...context, provider: 'shinhan_bank' };
    const value = { loginId: 'synthetic-sujain-id', password: 'SYNTHETIC_SUJAIN_SECRET' };
    const envelope = instance.encrypt(value, sujain);
    expect(instance.decrypt(envelope, sujain)).toEqual(value);
    expect(JSON.stringify(envelope)).not.toContain(value.password);
    expect(JSON.stringify(envelope)).not.toContain(value.loginId);
    failed(() => instance.decrypt(envelope, context));
    failed(() => instance.decrypt(envelope, bank));
    failed(() => instance.encrypt(value, { ...sujain, purpose: 'token' }));
  });

  it('sujain credentials keep the exact legacy AAD, so old envelopes open without re-encryption', () => {
    // 기존 봉투의 AAD: ['family.finance-vault', 1, owner, 'sujain', connectionId, 'credentials', keyVersion].
    // 주택 브랜드를 일반화해도 provider 를 'housing:sujain' 같은 형태로 바꾸면 이 테스트가 깨져야 한다.
    const legacyAad = Buffer.from(JSON.stringify(['family.finance-vault', 1, '11111111-1111-4111-8111-111111111111',
      'sujain', '22222222-2222-4222-8222-222222222222', 'credentials', 1]), 'utf8');
    const legacyContext: VaultContext = { ownerUserId: '11111111-1111-4111-8111-111111111111', provider: 'sujain',
      connectionId: '22222222-2222-4222-8222-222222222222', purpose: 'credentials' };
    const value = { loginId: 'synthetic-sujain-id', password: 'x'.repeat(16), brand: 'sujain' };
    const key = Buffer.from(KEY_ONE, 'hex');

    // 옛 봉투(고정 AAD 로 직접 봉함) → 지금 금고가 같은 값의 context 로 연다.
    const iv = Buffer.alloc(12, 7);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
    cipher.setAAD(legacyAad);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const legacy: VaultEnvelope = { version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64') };
    expect(vault().decrypt(legacy, { ...legacyContext })).toEqual(value);
    // 대문자 uuid 로 만든 context 도 같은 AAD(소문자)다.
    expect(vault().decrypt(legacy, { ...legacyContext, ownerUserId: legacyContext.ownerUserId.toUpperCase(),
      connectionId: legacyContext.connectionId.toUpperCase() })).toEqual(value);
    failed(() => vault().decrypt(legacy, { ...legacyContext, provider: 'shinhan_bank' }));

    // 지금 금고가 봉한 봉투 → 고정 AAD 로 직접 연다.
    const sealed = vault().encrypt(value, legacyContext);
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(sealed.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(legacyAad);
    decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
    const opened = Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, 'base64')), decipher.final()]);
    expect(JSON.parse(opened.toString('utf8'))).toEqual(value);
  });

  it('is disabled without finance configuration, even if an unrelated device key exists', () => {
    const seen: string[] = [];
    const instance = new FinanceVault({ get: (name: string) => {
      seen.push(name);
      return name === 'device' ? { secretEncKey: KEY_ONE } : undefined;
    } } as ConfigService);
    expect(instance.enabled).toBe(false);
    expect(seen).toEqual(['financeConnections']);
    failed(() => instance.encrypt({ secret: 'synthetic' }, context));
    failed(() => instance.decrypt(vault().encrypt({ secret: 'synthetic' }, context), context));
  });

  it('requires explicit enablement, even when dedicated keys are present', () => {
    expect(vault({ enabled: false, activeKeyVersion: 1, keyring: { '1': KEY_ONE } }).enabled).toBe(false);
    expect(vault({ activeKeyVersion: 1, keyring: { '1': KEY_ONE } }).enabled).toBe(false);
  });

  it('roundtrips Unicode JSON and hides keys from incidental object serialization', () => {
    const instance = vault();
    const value = { clientId: 'synthetic-client', clientSecret: '가상 비밀', nested: ['0.0001', '9007199254740993'] };
    const encrypted = instance.encrypt(value, context);
    expect(encrypted.version).toBe(1);
    expect(Buffer.from(encrypted.iv, 'base64')).toHaveLength(12);
    expect(Buffer.from(encrypted.tag, 'base64')).toHaveLength(16);
    expect(instance.decrypt(encrypted, context)).toEqual(value);
    expect(JSON.stringify(encrypted)).not.toContain(value.clientSecret);
    expect(JSON.stringify(instance)).toBe('{}');
  });

  it('uses a fresh random IV for every encryption', () => {
    const instance = vault();
    const first = instance.encrypt('same synthetic value', context), second = instance.encrypt('same synthetic value', context);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it.each([
    { ownerUserId: '33333333-3333-4333-8333-333333333333' },
    { connectionId: '33333333-3333-4333-8333-333333333333' },
    { provider: 'unapproved_provider' }, { purpose: 'token' }, { purpose: 'accounts' },
  ])('cannot move an envelope to another owner, provider, connection or purpose: %o', change => {
    const instance = vault(), encrypted = instance.encrypt('synthetic', context);
    failed(() => instance.decrypt(encrypted, { ...context, ...change } as VaultContext));
  });

  it('supports retained old versions for decryption and writes with the active version only', () => {
    const old = vault().encrypt({ token: 'synthetic' }, { ...context, purpose: 'token' });
    const rotated = vault({ enabled: true, activeKeyVersion: 2, keyring: { '1': KEY_ONE, '2': KEY_TWO } });
    expect(rotated.decrypt(old, { ...context, purpose: 'token' })).toEqual({ token: 'synthetic' });
    expect(rotated.encrypt('new', context).version).toBe(2);
    failed(() => rotated.decrypt({ ...old, version: 2 }, { ...context, purpose: 'token' }));
    failed(() => vault({ enabled: true, activeKeyVersion: 2, keyring: { '2': KEY_TWO } }).decrypt(old, { ...context, purpose: 'token' }));
  });

  it('authenticates the version even when two versions accidentally contain the same key', () => {
    const instance = vault({ enabled: true, activeKeyVersion: 1, keyring: { '1': KEY_ONE, '2': KEY_ONE } });
    const encrypted = instance.encrypt('synthetic', context);
    failed(() => instance.decrypt({ ...encrypted, version: 2 }, context));
  });

  it('rejects ciphertext/tag/IV tampering and noncanonical base64', () => {
    const instance = vault(), encrypted = instance.encrypt({ secret: 'synthetic' }, context);
    for (const field of ['ciphertext', 'tag', 'iv'] as const) {
      const bytes = Buffer.from(encrypted[field], 'base64');
      bytes[0] ^= 1;
      failed(() => instance.decrypt({ ...encrypted, [field]: bytes.toString('base64') }, context));
      failed(() => instance.decrypt({ ...encrypted, [field]: encrypted[field] + '\n' }, context));
    }
    failed(() => instance.decrypt({ ...encrypted, iv: Buffer.alloc(11).toString('base64') }, context));
    failed(() => instance.decrypt({ ...encrypted, tag: Buffer.alloc(15).toString('base64') }, context));
    failed(() => instance.decrypt({ ...encrypted, ciphertext: '' }, context));
  });

  it('rejects unknown envelope fields, invalid versions and unavailable keys', () => {
    const instance = vault(), encrypted = instance.encrypt('synthetic', context);
    for (const version of [0, -1, 1.5, 2_147_483_648, Number.NaN, 9]) failed(() => instance.decrypt({ ...encrypted, version }, context));
    failed(() => instance.decrypt({ ...encrypted, extra: 'synthetic' } as VaultEnvelope, context));
    failed(() => vault({ enabled: true, activeKeyVersion: 1, keyring: { '1': KEY_TWO } }).decrypt(encrypted, context));
  });

  it('bounds UTF-8 plaintext and rejects invalid serialization with a generic error', () => {
    const instance = vault();
    const boundary = 'x'.repeat(256 * 1024 - 2);
    expect(instance.decrypt(instance.encrypt(boundary, context), context)).toBe(boundary);
    failed(() => instance.encrypt(boundary + 'x', context));
    failed(() => instance.encrypt('가'.repeat(100_000), context));
    failed(() => instance.encrypt(undefined, context));
    failed(() => instance.encrypt(1n, context));
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    failed(() => instance.encrypt(cyclic, context));
  });

  it('fails malformed enabled configuration without echoing key material', () => {
    for (const config of [{ enabled: true }, { enabled: true, activeKeyVersion: 1 },
      { enabled: true, activeKeyVersion: 2, keyring: { '1': KEY_ONE } },
      { enabled: true, activeKeyVersion: 1, keyring: { '1': 'SYNTHETIC_BAD_SECRET' } }]) {
      expect(() => vault(config)).toThrowError('Finance vault configuration unavailable');
    }
  });
});
