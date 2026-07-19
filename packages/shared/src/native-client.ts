/** Capacitor WebView에서 API로 전달되는 신뢰 가능한 origin 목록. */
export const NATIVE_CLIENT_ORIGINS = [
  'capacitor://localhost',
  'http://localhost',
  'https://localhost',
  'ionic://localhost',
] as const;

export interface NativeClientIdentity {
  platform: string | string[] | undefined;
  origin: string | string[] | undefined;
}

const nativeClientOriginSet = new Set<string>(NATIVE_CLIENT_ORIGINS);

/**
 * 클라이언트가 지정할 수 있는 platform 헤더만으로 모바일 권한을 부여하지 않고,
 * 브라우저 스크립트가 바꿀 수 없는 Origin까지 Capacitor WebView 값인지 확인한다.
 */
export function isTrustedNativeClient(
  identity: NativeClientIdentity,
): boolean {
  const platform = Array.isArray(identity.platform)
    ? identity.platform[0]
    : identity.platform;
  const origin = Array.isArray(identity.origin)
    ? identity.origin[0]
    : identity.origin;
  return (
    platform === 'capacitor' &&
    origin !== undefined &&
    nativeClientOriginSet.has(origin)
  );
}
