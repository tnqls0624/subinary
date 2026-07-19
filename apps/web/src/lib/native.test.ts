import { beforeEach, describe, expect, it, vi } from "vitest";

const storageMocks = vi.hoisted(() => {
  const secureValues = new Map<string, unknown>();
  const preferenceValues = new Map<string, string>();

  return {
    nativePlatform: true,
    preferenceValues,
    secureValues,
    preferenceGet: vi.fn(async ({ key }: { key: string }) => ({
      value: preferenceValues.get(key) ?? null,
    })),
    preferenceSet: vi.fn(
      async ({ key, value }: { key: string; value: string }) => {
        preferenceValues.set(key, value);
      },
    ),
    preferenceRemove: vi.fn(async ({ key }: { key: string }) => {
      preferenceValues.delete(key);
    }),
    secureGet: vi.fn(async (key: string) => secureValues.get(key) ?? null),
    secureSet: vi.fn(async (key: string, value: unknown) => {
      secureValues.set(key, value);
    }),
    secureRemove: vi.fn(async (key: string) => secureValues.delete(key)),
    setKeyPrefix: vi.fn(async (_prefix: string) => undefined),
    setSynchronize: vi.fn(async (_synchronize: boolean) => undefined),
    setDefaultKeychainAccess: vi.fn(async (_access: number) => undefined),
  };
});

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    isNativePlatform: () => storageMocks.nativePlatform,
  },
}));

vi.mock("@capacitor/preferences", () => ({
  Preferences: {
    get: storageMocks.preferenceGet,
    set: storageMocks.preferenceSet,
    remove: storageMocks.preferenceRemove,
  },
}));

vi.mock("@aparajita/capacitor-secure-storage", () => ({
  KeychainAccess: {
    whenUnlockedThisDeviceOnly: 1,
  },
  SecureStorage: {
    get: storageMocks.secureGet,
    set: storageMocks.secureSet,
    remove: storageMocks.secureRemove,
    setKeyPrefix: storageMocks.setKeyPrefix,
    setSynchronize: storageMocks.setSynchronize,
    setDefaultKeychainAccess: storageMocks.setDefaultKeychainAccess,
  },
}));

const LEGACY_KEY = "family.refreshToken";
const MARKER_KEY = "family.secureRefreshStorageVersion";
const SECURE_KEY = "refreshToken";

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubGlobal("window", {});
  storageMocks.nativePlatform = true;
  storageMocks.preferenceValues.clear();
  storageMocks.secureValues.clear();
});

