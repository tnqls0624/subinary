# 다음 기능 기획 — 데이터 통제권 (Control Center 2단계)

> 작성 2026-08-18. 선행 문서: `docs/product-roadmap.md` §3 C-3 · §5-1, `docs/adr/0028-versioned-consent-and-immediate-revocation.md`.
> 이 문서는 **기획**이다. 설계 결정이 확정되면 ADR로 옮기고, 여기에는 링크만 남긴다.

## 0. 한 줄

동의는 끝났다(ADR-0028). 남은 것은 **보관·회수·종료** — "이 서비스에서 내 데이터를 **줄이고**, **가져가고**, **끝낼 수** 있는가".

---

## 1. 왜 지금 이것인가

8주 로드맵(2026-08-08 기준)의 신규 콘셉트 C-1~C-8은 전부 처리됐고, 남은 진행 과제는 ADR-0027 금액 계약 전환 하나다. 다음 한 덩어리를 고르기 위해 후보 4건을 같은 자로 쟀다.

| 후보 | Reach × Impact × Confidence ÷ Effort | 전제조건 | 판정 |
|---|---|---|---|
| **A. 데이터 통제권** (보존정책·원문 분리·내보내기·그룹 종료) | 5 × 4 × 4 ÷ **3** = **26.7** | ADR-0028 버전된 동의 **배포됨**, tombstone 파이프라인 **존재** | ✅ **채택** |
| B. 장기 기억 승인 표면 + 타임라인 (C-6 잔여) | 2 × 3 × 3 ÷ 3 = 6.0 | 페이지네이션 완료(2026-08-09), Slack ZIP 개방(ADR-0032) | 보류 — Reach가 owner 1인 |
| C. P1 신뢰 부채 정리 (P1-13~22) | 4 × 3 × 5 ÷ 3 = 20.0 | 없음 | 병행 — 기능이 아니라 상시 부채 |
| D. 비밀번호 찾기 | 2 × 5 × 4 ÷ 3 = 13.3 | **메일 발송 인프라 0** | 보류 — 인프라부터가 본체 |

**A를 고른 세 가지 이유**

1. **PRD가 약속했는데 유일하게 "미구현"으로 남은 축이다.** 로드맵 §1-1 마지막 행: "원문 보존·삭제·내보내기 — 미구현 — 문자 원문 보관 기간을 통제하거나 이탈 시 가져갈 수 없다".
2. **로드맵이 명시한 재개 조건이 충족됐다.** §5-1은 C-3 본체의 재개 조건을 "S3의 버전된 동의 스키마가 배포된 직후, 다음 분기 첫 항목"으로 못 박았다. ADR-0028이 마이그레이션 `0051`로 배포됐다.
3. **공수 추정이 L에서 M으로 내려왔다** — 아래 §3-①. 로드맵이 L로 잡은 근거(삭제 파이프라인을 새로 만들어야 한다)가 사실이 아니다.

**A는 P1 부채도 함께 닫는다**: P1-8(원문 보존·삭제 정책 선택 불가)이 S1의 부산물로 해소된다.

---

## 2. 지금 있는 것 / 없는 것

| 조각 | 상태 | 근거 |
|---|---|---|
| 버전된 동의 + 즉시 철회(기기 해제) | ✅ 있음 | `apps/api/src/household/household-privacy.service.ts:76`,`:121` · 마이그레이션 `0051` |
| 보관 현황 읽기(건수·바이트·기간·경로) | ✅ 있음 | 같은 파일 `:220` · `packages/contracts/src/household.ts:296` |
| 원문 tombstone → 저장소·파생물 전파 엔진 | ✅ **있음** | `apps/worker/src/processors/source-tombstone.processor.ts` (591줄) · `apps/api/src/learning/learning-data-control.service.ts:50` |
| outbox → 큐 디스패치 | ✅ 있음 | `apps/worker/src/outbox/outbox-dispatcher.service.ts:198` |
| 주기 잡 패턴(`setInterval` + `OnApplication*`) | ✅ 있음 | `apps/worker/src/maintenance/device-nonce-cleanup.service.ts:103` |
| **보존기간 선택** | ❌ 없음 | `retentionPolicySchema = z.enum(['none'])` — `packages/contracts/src/household.ts:292` |
| **만료 자동 정리 잡** | ❌ 없음 | `household-privacy.service.ts:241` 주석: "purge 잡이 없으므로 정책은 'none' 하나뿐" |
| **사용자가 원문을 지우는 표면** | ❌ 없음 | tombstone 진입점은 `DELETE /v1/learning/sources/:id` 하나 — 운영 통제 경로다 (`learning-data-control.controller.ts:43`) |
| **데이터 내보내기** | ❌ 없음 | 저장소 전체 export 구현 0건 |
| **가족 그룹 삭제** | ❌ 없음 | `household.controller.ts`에 `@Delete(':id')` 없음 (멤버·초대 삭제만) |
| 비밀번호 찾기 | ❌ 없음 | `password-reset`/`forgot` 검색 결과 0건 |

