import { describe, expect, it } from 'vitest';

import {
  NATIVE_CLIENT_ORIGINS,
  isTrustedNativeClient,
} from './native-client.js';

describe('isTrustedNativeClient', () => {
  it.each(NATIVE_CLIENT_ORIGINS)(
    'Capacitor 헤더와 네이티브 origin 조합을 허용한다: %s',
    (origin) => {
      expect(
        isTrustedNativeClient({ platform: 'capacitor', origin }),
      ).toBe(true);
    },
  );

  it('공개 웹 origin이 모바일 헤더를 위조해도 거부한다', () => {
    expect(
      isTrustedNativeClient({
        platform: 'capacitor',
        origin: 'https://app.subinary.cloud',
      }),
    ).toBe(false);
  });

  it('origin 또는 platform 헤더가 없으면 거부한다', () => {
    expect(
      isTrustedNativeClient({ platform: 'capacitor', origin: undefined }),
    ).toBe(false);
    expect(
      isTrustedNativeClient({
        platform: undefined,
        origin: 'capacitor://localhost',
      }),
    ).toBe(false);
  });

  it('잘못된 platform 값을 거부한다', () => {
    expect(
      isTrustedNativeClient({
        platform: 'browser',
        origin: 'capacitor://localhost',
      }),
    ).toBe(false);
  });
});
