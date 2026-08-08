/**
 * 역사 환율 스냅샷 조회·고정 (ADR-0027 §3, 마이그레이션 `0049`).
 *
 * **공급자 클라이언트는 여기 없다.** ADR "미해결·보류"가 공급자 선택을 별도 결정으로
 * 미뤘고, 롤아웃 4단계(공급자·dry-run 게이트)가 그 자리다. 이 파일은 "이미 고정된
 * 값을 찾는다"와 "외부에서 받은 값을 한 번만 못 박는다" 두 가지만 한다.
 *
 * 그래서 shadow 단계(3)에서 외화 거래는 대부분 `fx_snapshot_missing`으로 계획이
 * 거부된다. 그것이 **정확한 측정 결과**다 — 스냅샷을 아직 아무도 채우지 않았으므로
 * 지금 enforce로 넘어가면 외화 거래가 전부 검토로 빠진다는 사실을 숫자로 남긴다.
 * 기존 `exchange_rate`(승격일 환율)로 스냅샷을 만들어 메우면 안 된다 — 그건 D-1이
 * 만든 잘못된 값을 "역사 환율"이라는 이름으로 영구 고정하는 짓이다.
 */
import { MONEY_CONTRACT_VERSION_V2, schema, type DbExecutor } from '@family/database';
import { and, eq } from 'drizzle-orm';

import type { FxSnapshotRef } from './plan.js';

/** 스냅샷의 자연키 — `(원통화, 기준일, 계약 버전)`. quote는 항상 KRW다. */
export interface FxSnapshotKey {
  readonly baseCurrency: string;
  /** 서울 기준 `YYYY-MM-DD`. */
  readonly asOfDate: string;
  readonly moneyContractVersion?: number;
}

/** 외부 공급자에서 받은 값을 고정할 때 함께 남기는 출처. */
export interface FxSnapshotOrigin {
  readonly provider: string;
  readonly providerVersion: string;
  readonly providerReference?: string | null;
  readonly note?: string | null;
  /** 운영자가 직접 고정한 대체 환율이면 그 사용자. */
  readonly createdBy?: string | null;
  readonly fetchedAt: Date;
}

/**
 * 계획기에 스냅샷을 공급하는 포트. 실행기·shadow 관찰기는 이 인터페이스만 본다 —
 * 테스트가 DB 없이 스냅샷을 주입할 수 있어야 계획기 검증이 성립한다.
 */
export interface FxSnapshotResolver {
  find(key: FxSnapshotKey): Promise<FxSnapshotRef | null>;
  findById(id: string): Promise<FxSnapshotRef | null>;
}

export class DrizzleFxSnapshotStore implements FxSnapshotResolver {
  constructor(private readonly db: DbExecutor) {}

  async find(key: FxSnapshotKey): Promise<FxSnapshotRef | null> {
    const version = key.moneyContractVersion ?? MONEY_CONTRACT_VERSION_V2;
    const [row] = await this.db
      .select(SNAPSHOT_COLUMNS)
      .from(schema.fxRateSnapshots)
      .where(
        and(
          eq(schema.fxRateSnapshots.baseCurrency, key.baseCurrency.toUpperCase()),
          eq(schema.fxRateSnapshots.quoteCurrency, 'KRW'),
          eq(schema.fxRateSnapshots.asOfDate, key.asOfDate),
          eq(schema.fxRateSnapshots.moneyContractVersion, version),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<FxSnapshotRef | null> {
    const [row] = await this.db
      .select(SNAPSHOT_COLUMNS)
      .from(schema.fxRateSnapshots)
      .where(eq(schema.fxRateSnapshots.id, id))
      .limit(1);
    return row ?? null;
  }

  /**
   * `(통화, 기준일, 계약 버전)`의 **첫 성공 값**을 고정하고, 이미 있으면 그 행을
   * 그대로 돌려준다.
   *
   * `onConflictDoUpdate`가 아니라 `onConflictDoNothing` + SELECT인 이유:
   * `0049`의 `fx_rate_snapshots_immutable` 트리거가 UPDATE를 거부한다. DO UPDATE는
   * UPDATE라 트리거에 걸려 통째로 실패한다. 그리고 그게 맞는 의미이기도 하다 —
   * "첫 성공 값을 고정하고 모든 재시도가 같은 행을 참조한다"(ADR §3).
   */
  async fixate(
    key: FxSnapshotKey,
    rate: string,
    origin: FxSnapshotOrigin,
  ): Promise<FxSnapshotRef | null> {
    const version = key.moneyContractVersion ?? MONEY_CONTRACT_VERSION_V2;
    const baseCurrency = key.baseCurrency.toUpperCase();

    await this.db
      .insert(schema.fxRateSnapshots)
      .values({
        baseCurrency,
        quoteCurrency: 'KRW',
        asOfDate: key.asOfDate,
        rate,
        provider: origin.provider,
        providerVersion: origin.providerVersion,
        providerReference: origin.providerReference ?? null,
        moneyContractVersion: version,
        note: origin.note ?? null,
        createdBy: origin.createdBy ?? null,
        fetchedAt: origin.fetchedAt,
      })
      .onConflictDoNothing({
        target: [
          schema.fxRateSnapshots.baseCurrency,
          schema.fxRateSnapshots.quoteCurrency,
          schema.fxRateSnapshots.asOfDate,
          schema.fxRateSnapshots.moneyContractVersion,
        ],
      });

    return this.find({ baseCurrency, asOfDate: key.asOfDate, moneyContractVersion: version });
  }
}

const SNAPSHOT_COLUMNS = {
  id: schema.fxRateSnapshots.id,
  baseCurrency: schema.fxRateSnapshots.baseCurrency,
  asOfDate: schema.fxRateSnapshots.asOfDate,
  rate: schema.fxRateSnapshots.rate,
  moneyContractVersion: schema.fxRateSnapshots.moneyContractVersion,
} as const;

/**
 * 같은 요청 안에서 같은 `(통화, 기준일)`을 여러 번 묻는 것을 막는 얇은 캐시.
 *
 * 프로세스 수명 캐시로 두지 않는 이유: 스냅샷은 불변이므로 캐시 자체는 안전하지만,
 * **없다는 사실**은 불변이 아니다(복구 작업이 나중에 채운다). 없음을 오래 캐시하면
 * 스냅샷을 채운 뒤에도 계속 실패한다. 요청 단위로만 산다.
 */
export class RequestScopedFxSnapshotResolver implements FxSnapshotResolver {
  private readonly byKey = new Map<string, FxSnapshotRef | null>();
  private readonly byId = new Map<string, FxSnapshotRef | null>();

  constructor(private readonly inner: FxSnapshotResolver) {}

  async find(key: FxSnapshotKey): Promise<FxSnapshotRef | null> {
    const version = key.moneyContractVersion ?? MONEY_CONTRACT_VERSION_V2;
    const cacheKey = `${key.baseCurrency.toUpperCase()}|${key.asOfDate}|${version}`;
    const cached = this.byKey.get(cacheKey);
    if (cached !== undefined) return cached;
    const found = await this.inner.find(key);
    this.byKey.set(cacheKey, found);
    return found;
  }

  async findById(id: string): Promise<FxSnapshotRef | null> {
    const cached = this.byId.get(id);
    if (cached !== undefined) return cached;
    const found = await this.inner.findById(id);
    this.byId.set(id, found);
    return found;
  }
}