현재 `/more/privacy` 화면은 **의도적으로** 삭제를 약속하지 않는다 — 화면 상단 주석이 그 이유를 남겨 뒀다("N일 뒤 삭제 같은 문장을 여기 쓰는 순간 서비스가 지키지 못할 약속을 하게 된다"). 이 기획은 **그 문장을 쓸 수 있게 만드는 작업**이다.

---

## 3. 이 기획을 결정짓는 발견 3가지

### ① 삭제 엔진은 이미 있고, 잘 만들어져 있다

`source-tombstone.processor.ts`는 원문 1건을 지울 때 **MinIO 객체 → 정규화 사본 → RAG chunk/embedding → 장기 기억 → 학습 데이터셋 → 평가 실행 → 모델 alias**까지 lineage를 따라 전파한다. `pg_advisory_xact_lock` + append-only tombstone revision + outbox 발행으로 재시도도 안전하다.

**즉 이 기획에서 새로 만들 것은 삭제 로직이 아니라 (a) 무엇을 언제 지울지 정하는 정책, (b) 그것을 실행하는 스케줄러, (c) 사용자 표면이다.** 로드맵의 L 추정은 여기서 내려간다.

### ② 그 엔진을 **그대로 쓰면 지난달 지출이 줄어든다** ★

```ts
// source-tombstone.processor.ts:207
await tx.update(schema.cardTransactions).set({
  merchantRaw: null, merchantNormalized: null,
  authorizationCode: null, memo: null,
  excludedAt: now,            // ← 지출 합계에서 빠진다
}).where(inArray(schema.cardTransactions.sourceEventId, cardEventIds));
```

학습 데이터 통제(운영자가 "이 원문은 애초에 받지 말았어야 했다"를 실행)에는 맞는 동작이다. 그러나 **보존기간 만료는 성격이 다르다** — 사용자는 "1년 지난 문자 원문을 이제 그만 보관해 달라"고 요청한 것이지 "작년 지출을 없던 일로 해 달라"고 한 게 아니다.

기존 경로를 재사용하면 ADR-0026(단일 지출 집계)·ADR-0027(단일 금액 계약)이 지키는 불변식이 **정책 만료라는 자동 트리거로** 깨진다. 사용자가 보는 증상은 "어느 날 갑자기 작년 총지출이 줄었다"이고, 원인 추적은 극도로 어렵다.

> **결정 D1의 근거**: 보존기간 만료는 **삭제(tombstone)가 아니라 원문 분리(detach)** 다. 별개의 이벤트 타입·별개의 처리 경로로 만든다.

### ③ 원문은 4벌로 존재하고, 그중 하나는 **일부러 살아남게 설계돼 있다**

| # | 사본 | 위치 | 기존 tombstone이 처리하나 |
|---|---|---|---|
| 1 | MinIO 객체 | `card-sms/{householdId}/{eventId}.txt` | ✅ 삭제 |
| 2 | 불변 revision 메타 | `source_revisions` | ✅ tombstone revision 추가 |
| 3 | 편의 사본 | `card_sms_events.raw_content` (`schema.ts:695`) | ✅ 빈 문자열로 scrub |
| 4 | **버려진 시도의 원문** | `card_sms_ingest_suppressions.raw_content` (`schema.ts:799`) | ❌ **전혀 만지지 않는다** (프로세서 전체에 `suppression` 참조 0건) |

4번은 P0-9(동일 본문 중복 제거, 마이그레이션 `0050`)의 산물이고, **누락이 아니라 명시적 결정이다.** 스키마 주석이 그대로 말한다:

> *"**FK를 걸지 않는다** — 이벤트가 지워져도 버려진 원문은 남아야 한다(NO ACTION이면 삭제가 막히고 CASCADE면 보관이 함께 지워진다). 감사 기록이 감사 대상보다 오래 살아야 한다."* (`schema.ts:791-796`)

그 판단은 P0-9 맥락에서 옳다 — "내 결제가 조용히 버려졌다"를 사용자가 증명할 근거가 필요했다. 하지만 **보존정책을 도입하는 순간 두 원칙이 정면으로 부딪힌다**: 감사 기록은 오래 살아야 하고, 개인정보는 최소로 보관해야 한다. 같은 행이 둘 다다.

> **결정 D9의 근거**: `card_sms_ingest_suppressions`는 **감사 메타(해시·횟수·사유·키 출처·시각)와 원문을 분리한다.** 메타는 영구 보존, `raw_content`는 보존정책의 적용 대상 — 단, 사용자가 "버려진 그 결제가 뭐였는지" 확인할 창이 필요하므로 **가구 정책보다 짧은 자체 기한(90일)** 을 둔다. 즉 이 테이블만 정책 상한이 아니라 하한을 갖는다.

## 4. 설계 결정

| # | 결정 | 이유 |
|---|---|---|
| **D1** | 보존 만료는 `source.detached.v1`(신규 이벤트)로 처리한다. **원문·발신번호·마스킹 카드번호만** 제거하고 `card_transactions`는 **손대지 않는다**(`excludedAt` 금지, 가맹점 표시명 유지) | §3-② — 금액 불변식은 어떤 자동 잡도 깰 수 없어야 한다 |
| **D2** | 보존정책은 **가구 단위**, 변경은 **owner만**. 값은 `none \| 1y \| 6m \| 3m`. **단축은 다음 주기부터 적용**(즉시 소급 삭제 아님), 연장은 이미 분리된 원문을 **되살리지 못한다**고 화면에 명시 | 가족 공용 데이터라 개인별 정책은 같은 문자 1건에 두 정책이 걸린다. 즉시 소급 삭제는 오조작의 피해가 복구 불가 |
| **D3** | 사용자 삭제 표면은 **거래 상세의 "이 문자 원문 지우기"** 단건과 **정책 만료** 두 가지뿐. 대량 즉시 삭제 버튼은 만들지 않는다 | 되돌릴 수 없는 대량 액션은 유예 없이 노출하지 않는다 |
| **D4** | 내보내기는 **비동기 아티팩트 + 만료(72h) + 재인증(비밀번호 재확인)**. 산출물은 **요청자 관점의 공개범위 마스킹을 그대로 상속**한다 | P0-6 재발 방지 — `@family/database`의 `visibilityScope`/`redactedMerchantLabel` 공용 헬퍼를 그대로 통과시킨다 |
| **D5** | 내보내기 산출물 자체가 **새 보관물**이므로 만료 시 자동 삭제하고, 보관 현황(`retention`)에 **별도 줄로 집계**한다 | 삭제하려고 만든 기능이 조용히 사본을 늘리면 안 된다 |
| **D6** | 가족 그룹 종료는 **30일 유예 soft-delete → hard purge**. 유예 중에는 전 구성원에게 통지되고 **각자 내보내기 기회**를 갖는다. owner 단독 즉시 삭제는 없다 | 가구 삭제는 **다른 구성원의 개인 기록**까지 지운다. owner의 권한이지만 통지 없는 권한은 아니다 |
| **D7** | 동의 이력·삭제 이력·내보내기 이력은 **append-only이며 삭제 대상이 아니다**. 이력에는 원문이 아니라 **무엇이 몇 건 사라졌는가**만 남는다 | 감사 가능성과 최소 수집의 균형 |
| **D8** | 실행 전 **영향 미리보기** 필수 — "이 정책을 켜면 지금 기준 N건 / M MB / YYYY-MM 이전 원문이 분리됩니다" | 되돌릴 수 없는 액션의 최소 예의 |
| **D9** | `card_sms_ingest_suppressions`는 감사 메타와 원문을 분리한다. 메타 영구 보존, `raw_content`는 **90일 자체 기한** + 가구 정책 중 짧은 쪽 | §3-③ — 감사 보존과 개인정보 최소화가 같은 행에서 충돌한다 |

---

## 5. 범위 — 4 슬라이스