describe("네이티브 refresh 토큰 보안 저장", () => {
  it("웹 런타임에서는 저장소를 열지 않는다", async () => {
    storageMocks.nativePlatform = false;
    const {
      clearStoredRefreshToken,
      getStoredRefreshToken,
      persistRefreshToken,
    } = await import("./native");

    await expect(getStoredRefreshToken()).resolves.toBeNull();
    await expect(persistRefreshToken("web-token")).resolves.toBeUndefined();
    await expect(clearStoredRefreshToken()).resolves.toBeUndefined();

    expect(storageMocks.setKeyPrefix).not.toHaveBeenCalled();
    expect(storageMocks.preferenceGet).not.toHaveBeenCalled();
  });

  it("기존 Preferences 토큰을 기기 전용 보안 저장소로 1회 이전한다", async () => {
    storageMocks.preferenceValues.set(LEGACY_KEY, "legacy-token");
    const { getStoredRefreshToken } = await import("./native");

    await expect(getStoredRefreshToken()).resolves.toBe("legacy-token");

    expect(storageMocks.setKeyPrefix).toHaveBeenCalledWith("family-memory.");
    expect(storageMocks.setSynchronize).toHaveBeenCalledWith(false);
    expect(storageMocks.setDefaultKeychainAccess).toHaveBeenCalledWith(1);
    expect(storageMocks.secureSet).toHaveBeenCalledWith(
      SECURE_KEY,
      "legacy-token",
      false,
      false,
      1,
    );
    expect(storageMocks.secureValues.get(SECURE_KEY)).toBe("legacy-token");
    expect(storageMocks.preferenceValues.get(MARKER_KEY)).toBe("1");
    expect(storageMocks.preferenceValues.has(LEGACY_KEY)).toBe(false);
  });

  it("재설치 표식 없이 Keychain에만 남은 이전 세션을 폐기한다", async () => {
    storageMocks.secureValues.set(SECURE_KEY, "stale-token");
    const { getStoredRefreshToken } = await import("./native");

    await expect(getStoredRefreshToken()).resolves.toBeNull();

    expect(storageMocks.secureRemove).toHaveBeenCalledWith(SECURE_KEY, false);
    expect(storageMocks.secureValues.has(SECURE_KEY)).toBe(false);
    expect(storageMocks.preferenceValues.get(MARKER_KEY)).toBe("1");
  });

  it("보안 저장 쓰기가 실패하면 기존 토큰을 삭제하지 않고 오류를 감싼다", async () => {
    storageMocks.preferenceValues.set(LEGACY_KEY, "legacy-token");
    storageMocks.secureSet.mockRejectedValueOnce(new Error("keystore failure"));
    const { getStoredRefreshToken, SecureTokenStorageError } = await import(
      "./native"
    );

    await expect(getStoredRefreshToken()).rejects.toBeInstanceOf(
      SecureTokenStorageError,
    );
    expect(storageMocks.preferenceValues.get(LEGACY_KEY)).toBe("legacy-token");
    expect(storageMocks.preferenceRemove).not.toHaveBeenCalled();
  });

  it("새 토큰을 저장하고 기존 Preferences 값을 제거한다", async () => {
    storageMocks.preferenceValues.set(LEGACY_KEY, "old-token");
    const { persistRefreshToken } = await import("./native");

    await expect(persistRefreshToken("rotated-token")).resolves.toBeUndefined();

    expect(storageMocks.secureValues.get(SECURE_KEY)).toBe("rotated-token");
    expect(storageMocks.preferenceValues.get(MARKER_KEY)).toBe("1");
    expect(storageMocks.preferenceValues.has(LEGACY_KEY)).toBe(false);
  });

  it("동시 저장 요청을 직렬화해 마지막으로 받은 토큰을 보존한다", async () => {
    let releaseFirstWrite: (() => void) | undefined;
    storageMocks.secureSet.mockImplementationOnce(
      async (key: string, value: unknown) => {
        await new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
        storageMocks.secureValues.set(key, value);
      },
    );
    const { persistRefreshToken } = await import("./native");

    const first = persistRefreshToken("first-token");
    await vi.waitFor(() => expect(storageMocks.secureSet).toHaveBeenCalledOnce());
    const second = persistRefreshToken("second-token");

    await Promise.resolve();
    expect(storageMocks.secureSet).toHaveBeenCalledOnce();
    if (!releaseFirstWrite) throw new Error("첫 번째 저장 호출이 시작되지 않았습니다.");
    releaseFirstWrite();
    await Promise.all([first, second]);

    expect(storageMocks.secureValues.get(SECURE_KEY)).toBe("second-token");
  });

  it("보안 저장 삭제 실패 시에도 기존 Preferences 삭제를 시도한다", async () => {
    storageMocks.preferenceValues.set(LEGACY_KEY, "legacy-token");
    storageMocks.secureValues.set(SECURE_KEY, "secure-token");
    storageMocks.secureRemove.mockRejectedValueOnce(new Error("remove failure"));
    const { clearStoredRefreshToken, SecureTokenStorageError } = await import(
      "./native"
    );

    await expect(clearStoredRefreshToken()).rejects.toBeInstanceOf(
      SecureTokenStorageError,
    );
    expect(storageMocks.preferenceRemove).toHaveBeenCalledWith({ key: LEGACY_KEY });
    expect(storageMocks.preferenceValues.has(LEGACY_KEY)).toBe(false);
  });

  it("손상된 보안 저장 값을 토큰으로 사용하지 않는다", async () => {
    storageMocks.preferenceValues.set(MARKER_KEY, "1");
    storageMocks.secureValues.set(SECURE_KEY, { invalid: true });
    const { getStoredRefreshToken, SecureTokenStorageError } = await import(
      "./native"
    );

    await expect(getStoredRefreshToken()).rejects.toBeInstanceOf(
      SecureTokenStorageError,
    );
  });
});
