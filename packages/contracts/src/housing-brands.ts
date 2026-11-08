import { z } from 'zod';

/**
 * 주택 브랜드 목록의 단일 근거(docs/architecture/housing-brand-adapters.md 4장).
 * 이 파일은 다른 계약 파일을 import 하지 않는 leaf 다 — manual-finance.ts 와
 * housing-brand-sync.ts 가 둘 다 여기서 가져가야 순환 import 가 생기지 않는다.
 * 브랜드 id 는 금고 AAD·login_fingerprint·DB brand 값으로 영구 고정된다.
 */
export const HOUSING_BRANDS = ['sujain'] as const;
/** z.literal('sujain') 과 parse 결과·오류·와이어가 같다. */
export const housingBrandSchema = z.enum(HOUSING_BRANDS);
export type HousingBrand = z.infer<typeof housingBrandSchema>;
export const DEFAULT_HOUSING_BRAND: HousingBrand = 'sujain';

export type HousingBrandInfo = {
  /** 화면 이름. */
  label: string;
  officialSite: `https://${string}/`;
  /** 러너 허용 목록·문서의 단일 근거. */
  allowedHosts: readonly string[];
};

export const HOUSING_BRAND_INFO = {
  sujain: {
    label: '수자인',
    officialSite: 'https://www.sujain.co.kr/',
    allowedHosts: ['www.sujain.co.kr', 'm.sujain.co.kr'],
  },
} as const satisfies Record<HousingBrand, HousingBrandInfo>;

/** 이름은 옛것이고 뜻은 '주택 브랜드 사이트에서 읽음'(브랜드 무관). 영구 토큰이며 바꾸지 않는다. */
export const HOUSING_BRAND_FETCH_SOURCE = 'sujain_fetch' as const;