의존 순서는 S1 → (S2 ∥ S3) → S4. **S4는 S3 없이 내면 안 된다** — 가져갈 수 없는데 끝낼 수만 있는 상태가 된다.

### S1. 보존정책 + 원문 분리 (M) — 이 기획의 본체

- `card_sms_ingest_suppressions.raw_content` 분리 — 감사 메타 유지, 원문만 기한 적용 (D9)
- `retentionPolicy` 열거형 확장 + 가구 설정 저장
- `source.detached.v1` 이벤트 타입 + 워커 프로세서(신규, tombstone과 **별개 파일**)
- 만료 스캐너: `setInterval` 주기 잡(기존 `device-nonce-cleanup` 패턴), 배치 상한 + `FOR UPDATE SKIP LOCKED`
- **DoD**: ① 정책 `1y` 설정 후 잡 1회 실행 → 1년 초과 원문의 4벌 전부 비고, ② **같은 기간의 지출 합계·건수가 실행 전후 완전히 동일**(ADR-0026 기준값 스크립트 재사용), ③ 잡 2회 실행이 1회와 같은 결과(멱등)

### S2. 삭제 이력 + 영향 미리보기 (S)

- `GET .../privacy/retention/preview` — 정책별 영향 건수/바이트/최고(最古) 시각
- `GET .../privacy/history` — 분리·삭제·내보내기 이력 통합 타임라인
- `/more/privacy` 화면에 "보관" 섹션 신설 + 상단 경고 주석 갱신
- 거래 상세 "이 문자 원문 지우기"(단건, 확인 다이얼로그)
- **DoD**: 미리보기 숫자와 실제 실행 결과가 ±0건 일치

### S3. 데이터 내보내기 (M)

- `data_export_jobs` 테이블 + 워커 프로세서 + MinIO 산출물(ZIP: `transactions.csv`, `budgets.csv`, `card_sms.jsonl`, `consents.json`, `manifest.json`)
- 재인증 → 생성 → 만료 링크 → 72h 후 자동 삭제
- **마스킹 상속**: 요청자가 owner여도 타인의 `private` 거래는 마스킹된 형태로만
- **DoD**: ① member 계정 export에 타인 private 가맹점명 0건(자동 검사), ② 만료 후 링크 404 + 객체 부재, ③ ZIP 압축률·크기 상한(Slack ZIP 방어 로직 ADR-0032 재사용)

### S4. 가족 그룹 종료 (M)

- `household_deletion_requests`(요청자·사유·유예 종료 시각·취소 이력)
- 요청 → 전 구성원 알림(기존 알림함/푸시 재사용) → 30일 유예 → hard purge 잡
- 유예 중 취소 가능, 유예 중 신규 수집은 즉시 중단(기존 동의 철회 초크포인트 재사용)
- **DoD**: ① 요청 즉시 전 구성원 알림 도달, ② 유예 중 취소 시 데이터 무손실 복귀, ③ purge 후 해당 `householdId`로 조회되는 행 0(테이블별 자동 검사)

---

## 6. 데이터 모델 (초안)

```
households                       + retention_policy text not null default 'none'
                                 + retention_updated_at timestamptz
                                 + retention_updated_by uuid

household_data_events            -- D7 이력 (append-only)
  id, household_id, kind('retention_changed'|'source_detached'|'export_created'|'deletion_requested'|...)
  actor_user_id (nullable = 시스템), affected_count, affected_bytes, cutoff_at, payload jsonb, created_at

data_export_jobs
  id, household_id, requested_by, status('queued'|'processing'|'ready'|'expired'|'failed')
  object_key, size_bytes, expires_at, error_code, created_at, completed_at

household_deletion_requests
  id, household_id, requested_by, reason, grace_ends_at
  status('pending'|'cancelled'|'purged'), cancelled_by, cancelled_at, purged_at
```

> ⚠️ 마이그레이션 번호는 **문서에 박지 않는다**(로드맵 교훈). 현재 최신은 `0054`이지만 병렬 작업이 먼저 가져갈 수 있다.

---

## 7. API 계약 (초안)

