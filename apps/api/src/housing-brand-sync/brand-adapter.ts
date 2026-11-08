/**
 * 주택 브랜드 어댑터 경계(docs/architecture/housing-brand-adapters.md 4장).
 * 서비스는 이 파일의 타입만 보고, 브랜드별 브라우저·표 해석은 어댑터 안에 둔다.
 * 레이아웃 진단은 인터페이스에 올리지 않는다 — 허용 토큰이 브랜드마다 달라 브랜드 클라이언트 로그에만 남긴다.
 */
import type { HousingBrand, HousingBrandFetchedItem, HousingBrandSyncError } from '@family/contracts';

export type HousingBrandCredentials = { loginId: string; password: string };

/** matchedPaymentId=null, changedFields=[] 상태. 맞추기는 서비스가 한다. */
export type HousingBrandReadResult = {
  /** ISO, offset 포함. */
  capturedAt: string;
  items: HousingBrandFetchedItem[];
  unreadCount: number;
  unreadReasons: string[];
};

export class HousingBrandReadError extends Error {
  constructor(
    readonly code: HousingBrandSyncError,
    /** 허용 목록 사유만. 자격 증명·stderr 원문은 넣지 않는다. */
    readonly reason: string | null = null,
  ) {
    super('Housing brand read did not complete');
  }
}

export interface HousingBrandAdapter {
  readonly brand: HousingBrand;
  /** false 면 read 는 runtime_unavailable. */
  readonly available: boolean;
  /**
   * 자격 증명은 stdin 으로만 넘기고 보관하지 않는다. 0건이면 unsupported_layout(빈 성공 금지).
   * credentials 객체는 복사하지 않고 그대로 넘긴다 — 서비스가 조회 뒤 같은 객체를 비운다.
   */
  read(credentials: HousingBrandCredentials, signal: AbortSignal): Promise<HousingBrandReadResult>;
  /** 브랜드 고유 용어가 필요한 코드만 덮어쓴다. null 이면 공용 문구를 쓴다. */
  publicErrorOverride?(code: HousingBrandSyncError, reason: string | null): string | null;
}
