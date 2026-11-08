import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  DEFAULT_HOUSING_BRAND,
  HOUSING_BRANDS,
  HOUSING_BRAND_FETCH_SOURCE,
  HOUSING_BRAND_INFO,
  housingBrandConnectionSchema,
  housingBrandConnectRequestSchema,
  housingBrandSchema,
  housingBrandSyncErrorSchema,
  housingBrandSyncPreviewSchema,
  manualHousingPlanResponseSchema,
} from '../dist/index.mjs';

describe('housingBrandSyncErrorSchema', () => {
  it('accepts unit_not_registered for accounts without a registered unit', () => {
    assert.equal(housingBrandSyncErrorSchema.safeParse('unit_not_registered').success, true);
    assert.equal(housingBrandSyncErrorSchema.safeParse('unsupported_layout').success, true);
    assert.equal(housingBrandSyncErrorSchema.safeParse('unit_missing').success, false);
  });
});

// 합성 값만 쓴다. 브랜드 목록은 housing-brands.ts 한 곳이고, 두 계약 파일이 같은 목록을 써야 한다.
const OTHER_BRAND_STRINGS = ['Sujain', 'SUJAIN', ' sujain', 'sujain ', 'housing:sujain', 'synthetic_brand', '', 1, null, undefined];
const connection = (brand) => ({
  id: '11111111-1111-4111-8111-111111111111',
  planId: '22222222-2222-4222-8222-222222222222',
  brand,
  status: 'connected',
  statusMessage: null,
  credentialsStored: true,
  version: 1,
  lastFetchAt: null,
  lastSuccessAt: null,
  canManage: true,
});
const planResponse = (brand) => ({
  item: {
    id: '22222222-2222-4222-8222-222222222222',
    householdId: '33333333-3333-4333-8333-333333333333',
    ownerUserId: '44444444-4444-4444-8444-444444444444',
    version: 1,
    createdAt: '2026-11-08T00:00:00.000Z',
    updatedAt: '2026-11-08T00:00:00.000Z',
    canEdit: true,
    label: '합성 신축 주택',
    visibility: 'private',
    occupancyYear: null,
    contractStage: null,
    fundingNote: null,
  },
  payments: [],
  brandConnection: connection(brand),
});

describe('housing brands', () => {
  it('accepts sujain and rejects any other string', () => {
    assert.equal(housingBrandSchema.parse('sujain'), 'sujain');
    for (const value of OTHER_BRAND_STRINGS) {
      assert.equal(housingBrandSchema.safeParse(value).success, false, String(value));
    }
  });

  it('HOUSING_BRAND_INFO keys equal HOUSING_BRANDS', () => {
    assert.deepEqual(Object.keys(HOUSING_BRAND_INFO), [...HOUSING_BRANDS]);
    assert.ok(HOUSING_BRANDS.includes(DEFAULT_HOUSING_BRAND));
    for (const brand of HOUSING_BRANDS) {
      const info = HOUSING_BRAND_INFO[brand];
      assert.ok(info.label.trim().length > 0);
      assert.match(info.officialSite, /^https:\/\/[^/]+\/$/u);
      assert.ok(info.allowedHosts.includes(new URL(info.officialSite).host));
    }
  });

  it('keeps the permanent sujain values (AAD·fingerprint·DB 와 같은 id, 값 출처 토큰)', () => {
    assert.deepEqual([...HOUSING_BRANDS], ['sujain']);
    assert.equal(DEFAULT_HOUSING_BRAND, 'sujain');
    assert.equal(HOUSING_BRAND_FETCH_SOURCE, 'sujain_fetch');
    assert.equal(HOUSING_BRAND_INFO.sujain.label, '수자인');
  });

  it('connection, connect request and the plan response summary share the brand list', () => {
    assert.equal(housingBrandConnectionSchema.safeParse(connection('sujain')).success, true);
    assert.equal(manualHousingPlanResponseSchema.safeParse(planResponse('sujain')).success, true);
    const request = {
      householdId: '33333333-3333-4333-8333-333333333333',
      loginId: 'synthetic.user',
      password: 'x'.repeat(16),
      expectedPlanVersion: 1,
    };
    assert.equal(housingBrandConnectRequestSchema.safeParse({ ...request, brand: 'sujain' }).success, true);
    for (const value of OTHER_BRAND_STRINGS) {
      assert.equal(housingBrandConnectionSchema.safeParse(connection(value)).success, false, String(value));
      assert.equal(manualHousingPlanResponseSchema.safeParse(planResponse(value)).success, false, String(value));
      assert.equal(housingBrandConnectRequestSchema.safeParse({ ...request, brand: value }).success, false, String(value));
    }
  });

  it('preview source stays the legacy sujain_fetch token', () => {
    const preview = {
      fetchedAt: '2026-11-08T03:34:56.000Z',
      fetchedAtSeoul: '2026-11-08 12:34',
      source: 'sujain_fetch',
      items: [],
      unreadCount: 0,
      unreadReasons: [],
      connection: connection('sujain'),
    };
    assert.equal(housingBrandSyncPreviewSchema.safeParse(preview).success, true);
    assert.equal(housingBrandSyncPreviewSchema.safeParse({ ...preview, source: 'synthetic_fetch' }).success, false);
  });
});
