import { Injectable } from '@nestjs/common';
import type { HousingBrand, HousingBrandSyncError } from '@family/contracts';
import {
  HousingBrandReadError, type HousingBrandAdapter, type HousingBrandCredentials, type HousingBrandReadResult,
} from './brand-adapter';
import { SujainBrowserClient, SujainBrowserError } from './sujain-browser';
import { isSujainUnsupportedLayout } from './sujain-parse';

/** 수자인 고유 용어(사이트 메뉴 'My 분양단지')가 들어가는 공개 문구. 나머지 코드는 공용 문구를 쓴다. */
export function sujainPublicErrorOverride(code: HousingBrandSyncError): string | null {
  // 분양대금조회의 단지 select 에 고를 세대가 없다 — 사이트에서 사용자가 먼저 등록해야 풀린다.
  if (code === 'unit_not_registered') return '수자인 사이트의 My 분양단지에 등록된 세대가 없어요. 사이트에서 먼저 등록해 주세요.';
  return null;
}

/**
 * 수자인 어댑터. SujainBrowserClient(러너 spawn)와 parseSujainRows 를 감싸기만 한다 — 해석 로직은 두 파일에 그대로 둔다.
 */
@Injectable()
export class SujainAdapter implements HousingBrandAdapter {
  readonly brand: HousingBrand = 'sujain';

  constructor(private readonly client: SujainBrowserClient) {}

  get available(): boolean {
    return this.client.available;
  }

  async read(credentials: HousingBrandCredentials, signal: AbortSignal): Promise<HousingBrandReadResult> {
    let capture: Awaited<ReturnType<SujainBrowserClient['read']>>;
    try {
      capture = await this.client.read(credentials, signal);
    } catch (error) {
      if (error instanceof SujainBrowserError) throw new HousingBrandReadError(error.code, error.reason);
      throw error;
    }
    const parsed = this.client.parseRows(capture.rows);
    // 연락처·회원 표는 파서가 건너뛴다. 읽을 줄이 하나도 없으면 연락처를 옵션으로 저장하거나
    // 조용한 빈 성공을 돌려주지 않고 unsupported_layout 으로 실패한다.
    if (isSujainUnsupportedLayout(parsed)) throw new HousingBrandReadError('unsupported_layout');
    return {
      capturedAt: capture.capturedAt,
      items: parsed.items,
      unreadCount: parsed.unreadCount,
      unreadReasons: parsed.unreadReasons,
    };
  }

  publicErrorOverride(code: HousingBrandSyncError): string | null {
    return sujainPublicErrorOverride(code);
  }
}
