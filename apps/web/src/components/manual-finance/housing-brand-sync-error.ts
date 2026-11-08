import {
  DEFAULT_HOUSING_BRAND,
  HOUSING_BRAND_INFO,
  housingBrandConnectionSchema,
  type HousingBrand,
  type HousingBrandConnection,
} from "@family/contracts";
import { ApiError } from "@/lib/api-client";

/** 서버 문구가 없을 때. 브랜드 이름만 바꿔 끼운다(수자인은 예전 글자 그대로). */
function fallbackMessage(brand: HousingBrand): string {
  return `${HOUSING_BRAND_INFO[brand].label} 조회를 끝내지 못했어요. 잠시 후 다시 눌러 주세요.`;
}

/** Prefer the API public message over a hardcoded extra-auth hint. */
export function housingBrandSyncErrorMessage(
  error: unknown,
  brand: HousingBrand = DEFAULT_HOUSING_BRAND
): string {
  if (error instanceof ApiError && error.message.trim()) return error.message;
  return fallbackMessage(brand);
}

/**
 * Sync failures also land on connection.statusMessage (top status area).
 * Hide the below-confirm local notice when it would repeat that sentence.
 * Connect/apply notices stay visible when they differ from status.
 */
export function housingBrandLocalErrorNotice(
  localError: string | null,
  statusMessage: string | null | undefined,
): string | null {
  if (!localError) return null;
  if (statusMessage && localError === statusMessage) return null;
  return localError;
}

/** Sync failures persist status on the connection; Nest may return it on the error body. */
export function connectionFromSyncError(error: unknown): HousingBrandConnection | null {
  if (!(error instanceof ApiError) || !error.body || typeof error.body !== "object") {
    return null;
  }
  const parsed = housingBrandConnectionSchema.safeParse(
    (error.body as { connection?: unknown }).connection
  );
  return parsed.success ? parsed.data : null;
}
