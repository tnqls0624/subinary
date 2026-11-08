import { Injectable } from '@nestjs/common';
import { HOUSING_BRANDS, type HousingBrand } from '@family/contracts';
import { HousingBrandReadError, type HousingBrandAdapter } from './brand-adapter';
import { SujainAdapter } from './sujain-adapter';

/**
 * 주택 브랜드 어댑터 등록표. 새 브랜드는 어댑터를 만들어 module providers 와 이 생성자에 한 줄씩 더한다.
 * 생성자에서 HOUSING_BRANDS 와 1:1 인지 검사한다 — 누락·중복·모르는 브랜드면 throw 해 부팅을 멈춘다.
 */
@Injectable()
export class HousingBrandRegistry {
  readonly #adapters: ReadonlyMap<HousingBrand, HousingBrandAdapter>;
  #running = false;

  constructor(sujain: SujainAdapter) {
    this.#adapters = adapterMap([sujain]);
  }

  get(brand: HousingBrand): HousingBrandAdapter {
    const adapter = this.#adapters.get(brand);
    if (!adapter) throw new HousingBrandReadError('runtime_unavailable');
    return adapter;
  }

  /**
   * API 프로세스 안의 주택 브랜드 브라우저 작업을 1개로 제한한다(Chromium 메모리). 이미 돌고 있으면 runtime_unavailable.
   * Nest 싱글턴이라 프로세스에 하나다. 클라이언트 자체 게이트(SujainBrowserClient 의 #active)는 그대로 둔다.
   */
  async run<T>(brand: HousingBrand, job: (adapter: HousingBrandAdapter) => Promise<T>): Promise<T> {
    const adapter = this.get(brand);
    if (this.#running) throw new HousingBrandReadError('runtime_unavailable');
    this.#running = true;
    try {
      return await job(adapter);
    } finally {
      this.#running = false;
    }
  }
}

function adapterMap(adapters: ReadonlyArray<HousingBrandAdapter | null | undefined>): ReadonlyMap<HousingBrand, HousingBrandAdapter> {
  const known = new Set<string>(HOUSING_BRANDS);
  const map = new Map<HousingBrand, HousingBrandAdapter>();
  for (const adapter of adapters) {
    if (!adapter || !known.has(adapter.brand) || map.has(adapter.brand)) {
      throw new Error('Housing brand adapters must match HOUSING_BRANDS one to one');
    }
    map.set(adapter.brand, adapter);
  }
  const missing = HOUSING_BRANDS.filter((brand) => !map.has(brand));
  if (missing.length > 0) throw new Error(`Housing brand adapter missing: ${missing.join(',')}`);
  return map;
}