| 메서드 | 경로 | 권한 | 비고 |
|---|---|---|---|
| `PATCH` | `/v1/households/:id/privacy/retention` | owner | D2 |
| `GET` | `/v1/households/:id/privacy/retention/preview?policy=` | 구성원 | D8 |
| `GET` | `/v1/households/:id/privacy/history` | 구성원 | 커서 페이지네이션 **필수** |
| `DELETE` | `/v1/card-sms-events/:id/raw` | 소유자 or admin+ | 단건 원문 분리 |
| `POST` | `/v1/households/:id/exports` | 구성원(본인 관점) | 재인증 헤더 필요 |
| `GET` | `/v1/households/:id/exports` · `/:exportId` | 요청자 본인 | 다운로드는 presigned |
| `POST` | `/v1/households/:id/deletion-request` · `/cancel` | owner | D6 |

기존 `privacyOverviewSchema.retention`에 `exportBytes`·`detachedCount`를 **추가형으로** 확장한다(웹 배포가 늦어도 안 깨지도록).

---

## 8. 화면

- `/more/privacy` — 기존 2섹션(동의·보관 현황) 아래 **"보관 정책"**(정책 선택 + 미리보기) · **"기록"**(이력 타임라인) · **"내 데이터 가져가기"** 추가
- `/more/privacy/export` — 생성·진행·만료 카운트다운 (Slack import 상태 UI 패턴 재사용)
- `/household` — owner에게만 하단 "가족 그룹 종료" (파괴적 액션 확인 패턴 통일, P3 부채와 함께)
- 거래 상세 — "이 문자 원문 지우기" (거래는 남는다는 문장을 **다이얼로그 본문에** 명시)

---

## 9. 리스크와 이 저장소의 함정

| 리스크 | 대응 |
|---|---|
| **분리 잡이 금액을 바꾼다** (§3-②) | D1 + S1 DoD② + `scripts/snapshot-money-baseline.mjs` 전후 비교를 CI가 아니라 **잡 자체의 자가검증**으로 |
| ADR-0027 전환과 **같은 테이블을 만진다** | 금액 계약 전환(5단계 진행 중)이 끝난 뒤 S1을 시작한다. 둘 다 `card_transactions`를 쓴다 |
| 4번째 사본이 정책을 우회한다 (§3-③) | D9를 S1 범위에 고정. **P0-9의 감사 목적을 깨지 않는지** 리뷰 필수 — 원문 없이도 "무엇이 버려졌는가"를 답할 수 있어야 한다 |
| 내보내기가 공개범위를 뚫는다 | D4 — 공용 헬퍼 통과 강제 + member 계정 자동 검사 |
| 압축 폭탄/경로 탈출(생성 측) | ADR-0032의 두 겹 방어 로직 재사용 |
| **`Dockerfile.prod` 워크스페이스 누락** | 새 패키지를 만들면 반드시 명시 COPY 추가 — `scripts/lib/dockerfile-workspaces.test.mjs`가 잡지만 확인 습관 |
| 자동커밋 훅 `index.lock` 경합 | 커밋은 모든 워커가 멈춘 뒤에만 |

---

## 10. 검증

- **금액 무회귀**: 각 슬라이스 배포 전후 `scripts/snapshot-money-baseline.mjs` 실행, delta 0 확인
- **원문 소거 전수**: `householdId` 기준으로 4벌 사본을 각각 조회하는 검사 스크립트(신규, 읽기 전용)
- **공개범위**: member/admin/owner 3개 계정으로 export 3벌 생성 → 타인 `private` 문자열 0건
- **멱등**: 모든 잡을 2회 실행해 1회와 동일 결과
- **런타임**: `scripts/verify-*.mjs` 관례를 따라 슬라이스별 스크립트 1개

---

## 11. 하지 않는 것

| 항목 | 이유 |
|---|---|
| 개인별(구성원별) 보존정책 | 같은 문자 1건에 두 정책이 걸린다. 가구 단위로 시작하고, 요구가 실제로 나오면 그때 |
| 즉시 소급 대량 삭제 | 오조작 피해가 복구 불가. 정책 단축은 다음 주기부터 |
| 법정 보관 의무 대응·약관 개정 | 관할 검토가 선행돼야 한다. 이 기획은 **사용자가 요청한 축소**만 다룬다 |
| 계정 자체 삭제(탈퇴) | 가구 종료와 다른 문제(다중 가구 소속). D6이 안정된 뒤 별도 |
| 내보내기 포맷 확장(PDF·엑셀) | CSV/JSONL로 시작. 포맷은 수요 확인 후 |
