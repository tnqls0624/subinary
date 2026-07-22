import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@family/config';
import { createLogger, toSeoulString } from '@family/shared';

/**
 * 외화 → KRW 환율 조회 서비스.
 *
 * 외화 카드 거래를 승격할 때 승인 시점 환율로 KRW 환산액을 계산한다(원화 지출/예산/
 * 집계에 통합하기 위함). 조회는 무료 공개 API(open.er-api.com, 키 불필요)를 쓰고,
 * Asia/Seoul 날짜 단위로 인메모리 캐시한다(하루 1회 조회). API 장애·미지원 통화는
 * 내장 폴백 환율로 대체해 파싱/승격이 절대 막히지 않게 한다.
 *
 * ⚠️ 이 환율은 **추정치**다. 실제 원화 청구액은 매입(정산) 시점에 카드사 환율+
 * 수수료로 확정된다. 사용된 환율은 거래에 exchange_rate로 기록해 감사 가능하게 한다.
 */

/** 조회/폴백 실패 시 최후 방어용 내장 환율(KRW per 1 unit). 대략치, 갱신 무방. */
const FALLBACK_RATES: Readonly<Record<string, number>> = {
  USD: 1380,
  EUR: 1500,
  JPY: 9.1,
  GBP: 1750,
  CNY: 190,
  HKD: 176,
  AUD: 920,
  CAD: 1010,
  SGD: 1020,
  CHF: 1560,
  THB: 39,
  TWD: 43,
  VND: 0.055,
  PHP: 24,
  MYR: 300,
  NZD: 840,
  MOP: 171,
  IDR: 0.086,
};

const API_BASE = 'https://open.er-api.com/v6/latest';
const FETCH_TIMEOUT_MS = 4000;

@Injectable()
export class FxRateService {
  private readonly logger: ReturnType<typeof createLogger>;
  /** currency → { rate, day(Asia/Seoul YYYY-MM-DD) }. 프로세스 수명 캐시(하루 1회 조회). */
  private readonly cache = new Map<string, { rate: number; day: string }>();

  constructor(configService: ConfigService) {
    const nodeEnv = configService.get<AppConfig['app']>('app')?.nodeEnv;
    this.logger = createLogger('worker:fx-rate', { pretty: nodeEnv !== 'production' });
  }

  /**
   * 외화 1단위당 KRW 환율을 반환한다. KRW는 1. 오늘(Seoul) 캐시가 있으면 그대로,
   * 없으면 API 조회 → 실패 시 폴백. 폴백조차 없으면 예외(승격 잡 재시도 유도).
   */
  async getRateToKrw(currency: string): Promise<number> {
    const code = currency.toUpperCase();
    if (code === 'KRW') return 1;

    const day = toSeoulString(new Date(), 'yyyy-MM-dd');
    const cached = this.cache.get(code);
    if (cached && cached.day === day) return cached.rate;

    const fetched = await this.fetchRate(code);
    const rate = fetched ?? FALLBACK_RATES[code];
    if (rate === undefined || !(rate > 0)) {
      throw new Error(`no FX rate available for ${code}`);
    }
    if (fetched === null) {
      this.logger.warn({ currency: code, rate }, 'FX API unavailable; using fallback rate');
    }
    this.cache.set(code, { rate, day });
    return rate;
  }

  /** open.er-api.com에서 code→KRW 환율 조회. 실패 시 null(호출측이 폴백). */
  private async fetchRate(code: string): Promise<number | null> {
    try {
      const res = await fetch(`${API_BASE}/${code}`, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { result?: string; rates?: Record<string, number> };
      const rate = json?.rates?.KRW;
      return json?.result === 'success' && typeof rate === 'number' && rate > 0 ? rate : null;
    } catch (error) {
      this.logger.warn(
        { currency: code, err: error instanceof Error ? error.message : 'unknown' },
        'FX rate fetch failed',
      );
      return null;
    }
  }
}
