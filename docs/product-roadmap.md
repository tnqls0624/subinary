# 제품 로드맵 — 2026-08 진단 기준 8주 계획

> 2026-08-08에 5개 역할(PO · 프로덕트 디자인 · 프론트엔드/모바일 · 백엔드/아키텍처 · 데이터)이
> 동시에 수행한 진단 결과를 하나의 실행 계획으로 합친 문서다.
>
> 진단 리포트 원본은 저장소 밖 작업 산출물이라 사라진다. **판단에 필요한 근거(`파일:라인`)와 수치는
> 전부 이 문서 안으로 옮겨 담았다.** 6개월 뒤에 이 문서만 열어도 "왜 이 순서였는지"가 복원되어야 한다.
>
> 상태 판정 기준은 "코드가 있는가"가 아니라 **"사용자가 약속된 가치를 끝까지 얻는가"**다.
> 모든 진단은 정적(코드·문서 정독)이며, 운영 데이터로 확인하지 못한 추정은 `[가설]`로 표시한다.
> 기준 문서: [`PRD.md`](../PRD.md), `docs/phase0~10-build-spec.md`, [`docs/adr/`](./adr/).

## 이 문서를 읽는 법

| 장 | 무엇이 있나 | 언제 보나 |
|---|---|---|
| 1 | PRD/Phase 약속 대비 현재 위치 — 특히 **드리프트** | "이 기능 되는 거 아니었나?" 싶을 때 |
| 2 | 확정된 P0 11건 / 주요 P1 22건 + **처리 상태** | 지금 무엇이 고쳐지는 중인지 확인할 때 |
| 3 | 신규 제품 콘셉트 8건 (RICE 계산식 포함) | 다음에 뭘 만들지 정할 때 |
| 4 | 8주 로드맵 — P0를 끼워 넣어 재배치 | 스프린트를 계획할 때 |
| 5 | **지금 하지 않기로 한 것**과 그 이유 | "왜 이건 안 했지?" 라는 질문이 나올 때 |
| 6 | 리포트 간 관점 차이 · 열린 질문 | 같은 화면을 두고 판단이 갈릴 때 |

**8주 한 장 요약**

| 스프린트 | 한 문장 목표 | 핵심 |
|---|---|---|
| S1 (1~2주) | 경계를 넘는 것부터 막는다 | P0 경계 위반 4건 + 프론트 신뢰 묶음 |
| S2 (3~4주) | 화면의 금액을 믿을 수 있게 만든다 | P0 금액 오계산 6건 (취소·환율·파서·멱등) |
| S3 (5~6주) | 새 구성원이 앱 안내만으로 첫 거래를 만든다 | 수집 마법사 → 합류 여정 → 온보딩 체크리스트 |
| S4 (7~8주) | 숫자 다음의 행동을 만든다 | 예산 원장 · 딥링크 · 정기 지출 후보 · 알림 outbox |

---

## 1. 현재 위치

### 1-1. 기능별 약속 대비 구현 상태

판정: **완전**(사용자가 가치를 끝까지 얻음) / **부분**(일부 경로만) / **미구현** / **드리프트**(구현됐으나 기획 의도와 다르게 동작).

| 기능 | PRD/Phase 약속 | 상태 | 근거 | 갭이 사용자에게 남기는 것 |
|---|---|---|---|---|
| 회원가입·로그인·비밀번호 변경 | 기본 인증 + 초대 수락까지 한 흐름 | **드리프트** | `apps/web/src/app/join/page.tsx:109`, `apps/web/src/app/(auth)/login/page.tsx:83` | 초대받은 기존 사용자가 로그인하면 초대 문맥이 사라져 링크를 다시 찾아야 한다 |
| 가족 그룹·초대·역할·구성원 관리 | 생성·초대·권한 변경·제거·동의 상태 확인 | **부분** | `apps/api/src/household/household.controller.ts:47`, `apps/web/src/app/(app)/household/page.tsx:301` | 누가 무엇에 동의했는지 볼 수 없고, 수집 동의를 철회할 수 없다 |
| 탈퇴·동의 철회 후 수집 중단 | 장치 인증 즉시 비활성화, 신규 수집 중지 | **드리프트** | `apps/api/src/household/household.service.ts:293`, `apps/api/src/devices/device-token.guard.ts:59`, `apps/api/src/devices/device-hmac.guard.ts:83`, `PRD.md:1772` | 탈퇴 후에도 자동화가 원문 문자를 가족 공간에 계속 보낼 수 있다 (P0) |
| 스마트폰 등록·문자 수집 온보딩 | 신규 구성원이 10분 안에 장치 연결·자동 수집 | **부분** | `apps/web/src/app/(app)/devices/page.tsx:481`, `apps/api/src/card-sms/card-sms.controller.ts:97` | 토큰을 복사한 뒤 어디에 무엇을 넣을지 앱이 알려주지 않아 활성화가 막힌다 |
| 장치 수집 상태·복구 | 인증 성공 / 첫 수신 / 마지막 수신 구분 | **드리프트** | `packages/database/src/schema.ts:403`, `packages/contracts/src/device.ts:22`, `apps/web/src/app/(app)/devices/page.tsx:269` | 연결 테스트만 성공해도 문자가 들어온 것처럼 보여 설정 실패를 오진한다 |
| 카드 문자 파싱·사람 검토 | 승인·취소 파싱, 실패 검토, 미지 형식은 사람 검토 | **부분**<sup>†</sup> | `docs/adr/0023-card-sms-ai-parsing-cascade.md:3`, `apps/api/src/card-sms/card-sms-review.service.ts:216`, `apps/web/src/app/(app)/dashboard/page.tsx:107` | 캐스케이드는 완성됐으나 사람이 확정한 취소가 상계되지 않고(P0), 실패 문자는 3일 뒤 화면에서 사라진다(P1) |
| 카드·거래·취소·카테고리·공개범위 | 별칭, 승인/취소 연결, 부분 취소, 가시성 | **완전** | `apps/api/src/app.module.ts:54`, `apps/web/src/app/(app)/layout.tsx:52` | 일상 조회·정리 핵심은 사용 가능 |
| 월별 대시보드·검색·통계 | 총지출, 전월 대비, 분해, 월 이동 | **완전** | `apps/web/src/app/(app)/dashboard/page.tsx:523`, `docs/adr/0026-single-spend-aggregation-contract.md:136` | 월별 지출과 원인을 같은 화면에서 점검 가능 |
| 월 예산·임계 알림 | 범위별 월 예산, 80·100% 알림, 과거월 기록 | **드리프트** | `packages/database/src/schema.ts:1139`, `apps/api/src/budgets/budget.service.ts:101`, `docs/adr/0026-single-spend-aggregation-contract.md:144` | 과거 달을 회고하면 당시 계획이 아니라 오늘 수정된 값이 보인다 |
| 결제 실패(declined) | 실패는 지출에서 제외하되 사유·반복·해결 가시화 | **완전** | `docs/adr/0024-declined-payment-visibility.md:40`, `apps/web/src/app/(app)/more/page.tsx:73` | 유령 지출 없이 반복 실패와 조치를 확인 가능 |
| 정기 결제 후보 | 대시보드에 동일 가맹점 반복 최소 표시 | **미구현** | `PRD.md:1099`, `docs/phase5-build-spec.md:17`, `apps/web/src/app/(app)/dashboard/page.tsx:523` | 조용히 빠져나가는 구독과 갱신 비용을 미리 못 본다 |
| 푸시·인앱 알림 | 거래·예산·리마인더·주간 요약 + 선호 설정 | **드리프트** | `packages/contracts/src/notification.ts:70`, `packages/shared/src/notifications.ts:11`, `apps/web/src/app/(app)/notifications/page.tsx:30` | 발송 kind 5종 vs 계약 4종 불일치로 알림함이 크래시했다 (P0, 수정 완료) |
| 모바일 앱 | 네이티브 셸, 안전한 토큰, 푸시, 생체인식, 딥링크 | **부분** | `apps/mobile/README.md:3`, `apps/mobile/android/app/src/main/AndroidManifest.xml:71` | 금융 UI 채널로는 동작하나 설치만으로 문자 수집이 시작되지는 않는다 |
| Slack Export 수집·검색 | 업로드, 정규화, 스레드 복원, 검색 | **부분** | `apps/api/src/slack/slack.controller.ts:69`, `apps/web/src/app/(app)/more/page.tsx:47` | 일반 사용자는 API 도구 없이 업무 기록을 가져올 수 없다 |
| Hybrid RAG 업무 질의 | 근거 검색, 출처 100%, 근거 없으면 거부 | **부분** | `apps/api/src/ai/ai-query.controller.ts:36`, `apps/web/src/app/(app)/ai/page.tsx:63` | 이미 만든 업무 질의를 제품에서 발견할 수 없다 |
| 장기 기억 | 후보 검토·승인·수정·삭제·원문 연결 | **부분** | `apps/api/src/memory/memory.controller.ts:87` | 후보가 쌓여도 승인할 표면이 없다 |
| Temporal GraphRAG | Entity/Relationship, 시점 조회, Timeline | **부분** | `apps/api/src/graph/graph.controller.ts:93`, `docs/phase9-build-spec.md:17` | API 사용자만 조회 가능 |
| MCP | memory 5종 + finance summary | **완전** | `apps/mcp/README.md:87` | 개발 도구 사용자에게는 실사용 경로가 있다 |
| 원문 보존·삭제·내보내기 | 선택형 보존 정책, 삭제, owner 내보내기 | **미구현** | `PRD.md:788`, `docs/phase3-build-spec.md:21`, `apps/api/src/household/household.controller.ts:47` | 문자 원문 보관 기간을 통제하거나 이탈 시 가져갈 수 없다 |

<sup>†</sup> PO 진단은 이 항목을 **완전**으로 판정했으나, 데이터·디자인 진단에서 사람 검토 취소 미상계(P0)와 3일 창 소멸(P1)이 확인되어 **부분**으로 내렸다. 판정이 갈린 이유는 [6장 관점 차이](#6-리포트-간-관점-차이와-열린-질문) 참조.

### 1-2. 드리프트 — 가장 먼저 봐야 할 것

"미구현"은 사용자가 없다는 걸 안다. **드리프트는 사용자가 있다고 믿는데 다르게 동작한다.** 그래서 신뢰를 더 크게 깎는다.

| # | 기획 의도 | 실제 동작 | 어디서 갈라졌나 | 사용자가 겪는 것 |
|---|---|---|---|---|
| D-1 | 동의 철회·탈퇴 시 수집 즉시 중단 | 멤버십만 `removed`가 되고 장치는 `active` 유지, 가드는 멤버십을 재검증하지 않음 | `apps/api/src/household/household.service.ts:293` · `apps/api/src/devices/device-token.guard.ts:59` | 떠난 뒤에도 내 카드 문자가 그 가족 공간에 쌓인다 |
| D-2 | 장치 화면의 "마지막 수신" = 마지막 문자 | `lastSeenAt`은 `ping-token`·HMAC **인증 성공** 시각. 서버는 `firstEventAt`/`lastEventAt`을 구분하지만 계약이 내보내지 않음 | `packages/database/src/schema.ts:403` · `packages/contracts/src/device.ts:22` · `apps/web/src/app/(app)/devices/page.tsx:269` | 자동화가 죽었는데 정상으로 보인다 |
| D-3 | 과거월 예산은 읽기 전용 기록 | 모든 월이 **같은 예산 행 하나**를 참조. 현재월 수정·삭제가 과거월 달성률까지 바꿈 | `packages/database/src/schema.ts:1146` · `apps/api/src/budgets/budget.service.ts:106` · `docs/adr/0026-single-spend-aggregation-contract.md:144` | 지난달 회고의 기준선이 오늘 바뀐다 |
| D-4 | 초대 → 합류가 한 흐름 | 회원가입은 invite를 보존하지만 **로그인은 무조건 `/dashboard`** | `apps/web/src/app/join/page.tsx:97` · `apps/web/src/app/(auth)/login/page.tsx:83` | 기존 계정 사용자가 초대 링크를 다시 찾아야 한다 |
| D-5 | 외화는 KRW로 환산해 저장 | 자동 승격만 환산. 수동 입력·사람 검토는 minor unit을 그대로 넣고 `originalAmount`/`exchangeRate`를 비움 | `apps/api/src/card-sms/manual-entry.service.ts:223` · `apps/api/src/card-sms/card-sms-review.service.ts:229` · `apps/api/src/analytics/analytics.service.ts:495` | 같은 거래가 대시보드에선 0원, 가맹점 화면에선 잘못된 원화로 보인다 |
| D-6 | 알림 kind 계약은 shared와 일치 (`packages/contracts/src/notification.ts:70` 주석) | 계약 4종 vs 실제 발송 5종(`decline`). DB는 자유 text, API는 검증 없는 캐스트 | `packages/contracts/src/notification.ts:71` · `packages/shared/src/notifications.ts:11` · `apps/api/src/notifications/notification.service.ts:234` | 거절 알림을 한 번 받은 사용자는 알림함 전체가 흰 화면 |
| D-7 | 파싱 실패 문자는 사람이 검토 | 홈 카드가 `receivedAt` 3일 이내만 표시하고, `card-sms-events` 목록의 다른 진입점이 없음 | `apps/web/src/app/(app)/dashboard/page.tsx:107` · `:328-343` | 3일을 놓치면 그 결제 금액은 합계에서 빠진 채 다시 볼 수 없다 |

---

## 2. 지금 서비스가 겪는 문제

### 2-1. P0 — 11건

집계: 프론트 1 · 백엔드 3 · 데이터 6 · PO 1 = **11건**. 디자인 진단의 P0 1건(알림함 크래시)은 프론트 P0와 같은 건이라 하나로 합쳤다.

상태 표기: **✅ 수정 완료(미커밋)** / **🔧 진행 중** / **📝 ADR 초안 작성 중** / **⬜ 미착수**

| # | 문제 | 유형 | 근거 | 공수 | 상태 |
|---|---|---|---|---|---|
| P0-1 | 알림함이 `kind:'decline'` 한 건으로 크래시하고, 잡아줄 error 바운더리가 없다 | 크래시 | `apps/web/src/app/(app)/notifications/page.tsx:30`,`:59` · `packages/contracts/src/notification.ts:71` · `packages/shared/src/notifications.ts:11` · `apps/worker/src/processors/notification-dispatch.processor.ts:328` | S | ✅ 계약에 `decline` 추가 + `kindMeta()` 폴백 + `(app)/error.tsx` 신설 |
| P0-2 | 탈퇴·제거 후에도 장치 수집 자격이 살아 있다 | 개인정보 경계 | `apps/api/src/household/household.service.ts:293`,`:331` · `apps/api/src/devices/device-token.guard.ts:59` · `apps/api/src/devices/device-hmac.guard.ts:83` | M | ✅ removeMember 트랜잭션 내 장치·자격 revoke + 두 가드에 `household_members.status='active'` 조인 (2겹) + 마이그레이션 `0047` |
| P0-3 | 이메일 미지정 초대 토큰을 두 사용자가 동시에 수락할 수 있다 | 계정 경계 | `apps/api/src/household/household.service.ts:464-484`,`:505-524`,`:538-561` · `packages/database/src/schema.ts:153-185` | M | ✅ 수락 전 과정을 한 트랜잭션으로 옮기고 초대 행 `FOR UPDATE` — 에러 의미론·멱등성·재활성화 경로 보존 |
| P0-4 | 동시 취소 연결이 승인 거래의 취소 누적액을 유실한다 | 금액 오계산 | `apps/api/src/transactions/transaction.service.ts:881-927` · `apps/worker/src/promotion/transaction-promotion.service.ts:548-594` | M | ✅ 3경로(수동 link·자동 승격·삭제 역산) 전부 승인 행 잠금 후 재계산. 잠금 순서 승인→취소 전역 고정(데드락 방지). **금액 계산 규칙 무변경** |
| P0-5→P1 | Graph 관계 교체가 다른 workspace 엔티티를 받아 이름을 노출한다 (등급 조정 근거는 아래 각주) | 테넌트 경계 | `apps/api/src/graph/graph.service.ts:431-460`,`:606-627` · `packages/database/src/schema.ts:2015-2027` | M | ✅ supersede 시 source/target의 workspace 일치 검증 |
| P0-6 | 가맹점 정리 API가 타인의 private·summary_only 가맹점명과 금액을 공개한다 | 공개범위 | `apps/api/src/merchants/merchant.service.ts:41`,`:47`,`:55` · `apps/web/src/app/(app)/more/merchants/page.tsx:176` | M | ✅ `visibilityScope`/`redactedMerchantLabel`을 `@family/database` 공용 헬퍼로 추출 — 누락된 merchants를 고치면서 이미 4벌로 복붙돼 있던 사본(analytics·budgets·transactions·finance-ai)도 한 정의로 통합 |
| P0-7 | 사람 검토로 확정한 취소가 승인 거래를 상계하지 않는다 | 금액 오계산 | `apps/api/src/card-sms/card-sms-review.service.ts:216`,`:228`,`:244` · `apps/worker/src/promotion/transaction-promotion.service.ts:462` | L | 📝 검토취소 상계 ADR 초안 |
| P0-8 | 외화 승인과 취소를 서로 다른 당일 환율로 환산해 전액취소도 잔액이 남는다 | 금액 오계산 | `apps/worker/src/promotion/transaction-promotion.service.ts:301`,`:316`,`:554` · `apps/worker/src/promotion/fx-rate.service.ts:54`,`:62` | L | 📝 환율 ADR 초안 |
| P0-9 | 선택적 `eventId`+`receivedAt` 조합이 서로 다른 동일 본문 결제를 영구 중복 처리한다 | 데이터 유실 | `packages/contracts/src/card-sms.ts:45` · `apps/api/src/card-sms/card-sms-ingest.service.ts:30`,`:78`,`:91` | M | ⬜ |
| P0-10 | 범용 파서가 거래 액션과 무관한 첫 금액을 승인액으로 승격한다 | 금액 오계산 | `packages/card-parsers/src/parsers/generic.parser.ts:26`,`:36`,`:104` · `packages/card-parsers/src/parsers/base.parser.ts:127` | M | 📝 파서 앵커링 ADR 초안 |
| P0-11 | 수동·검토 외화가 KRW 환산 계약을 우회해 화면별 금액이 사라지거나 원화로 오표시된다 | 금액 오계산 | `apps/api/src/card-sms/manual-entry.service.ts:223`,`:232` · `apps/api/src/analytics/analytics.service.ts:495` · `packages/contracts/src/merchant.ts:17` | L | 📝 외화 통합 ADR 초안 |

> **P0-5 등급 조정 (P0 → P1)**: 백엔드 진단은 P0로 매겼고 경계 위반 자체는 사실이다. 다만 공격에
> 피해 workspace의 entity UUID가 필요하고, Graph·Memory는 아직 일반 사용자 제품 동선에 연결돼
> 있지 않아(1-1 표 참조) 실노출면이 사실상 없다. 수정 비용이 낮아 같은 라운드에 함께 처리했지만,
> 우선순위 판단에는 P1로 반영한다. **다른 10건은 등급 그대로다.**
>
> **P0-9(동일 본문 문자 중복 제거)는 아직 미착수다.** Sprint 2에 배치돼 있고, Sprint 3의 수집
> 마법사(C-2)가 이 계약에 의존한다 — 마법사가 사용자에게 인쇄해 주는 요청 템플릿에 멱등 키가
> 들어가야 하므로, 계약을 확정하기 전에 템플릿을 배포하면 사용자가 설치한 자동화를 나중에 전부
> 다시 만들게 한다. 순서가 뒤집히면 안 되는 의존이다(4-1 표 참조).

**P0 재현 시나리오(테스트로 옮길 것)**

| # | 입력 | 기대 | 현재 |
|---|---|---|---|
| P0-4 | 잔액 충분한 승인 1건에 취소 2건 동시 연결 | 두 취소 모두 `cancelledAmount`에 누적 | 마지막 update가 앞선 누적을 덮어씀 |
| P0-7 | 승인 10,000원 + 부분취소 3,000원을 사람이 검토 확정 | 순액 7,000원 | 취소 행은 0원, 승인 순액 10,000원 유지 |
| P0-8 | USD 100 승인(1,300원) → 전액취소(1,400원) | 잔액 0원 | `130,000 >= 140,000` 실패 → 130,000원이 지출로 남음 |
| P0-9 | 타임스탬프 없는 동일 본문 문자 2건(별개 결제) | 이벤트 2건 | 두 번째가 `duplicate:true`, 원문도 안 남음 |
| P0-10 | `삼성카드 8/10 온라인 결제 시 5,000원 할인` | 비승격 | 5,000원 승인으로 해석 |
| P0-10 | `삼성카드 이용한도 1,000,000원 / 승인 10,000원` | 10,000원 | 1,000,000원을 승인액으로 선택 |
| P0-11 | 수동 입력 USD 10.00 (`amount=1000,currency=USD`) | 모든 화면에서 동일한 환산 금액 | 대시보드 0원 기여 / 가맹점 화면 1,000원 |

### 2-2. 주요 P1

| # | 문제 | 출처 | 근거 | 공수 | 상태 |
|---|---|---|---|---|---|
| P1-1 | App Router error 바운더리가 전무해 렌더 예외 하나가 앱 전체를 무너뜨린다 | 프론트 | `apps/web/src/app/**` 에 `error.tsx`/`global-error.tsx` 0건 | S | ✅ `(app)/error.tsx` 신설 |
| P1-2 | 로그아웃 시 React Query 캐시를 비우지 않아 다음 사용자에게 이전 사용자의 알림이 보인다 | 프론트 | `apps/web/src/lib/auth-context.tsx:118-123` · `apps/web/src/lib/queries.ts:441`,`:456`,`:420` | S | 🔧 진행 중 |
| P1-3 | 부트스트랩 중 네트워크 오류를 "미인증"으로 처리해 조용히 강제 로그아웃된다 | 프론트 | `apps/web/src/lib/auth-context.tsx:288-291` · `apps/web/src/app/(app)/layout.tsx:222` | M | 🔧 진행 중 |
| P1-4 | 서버 영문 에러가 그대로 노출된다 (`invalid credentials` 등) | 디자인 | `apps/api/src/auth/auth.service.ts:178` → `apps/web/src/lib/api-client.ts:117-128` → `apps/web/src/app/(auth)/login/page.tsx:103` | S | 🔧 진행 중 (에러 한국어화) |
| P1-5 | `/categories` 조회 실패 시 "카테고리 없음"이라는 거짓 정보를 보여준다 | 프론트 | `apps/web/src/app/(app)/categories/page.tsx:409-417` (`isError` 분기 없음) | S | 🔧 진행 중 |
| P1-6 | 파싱 실패 문자가 3일 뒤 앱에서 영영 사라진다 | 디자인 | `apps/web/src/app/(app)/dashboard/page.tsx:107`,`:328-343` (다른 진입점 0개) | S | ✅ `/todo`가 **기간 제한 없이** 전 기간 백로그를 보여준다(`(app)/todo/page.tsx:9-13`). 홈의 3일 창은 그대로 두고 진입점을 하나 더 만들어 해소 |
| P1-7 | 현재월 예산 수정이 과거월 계획을 소급 변경한다 (D-3) | PO | `apps/api/src/budgets/budget.service.ts:106`,`:190` · `packages/database/src/schema.ts:1146` | M | ✅ ADR-0030 월 원장 — `effective_month`로 달마다 계획을 분리(`0052_budget_month_ledger.sql`) |
| P1-8 | 문자 원문 보존·삭제 정책을 사용자가 선택하거나 철회할 수 없다 | PO | `PRD.md:788`,`:1755` · `docs/phase3-build-spec.md:21` · `apps/web/src/app/join/page.tsx:145` | L | ⬜ |
| P1-9 | 장치 등록이 자동수집 활성화로 이어지지 않고 토큰 발급 화면에서 끝난다 | PO+디자인 | `apps/web/src/app/(app)/devices/page.tsx:481` · `apps/web/src` 내 `MacroDroid` 언급 3곳 전부 라벨 | M~L | ⬜ |
| P1-10 | 장치의 "마지막 수신"이 실제 수신이 아닌 인증 성공 시각이다 (D-2) | PO | `packages/contracts/src/device.ts:22` · `apps/api/src/devices/device.service.ts:61` | S | ⬜ |
| P1-11 | 초대받은 기존 사용자의 로그인 동선이 초대 문맥을 잃는다 (D-4) | PO | `apps/web/src/app/join/page.tsx:114` · `apps/web/src/app/(auth)/login/page.tsx:83` | S | ⬜ |
| P1-12 | Slack·RAG·장기 기억·그래프 자산이 사용자 동선에 연결되지 않았다 | PO | `apps/api/src/slack/slack.controller.ts:69` · `apps/api/src/memory/memory.controller.ts:99` · `apps/web/src/app/(app)/more/page.tsx:47` | L | ⬜ |
| P1-13 | 거래·예산 알림이 큐 투입 실패/워커 크래시 때 영구 유실된다 | 백엔드+데이터 | `apps/worker/src/promotion/transaction-promotion.service.ts:237-263`,`:817-836`,`:895-912` · `apps/worker/src/processors/notification-dispatch.processor.ts:100-109` | L | ⬜ |
| P1-14 | 가구 전체 예산이 동시 생성 시 중복될 수 있다 | 백엔드 | `apps/api/src/budgets/budget.service.ts:133-160`,`:477-503` · `packages/database/src/schema.ts:1146-1175` | M | ⬜ |
| P1-15 | 장치 secret 동시 회전이 active credential을 둘로 만든다 | 백엔드 | `apps/api/src/devices/device.service.ts:241-305` · `0047_device_eligibility_and_credential_unique.sql` | M | ✅ 장치 행 `FOR UPDATE` 직렬화 + 부분 유니크 인덱스 2겹. 앱 밖 원인의 위반만 409로 올려 운영자가 정리한다 |
| P1-16 | 반복 거절 알림이 별칭 적용 전 raw 가맹점으로 그룹화되어 2회 임계를 놓친다 | 데이터 | `apps/worker/src/notifications/notification-scheduler.service.ts:489`,`:513`,`:559` · `apps/api/src/card-sms/card-sms-query.service.ts:196` | M | ⬜ |
| P1-17 | 가맹점 별칭 병합이 `model_prediction`을 남기고 `human_confirmed` 규칙을 삭제한다 | 데이터 | `apps/api/src/merchants/merchant.service.ts:228`,`:249`,`:261` · `docs/adr/0019-merchant-label-review-boundary.md:42` | M | ⬜ |
| P1-18 | 토스뱅크 거절 문자의 가맹점이 거절 사유 문장으로 저장된다 | 데이터 | `packages/card-parsers/src/parsers/toss.parser.ts:70`,`:141` · `packages/card-parsers/src/parsers/base.parser.ts:267` | S | ⬜ |
| P1-19 | 파서 안전정수 허용범위와 PostgreSQL `integer` 범위가 달라 잡이 반복 실패한다 | 데이터 | `packages/card-parsers/src/currency.ts:74` | L | ✅ `toMinorUnits`가 `Number.isSafeInteger` 밖·음수를 값 없이 warning으로 돌려보낸다 — 잡을 실패시키지 않고 사람 검토로 보낸다 |
| P1-20 | 리마인더 딥링크가 "이번 달" 필터에 걸려 알림 대상 거래가 안 보인다 | 프론트 | `packages/shared/src/notifications.ts:113` · `apps/web/src/app/(app)/transactions/page.tsx:249-252` | S | ⬜ |
| P1-21 | 대시보드 "확인이 필요한 거래 N건"의 N과 도착 화면 목록이 일치하지 않는다 | 프론트 | `apps/web/src/app/(app)/dashboard/page.tsx:206-213`,`:447` | S | ⬜ |
| P1-22 | 예산 초과를 알린 뒤 할 수 있는 게 "예산 수정"과 "삭제"뿐이다 | 디자인 | `apps/web/src/app/(app)/budgets/page.tsx:401-422` · `apps/web/src/components/widgets/usage-bar.tsx:44-50` | S | ⬜ |

**진행 중 묶음의 정체**: P0-1 · P1-1 ~ P1-5는 전부 웹 1개 앱 안의 신뢰 문제이고 서로 파일이 겹치지 않는다. 그래서 한 배포로 함께 나간다.
`packages/contracts/src/notification.ts`의 `decline` 추가만 계약 변경이며, 웹보다 워커·API가 먼저 배포되는 정상 순서에서도 안전하도록 웹에 `kindMeta()` 폴백을 함께 넣었다 — 계약이 앞서 나가도 화면이 죽지 않는 구조가 이번 수정의 본질이다.

---

## 3. 신규 제품 콘셉트

두 진단(PO의 콘셉트 7건, 디자인의 개선 제안 8건)은 **같은 문제를 다른 이름으로 부른 경우가 많았다.** 아래는 병합 결과 8건이며, 병합한 항목은 `병합` 줄에 원 출처를 남겼다.

### RICE 산식과 주의

`RICE = Reach × Impact × Confidence ÷ Effort` (Reach·Impact·Confidence 1~5, Effort는 S/M/L을 1~5로 환산).
PO 원 점수의 Effort는 M이 2와 3에 걸쳐 있다 — 원문 값을 그대로 옮겼고, 병합으로 범위가 달라진 것만 재산정했다.
**RICE는 콘셉트 간 상대 가치일 뿐, 스프린트 배치는 P0와 의존관계가 먼저다.** (4장 참조)

| 순위 | 콘셉트 | PO 원점수 | 병합 후 | 조정 사유 |
|---|---|---|---|---|
| 1 | C-1 끊김 없는 가족 합류 | 62.5 | **41.7** | 초대 미리보기 엔드포인트(신규 백엔드)와 온보딩 체크리스트가 더해져 Effort 2→3 |
| 2 | C-7 숫자 다음의 행동 | 32.0 | **40.0** | 홈 집계 위젯 딥링크(전 사용자 진입점)가 병합되어 Reach 4→5 |
| 3 | C-4 예산 원장 + 초과 후 행동 | 26.7 | **33.3** | 딥링크 개선이 "새 백엔드 없이 체감 개선폭 최대"로 평가되어 Impact 4→5 |
| 4 | C-8 할 일(Inbox) 표면 | — | **33.3** | 디자인 진단 단독 발의. 기존 API 3종으로 구현 가능(Confidence 5) |
| 5 | C-2 문자 수집 마법사 + Signal Doctor | 41.7 | **31.3** | 플랫폼별 설정 콘텐츠 작성 리소스 포함 시 Effort 3→4 |
| 6 | C-3 개인정보 Control Center | 31.3 | **31.3** | 변경 없음 |
| 7 | C-5 정기 지출 Radar | 21.3 | **21.3** | 변경 없음 |
| 8 | C-6 Dual-mode 모아 AI | 15.0 | **15.0** | 변경 없음 |

---

### C-1. 끊김 없는 가족 합류 — `5 × 5 × 5 ÷ 3 = 41.7`

- **병합**: PO 콘셉트 1(합류 여정) + 디자인 B-1(가입~첫 화면 여정 분석) + 디자인 E-1(첫 대시보드 체크리스트). **세 항목은 "초대 링크를 받은 사람이 첫 거래를 볼 때까지"라는 하나의 여정이라 합쳤다.**
- **문제 정의**: 초대 링크가 로그인에서 끊기고(D-4), 합류 직후 홈은 빈 카드 6장이라 다음 행동이 없다. `/join` 화면은 **어느 가족이 초대했는지도 보여주지 않은 채** 데이터 공유 동의를 받는다.
- **핵심 시나리오**
  1. 초대 링크를 열면 가족 이름·초대자·역할·만료가 먼저 보인다.
  2. 기존 계정 로그인을 골라도 invite state가 유지되어 수락 화면으로 돌아온다.
  3. 버전된 동의 내용을 확인하고 수락한다.
  4. 합류 완료 화면이 장치 연결 또는 "나중에"를 제안한다.
  5. 홈은 빈 카드 대신 3단계 체크리스트를 보여주고, 첫 문자 수신까지 진행 상태를 잇는다.
- **재사용하는 기존 자산**: 회원가입 쪽 invite 보존(`apps/web/src/app/(auth)/register/page.tsx:30`), 온보딩 컴포넌트(`apps/web/src/components/onboarding.tsx:116`), `EmptyState`의 `action` prop(`apps/web/src/app/(app)/dashboard/page.tsx:1155`), 완료 판정에 쓸 `useCardList`/`useDevices`/`useTransactions`.
- **신규가 필요한 것**: `GET /v1/household-invitations/:token` (가족명·초대자·역할·만료). 현재 `invitation.controller.ts`에는 `POST :token/accept` 하나뿐이다.
- **성공지표**: 초대 링크→합류 완료율 / 합류→첫 문자 수신 중앙값 / 체크리스트 3단계 완주율
- **공수**: M (백엔드 S + 웹 M)
- **위험**: 초대 토큰을 URL에 오래 남기지 않도록 허용 경로 검증과 짧은 세션 state가 필요하다.

```
개선 후 — 첫 대시보드 (디자인 진단 E-1 와이어프레임)
┌─────────────────────────────────────────┐
│ 시작하기                          1 / 3 │
│ ▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░           │
├─────────────────────────────────────────┤
│ ✓  가족 만들기                          │
│    '우리집' 가족을 만들었어요            │
├─────────────────────────────────────────┤
│ ②  결제 카드 등록하기            [등록]  │
│    뒤 4자리를 넣으면 문자가 자동 연결돼요 │
├─────────────────────────────────────────┤
│ ③  휴대폰 연결하기               [연결]  │
│    카드 문자를 자동으로 모아와요          │
├─────────────────────────────────────────┤
│ 지금 바로 넣어볼까요?                    │
│ [ 문자 붙여넣어 거래 추가하기 ]          │  ← 기존 AddTransactionDialog 재사용
└─────────────────────────────────────────┘
        (3/3 완료 시 이 카드는 사라지고 평소 홈으로)
```

---

### C-2. 문자 수집 마법사 + Signal Doctor — `5 × 5 × 5 ÷ 4 = 31.3`

- **병합**: PO 콘셉트 2("문자 수집 설정 마법사")와 디자인 E-2("secret 덤프를 3단계 마법사로")는 **같은 문제를 다르게 부른 것이다.** 하나로 합쳤다. 디자인 B-2(수집 설정 여정 6단계)와 PO B5(수집 상태 오표시, D-2)도 같은 화면에서 소비되므로 포함한다.
- **문제 정의**: 앱의 **유일한 데이터 유입 경로**를 설정하는 화면이 `deviceId`·`secret`·`HMAC-SHA256(secret, ${X-Timestamp}.${X-Nonce}.${rawBody})`를 보여준 뒤 끝난다. `apps/web` 전체에서 `MacroDroid` 문자열은 3곳뿐이고 전부 이 다이얼로그의 **라벨**이다. 실제 설정 절차는 개발자용 스펙(`docs/addendum-card-sms-token-ingest.md`)에만 있다. 설정을 못 끝내면 앱의 모든 화면이 영구히 빈 상태로 남는다.
- **핵심 시나리오**
  1. iOS 단축어 / Android MacroDroid를 고른다(폼에 `platform` 값이 이미 있어 분기 가능).
  2. 엔드포인트·헤더·본문 템플릿을 **한 번에 복사**하거나 사전 구성 템플릿을 가져온다.
  3. "연결 테스트"가 `ping-token`을 호출해 인증만 먼저 확인한다.
  4. 실제 카드 결제 1건으로 `firstEventAt`을 확인하고, 60초 무수신이면 원인 3가지를 안내한다.
  5. 이후 장치 목록은 **연결 확인 / 마지막 문자 수신 / 마지막 거래 생성** 세 신호를 분리해 보여준다.
- **재사용하는 기존 자산**: `ping-token`(`apps/api/src/devices/mobile-events.controller.ts:42`), `firstEventAt`·`lastEventAt`(`packages/database/src/schema.ts:403`), 수집 공백 경보(`apps/worker/src/notifications/notification-scheduler.service.ts:290`), `API_BASE_URL`(`apps/web/src/lib/api-client.ts:86`).
- **성공지표**: 장치 등록→첫 문자 수신 전환율 / 설정 시작→첫 수신 소요시간 / 24시간 이상 미완주 장치 비율
- **공수**: M (콘텐츠 작성 포함 시 L)
- **위험**: 템플릿이 OS·앱 업데이트에 따라 깨진다. 템플릿 버전과 서버 호환성 관리가 필요하다. `[가설]`

```
개선 후 — 장치 등록 완료, Android (디자인 진단 E-2 와이어프레임)
┌──────────────────────────────────────────┐
│ '엄마 갤럭시'를 연결하는 중        1/3    │
├──────────────────────────────────────────┤
│ ① MacroDroid 앱을 설치해 주세요           │
│    [ Play 스토어 열기 ]                   │
│                                          │
│ ② 아래 설정을 그대로 붙여넣어 주세요       │
│    ┌────────────────────────────────┐    │
│    │ 트리거   문자 수신 (카드사)      │    │
│    │ 동작     HTTP 요청 (POST)       │    │
│    │ 주소     api.example.com/v1/... │    │
│    │ 헤더     Authorization: Bearer …│    │
│    │ 본문     {"content": "[문자]"}  │    │
│    └────────────────────────────────┘    │
│    [ 설정 전체 복사하기 ]                 │
│    ⓘ 이 화면을 닫으면 다시 볼 수 없어요    │
│                                          │
│ ③ 카드로 한 번 결제해 보세요               │
│    ⟳ 첫 문자를 기다리고 있어요…            │
│                                          │
│ ▸ 개발자용 고급 설정 (HMAC 서명)          │  ← 기본 접힘
├──────────────────────────────────────────┤
│ [ 다 했어요 ]                             │
└──────────────────────────────────────────┘
```

> **의존**: 본문 템플릿에 멱등 키(P0-9 대응)가 들어가야 한다. 계약을 확정하기 전에 템플릿을 배포하면 사용자가 설치한 자동화를 나중에 전부 다시 만들게 한다.

---

### C-3. 개인정보 Control Center — `5 × 5 × 5 ÷ 4 = 31.3`

- **출처**: PO 콘셉트 3 단독(디자인 진단에는 대응 항목이 없다). 배치할 자리는 디자인 E-8의 `내 계정 · 알림` 그룹을 쓴다.
- **문제 정의**: 가입 동의는 "공동 지출과 예산 열람"만 알린다. 어떤 문자 원문이 DB와 객체 저장소에 얼마나 남는지 설명하지도, 고르게 하지도 않는다. 동의 철회 표면도 없다(그리고 철회해도 P0-2 때문에 수집이 멈추지 않는다).
- **핵심 시나리오**: 현재 동의 버전·연결 장치 확인 → 원문 보존(계속/30일/파싱 후 삭제/실패만) 선택 → 변경 시 영향 미리보기 → 철회 시 장치 즉시 revoke → export 요청·만료 링크 다운로드.
- **재사용하는 기존 자산**: Source revision·tombstone(`packages/database/src/schema.ts:580`), 장치 revoke(`apps/api/src/devices/device.service.ts:212`), 객체 저장소 경로(`apps/api/src/card-sms/card-sms-ingest.service.ts:117`).
- **성공지표**: 버전된 유효 동의 커버율 100% / 철회→수집 차단 지연 p95 / 보존정책 purge 성공률
- **공수**: L
- **위험**: 법적 보관·삭제 요구는 관할·운영 정책 검토가 필요하다. 개인 Workspace 분리는 삭제보다 범위가 크다. `[가설]`
- **8주 계획에서의 취급**: **1단계(버전된 동의 기록 + 장치별 즉시 철회)만 S3에 넣고, 보존정책 선택·purge 잡·export는 보류한다.** 이유는 5장.

---

### C-4. 예산 원장 + 초과 후 행동 — `4 × 5 × 5 ÷ 3 = 33.3`

- **병합**: PO 콘셉트 4(예산 원장 + 다음 달 플래너) + PO B2(D-3 소급 변경) + 디자인 E-3(초과 후 액션 부재). **"과거를 못 믿는다"와 "초과를 알고도 할 게 없다"는 같은 예산 화면의 앞뒤 문제라 합쳤다.**
- **문제 정의**: UI는 과거월을 읽기 전용으로 보여주지만 모든 월이 같은 예산 행을 쓴다. 그리고 초과 시 제공되는 액션은 `수정`과 `삭제`뿐 — **"예산을 넘었으니 예산을 늘려라"는 가계부가 줄 수 있는 최악의 조언이다.**
- **핵심 시나리오**: 월별 화면이 당시 **계획 금액**을 고정 기록으로 보여주고 실지출·달성률은 정정 가능한 거래에서 재계산한다 → 초과 행의 주 액션이 `어디서 썼는지 보기`(딥링크) → `다음 달 계획 만들기`로 현재 예산 복사 → 지난달 실지출·3개월 평균 참고 → 새 달 시작 시 해당 버전 활성화, 과거 버전 보존.
- **재사용하는 기존 자산**: 월 스위처·전월 실지출 조회(`apps/web/src/app/(app)/budgets/page.tsx:130`,`:283`), 거래 화면의 쿼리 파라미터 초기 필터(`apps/web/src/app/(app)/transactions/page.tsx:249-259` — `month`/`memberId`/`cardId`/`categoryId`). **딥링크는 새 백엔드가 필요 없다.**
- **성공지표**: 다음 달 예산 생성률 / 예산 변경 후 과거월 불변성 100% / 초과 행→거래 목록 이동률
- **공수**: M (데이터 모델 M + 딥링크 S)
- **위험**: "매월 자동 이월"과 "명시적 복사" 중 기본값은 사용성 실험이 필요하다. `[가설]`

```
개선 후 — 예산 화면, 초과 상태 (디자인 진단 E-3 와이어프레임)
┌──────────────────────────────────────────┐
│ 식비                        카테고리·식비 │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓  127%  │
│ 637,000원 / 500,000원                    │
│ 예산을 137,000원 넘었어요                 │
│                                          │
│ [ 어디서 썼는지 보기 ]              [⋯]  │
│   ↳ /transactions?categoryId=…&month=…   │
└──────────────────────────────────────────┘
     ⋯ = 예산 수정 / 예산 삭제
```

---

### C-5. 정기 지출 Radar — `4 × 4 × 4 ÷ 3 = 21.3`

- **병합**: PO 콘셉트 5 + PO B10(Phase 5가 약속한 정기 결제 후보 미구현).
- **문제 정의**: 반복 가맹점 데이터와 거절 묶음은 이미 있는데, **정상적으로 빠져나가는** 정기 결제는 아무 데도 표시되지 않는다.
- **핵심 시나리오**: 최근 3~6개월의 정규화 가맹점·금액·주기를 결정적 규칙으로 후보화 → 사용자가 "정기 결제 맞음/아님" 확정 → 홈에 월 정기 지출 총액과 다음 7일 예정 → 반복 거절 시 기존 사유별 조치로 연결 → 해지 항목은 종료 처리.
- **재사용하는 기존 자산**: 가맹점 별칭(`apps/web/src/app/(app)/more/merchants/page.tsx:1`), 거절 묶음·사유(`docs/adr/0024-declined-payment-visibility.md:47`), 알림 dedupe(`apps/worker/src/notifications/notification-scheduler.service.ts:121`).
- **성공지표**: 후보 확정 정밀도 / 사용자가 확인한 월 정기 지출 총액 / 반복 거절→조치 완료율
- **공수**: M
- **의존**: P1-16(거절 별칭 그룹 불일치)과 P0-10(파서 앵커링)이 먼저다. 정규화가 갈라진 상태에서 만든 후보는 정밀도를 측정할 의미가 없다.
- **위험**: 금액 변동형 구독과 일회성 반복 구매 오탐은 사람 확인으로 막는다. 현재 데이터로 3개월 주기 판별이 가능한 사용자가 충분한지는 `[가설]`.

---

### C-6. Dual-mode 모아 AI: 금융 + 업무 기억 — `3 × 5 × 4 ÷ 4 = 15.0`

- **병합**: PO 콘셉트 6 + PO B7(Phase 6~9 자산 미노출) + PO B8(지원하지 않는 질문에도 월 총지출로 답함).
- **문제 정의**: Slack Import·work-query·citations·기억 후보 승인·timeline API가 **전부 구현되어 있는데** 웹·모바일 표면이 없다. 동시에 AI 화면은 "무엇이든 물어보세요"라고 하면서 미분류 질문에 기본 `total`을 답한다.
- **핵심 시나리오**: owner가 Slack Export 업로드 → 처리 상태·검색 가능 기간 확인 → AI에서 `금융`/`업무 기억` 범위 선택 → 업무 답변의 채널·시각·스니펫 출처 확인 → 기억 후보 승인·수정·거부.
- **재사용하는 기존 자산**: `apps/api/src/slack/slack.controller.ts:69`, `apps/api/src/ai/ai-query.controller.ts:36`, `apps/api/src/memory/memory.controller.ts:112`, `apps/mcp/README.md:91`. **새 백엔드보다 제품화 표면이 핵심이다.**
- **성공지표**: Slack Import 완료 owner 수 / 업무 질문 주간 활성 / 출처 열람률 / 후보 처리율
- **공수**: L
- **의존**: ~~Memory·Graph 목록 API에 페이지 상한이 없다~~ → **해소됨**. 네 목록 API(`memory/candidates`, `memory/memories`, `graph/entities`, `graph/relationships`)가 커서 페이지네이션(기본 50 · 최대 200 · tie-breaker `id`)을 쓴다. 규약은 [`docs/api/memory.md`](api/memory.md#커서-페이지네이션-목록-공통).
- **8주 계획에서의 취급**: **본체는 보류하고, B8(미지원 의도 명시 거부 + 카피 축소, S)만 S4에 넣는다.** 이유는 5장.
- **진행 상황(2026-08-09)**: 선행 조건인 페이지네이션 + B8(정직한 거부·카피 축소·거부율 관측)이 들어갔고,
  `/ai`에 `금융`/`업무 기억` 범위 선택과 출처 표시가 붙었다. **업로드 표면은 열지 않았다** — 서버가 Slack
  export ZIP을 처리하지 못하고(단일 JSON 번들만, `apps/api/src/slack/slack.service.ts` `parseBundleShallow`)
  `importId` 기준 진행 상태 조회 API도 없어, 파일 선택기를 여는 것은 계약상 거짓 동선이기 때문이다.
  대신 가져온 기록이 0건일 때 **명시적 빈 상태**("가져온 Slack 기록이 없습니다" + 현재는 개발자용 JSON
  import만 가능)를 보여 준다. 남은 본체(기억 후보 승인 UI · 타임라인 · 업로드 동선)는 그대로 보류.

---

### C-7. 숫자 다음의 행동 — `5 × 4 × 4 ÷ 2 = 40.0`

- **병합**: PO 콘셉트 7(행동 가능한 주간 브리핑) + 디자인 B-3 결론("숫자를 보여준 다음 뭘 하라가 없다") + 디자인 E-6(홈 집계 위젯 29개 전부 클릭 불가). **"정보 → 행동" 전환이라는 같은 축이라 합쳤다.**
- **문제 정의**: 홈에서 실제로 눌리는 것은 월 스위처, 결제 실패 배너, 확인 필요 2행, 예산 빈 상태 CTA, `전체 보기` 링크 2개뿐이다. **숫자가 적힌 행 중에는 클릭되는 것이 하나도 없다.** 주간 요약 알림도 금액·건수에서 끝난다.
- **핵심 시나리오**: 카테고리/가맹점/구성원/카드 행 탭 → 해당 필터가 걸린 거래 목록 → 주간 브리핑이 "가장 늘어난 카테고리 · 예산 초과 예상 · 새 정기 결제 후보"와 함께 도착 → 제안 중 하나를 고르면 예산 조정이나 정기 결제 검토로 바로 이동 → 다음 브리핑에서 결과 확인.
- **재사용하는 기존 자산**: 거래 화면 쿼리 필터(`apps/web/src/app/(app)/transactions/page.tsx:249-259`, 검색은 `:261`의 `q`), 주간 요약 스케줄(`apps/worker/src/notifications/notification-scheduler.service.ts:200`), 월 인사이트(`apps/api/src/ai/finance-ai.service.ts:212`), 딥링크·알림함(`apps/worker/src/processors/notification-dispatch.processor.ts:278`).
- **성공지표**: 홈 집계 행 탭률 / 브리핑 열람률 / 브리핑→예산·거래·정기결제 액션 전환율
- **공수**: 딥링크 S + 브리핑 M
- **위험**: 알림이 많아지면 가족 구성원 간 압박이 된다. 수신자·개인화 설정이 필요하다. `[가설]`

```
개선 후 — 홈 카테고리 카드 (디자인 진단 E-6 와이어프레임)
┌──────────────────────────────────────────┐
│ 어디에 많이 썼나요?          전체 보기 ›  │
│ 2026년 8월 카테고리별 지출이에요          │
├──────────────────────────────────────────┤
│ 식비        ▓▓▓▓▓▓▓▓▓▓▓  412,000원  32건 ›│
│ 장보기      ▓▓▓▓▓▓▓      210,400원  11건 ›│
│ 카페        ▓▓▓▓          87,000원  19건 ›│
└──────────────────────────────────────────┘
        각 행 탭 → /transactions?categoryId=…&month=…
```

---

### C-8. 할 일(Inbox) 표면 — `5 × 4 × 5 ÷ 3 = 33.3`

- **출처**: 디자인 진단 A-3(to-be IA) + E-4(3일 창 소멸) + E-8(`/more` 재편) 단독 발의. PO 진단에는 대응 콘셉트가 없다.
- **문제 정의**: 매일 발생하는 **처리 작업**(확인 필요 거래 / 읽지 못한 문자 / 결제 실패)이 탭에 없고 홈 카드와 `/more` 6번째 항목으로 흩어져 있다. `/declines`로 가는 상시 링크는 `/more` 안 하나뿐이고 배지도 없으며, 홈 배너는 미해결이 0이면 렌더 자체를 안 한다. 파싱 실패 문자는 3일 뒤 사라진다(D-7).
- **핵심 시나리오**: 하단 탭 `할 일` 1회 탭 → 결제 실패 미해결 / 확인 필요 거래 / 읽지 못한 문자(기간 제한 없음) 3섹션 → 처리 완료 이력 → 탭 배지 = 3개 합계.
- **재사용하는 기존 자산**: 3개 소스 전부 이미 호출 중이었다 — `useDeclineList()` / `useTransactions({status:"pending_review"})` / `GET /v1/card-sms-events?status=parse_failed,quarantined`. **새 백엔드 없이 구현했다**(셋 다 지금은 `useTodoCounts()`가 한 번에 읽고 홈·`/todo`가 같은 캐시를 공유한다).
- **성공지표**: 미해결 항목의 평균 잔존 시간 / 3일 초과 파싱 실패 문자의 처리율 / 탭 진입률
- **공수**: M (탭 신설) — 단기 대안은 S (홈 카드에서 3일 필터만 완화)
- **8주 계획에서의 취급**: **단기 S안(P1-6)만 S2에 넣고 탭 신설은 보류.** 이유는 5장.
- **구현 현황(데이터 표면 완료)**: 탭을 제외한 나머지는 배포 가능한 상태다.
  - `/todo` 신설 — 3섹션(결제 실패 미해결 / 확인 필요 거래 / 읽지 못한 문자)을 **기간 제한 없이** 보여주고, 각 항목이 처리 화면으로 딥링크한다(거래는 `?txn=`로 상세를 바로 연다). 탭이 없어도 완결적으로 동작하며 진입점은 홈 '할 일' 카드다.
  - 홈 3일 창은 **유지하되** 창 밖 건수를 "지난 문자 N건 더 보기"(→ `/todo`)로 노출한다. 창을 없애면 홈이 백로그로 덮이므로 창을 넣은 이유가 사라진다. D-7(3일 뒤 소멸)은 이 줄로 해소된다.
  - 결제 실패 배너를 홈 '할 일' 카드로 흡수했다(`decline-banner.tsx` 삭제). 긴급도는 destructive 톤 + 카드 최상단 줄 + 사유 조치 문구 유지로 보존한다.
  - 합계 로직은 `useTodoCounts()`(`apps/web/src/components/widgets/use-todo-counts.ts`)로 분리했다 — **탭 배지는 이 훅의 `total`을 그대로 쓰면 된다.** 세는 규칙(`todo-counts.ts`)에는 단위 테스트가 있다.
  - '처리 완료 이력'은 **소스가 없어 만들지 않았다.** 확정한 문자·거래의 처리 이력을 남기는 테이블이 없다(결제 실패만 `resolvedAt`/`dismissedAt`를 갖고 있어 `/declines`가 그 역할을 한다).
  - 남은 것: **하단 탭 슬롯 신설 + 배지**(IA 개편 배치), `/more` 3그룹 재편.

```
개선 후 — 홈 '할 일' 카드 (디자인 진단 E-4 와이어프레임, 단기안)
┌──────────────────────────────────────────┐
│ ⚠ 확인이 필요한 거래                4건 › │
│   확인필요 · 중복의심 거래를 모아뒀어요    │
├──────────────────────────────────────────┤
│ ✉ 확인이 필요한 문자         최근 3일 2건 ›│
│   탭하면 원문을 보고 바로 확정할 수 있어요 │
│   지난 문자 7건 더 보기                   │  ← 신규
├──────────────────────────────────────────┤
│ 🔴 결제가 계속 실패하고 있어요        1건 ›│  ← 배너를 여기로 흡수
└──────────────────────────────────────────┘
```

---

## 4. 8주 로드맵

**전제** `[가설]`: 백엔드 1명 · 웹/모바일 1명 · 제품·디자인 0.5명. 기존 자동 검증 자산 유지.

**PO 원안과 무엇이 달라졌나**: PO는 진단 **전에** 로드맵을 짰기 때문에 P0가 반영돼 있지 않다. 확정된 P0 11건 중 10건이 미착수이고, 그중 6건이 **화면에 뜨는 금액을 직접 틀리게 만든다.** 그래서 원안의 Sprint 1~2를 P0로 채우고 활성화·기록 신뢰 작업을 2주씩 뒤로 밀었다.

### 4-0. PO 원안 대비 변경점

| 항목 | PO 원안 | 재배치 | 이유 |
|---|---|---|---|
| P0 11건 | 반영 없음(P0 1건 전제) | S1·S2 전체 | 경계 위반 4건은 데이터가 쌓일수록 되돌리기 비싸고, 금액 오계산 6건은 모든 화면의 신뢰를 깎는다 |
| B5 수집 상태 계약(D-2) | S1 | **S3** | 이 신호를 소비하는 화면이 수집 마법사다. 같이 만들어야 두 번 안 만든다 |
| B6 invite returnTo(D-4) | S1 | **S3** | 합류 화면·동의 화면과 같은 표면. 한 번에 손보는 게 싸다 |
| C1 합류 여정 | S1 | **S3** | 위와 동일 |
| C2 수집 마법사 | S2 | **S3** | 템플릿 본문에 멱등 키(P0-9)가 들어가야 하므로 계약 확정 후 |
| B3 동의 화면 확장 | S2 | **S3** | 합류 여정과 같은 화면 묶음 |
| C3 Control Center 1단계 | S2 | **S3(축소)** | 동의 버전 기록 + 즉시 철회만. 보존정책·purge·export는 보류 |
| B2/C4 예산 월 버전 | S3 | **S4** | 앞의 P0가 2주를 가져갔다 |
| B10/C5 정기 결제 | S3 | **S4(최소)** | 후보 표시·확정까지만. 예상일·구독 총액은 보류 |
| B7/C6 업무 기억 허브 | S4 | **보류** | RICE 15.0으로 최하위, owner 전용이라 Reach 최소, Memory·Graph 페이지네이션이 선행. B8(카피·거부)만 S4에 남김 |

### 4-1. 의존관계

```
[S1] P0-2 장치 revoke ─────────────┐
     P0-3 초대 원자적 claim         ├─▶ 경계가 닫힌 뒤에야 신규 유입을 늘리는 게 안전
     P0-5 Graph workspace 검증      │   (마케팅·온보딩 개선은 그 다음)
     P0-6 가맹점 공개범위 ──────────┘

[S2] P0-9 멱등 키 계약 ────────▶ [S3] C-2 수집 마법사 템플릿
     P0-10 파서 앵커링 ────────┐
     P1-16 거절 별칭 그룹 일치 ─┴──▶ [S4] C-5 정기 지출 후보 (정밀도 측정이 의미를 가짐)
     P0-4/7/8/11 금액 정합 ───────▶ [S4] C-4 예산 원장 (틀린 실지출 위에 계획을 못 세운다)

[S3] C-2 수집 마법사 ─────────▶ C-1 온보딩 체크리스트 ③ '휴대폰 연결하기'
     ※ 체크리스트를 먼저 내면 막다른 길로 안내하게 된다 — 마법사가 반드시 선행
     P1-10 firstEventAt 계약 ──▶ C-2의 3단계 성공 판정

[보류] 백엔드 P2 Memory·Graph 페이지네이션 ──▶ C-6 Dual-mode AI 개방
```

---

### Sprint 1 (1~2주) — 경계를 넘는 것부터 막는다

**목표**: 떠난 사용자·다른 가족·다른 workspace로 데이터가 새는 경로를 전부 닫고, 웹의 신뢰 묶음을 한 배포로 내보낸다.

**포함**

| 항목 | 근거 | 공수 |
|---|---|---|
| P0-2 탈퇴·제거 트랜잭션에서 장치·자격증명 revoke + 두 가드가 `household_members.status='active'` 재검증 | `apps/api/src/household/household.service.ts:331` | M |
| P0-3 초대 수락을 한 트랜잭션 + `UPDATE … WHERE status='pending' RETURNING`으로 원자적 claim | `apps/api/src/household/household.service.ts:538-561` | M |
| P0-5 Graph supersede가 source/target을 `workspace_id` 일치로 재조회 + `(workspace_id,id)` composite FK | `apps/api/src/graph/graph.service.ts:447-460` | M |
| P0-6 `/v1/merchants`에 actor member 조건 + `visibility` 조건, 타인 `summary_only`는 `(비공개)`로 그룹화 | `apps/api/src/merchants/merchant.service.ts:47` | M |
| P0-1 · P1-1~P1-5 웹 신뢰 묶음 (알림함 폴백 · error 바운더리 · 에러 한국어 매핑 · 로그아웃 캐시 · 부트스트랩 오류 구분 · 카테고리 거짓 빈상태) | 2-2 표 | S 합계 |

**완료 정의(DoD)**

- 구성원 제거 직후 기존 Bearer·HMAC 수집 요청이 모두 401이고, 새 `card_sms_events`가 **0건**이다.
- 서로 다른 두 계정이 같은 초대 토큰을 동시에 수락하면 정확히 1건만 성공하고, revoke와 겹쳐도 `revoked`가 `accepted`로 덮이지 않는다.
- 다른 workspace의 엔티티 UUID로 supersede하면 4xx이고, 기존 관계는 종료되지 않은 채 롤백된다.
- 구성원 B의 `GET /v1/merchants` 응답에 A의 `private` 가맹점명이 0건이고, 타인 `summary_only`는 마스킹된다.
- 알림함에 계약에 없는 kind가 섞여도 목록이 렌더되고, 렌더 예외는 `(app)/error.tsx`로 격리되어 탭바가 살아 있다.
- 로그인 실패 시 `invalid credentials`가 화면에 보이지 않는다. 로그아웃 후 다른 계정 로그인 시 이전 사용자의 알림이 0건이다.
- 콜드 스타트 네트워크 실패에서 `/login` 리다이렉트가 0회다.
- 위 경로 각각에 happy/edge/error 자동 테스트와 감사 이벤트가 있다.

**왜 이 순서인가**: 경계 위반 4건은 **시간이 지날수록 되돌리기 비싸다.** 떠난 사용자의 문자는 이미 저장된 뒤에는 삭제 대상 식별부터 어려워지고, 교차 workspace 관계는 GraphRAG 결과를 영구 오염시킨다. 반대로 웹 신뢰 묶음은 전부 S이고 파일이 겹치지 않아 같은 2주에 태울 수 있다 — 이미 절반이 작업 중이다.

**잘라낼 순서(용량 부족 시)**: P1-5 → P1-2 → P1-3. P0 4건과 P0-1은 자르지 않는다.

---

### Sprint 2 (3~4주) — 화면의 금액을 믿을 수 있게 만든다

**목표**: 취소·환율·파서·멱등의 P0를 닫아, 대시보드·예산·가맹점이 **같은 거래에 대해 같은 금액**을 말하게 한다.

**포함**

| 항목 | 근거 | 공수 |
|---|---|---|
| P0-4 승인 행 `FOR UPDATE`/조건부 update로 취소 누적 직렬화 (수동 연결·자동 승격·연결 삭제 3경로) | `apps/api/src/transactions/transaction.service.ts:908-927` | M |
| P0-7 사람 검토 확정 취소가 자동 승격과 **같은 취소 연결 도메인 서비스**를 호출 | `apps/api/src/card-sms/card-sms-review.service.ts:228` | L |
| P0-8 원통화로 먼저 짝짓고, 부분취소는 승인에 저장한 환율 재사용. 환율 API를 거래일 인자 역사환율 계약으로 | `apps/worker/src/promotion/fx-rate.service.ts:54` | L |
| P0-11 모든 거래 생성 경로가 하나의 금액 변환·검증 서비스를 통과 (그 전까지 비KRW 직접 입력 금지) | `apps/api/src/card-sms/manual-entry.service.ts:223` | L |
| P0-10 금액 후보를 액션·승인 시각에 앵커링, 광고/할인/한도/누계 라인 제외, 애매하면 비승격 검토 | `packages/card-parsers/src/parsers/generic.parser.ts:104` | M |
| P0-9 수집 계약에 문자별 고유 ID(또는 안정적 수신 시각) 필수화 + 재시도 규약 | `packages/contracts/src/card-sms.ts:45` | M |
| P1-19 금액 컬럼 `bigint`/`numeric` 이관 또는 DB 상한을 불변식에 편입 | `packages/database/src/schema.ts:1044` | L |
| P1-18 토스 파서가 거절도 판정하고 가맹점 추출은 기존 파이프 사용 | `packages/card-parsers/src/parsers/toss.parser.ts:70` | S |
| P1-6 파싱 실패 문자의 3일 표시 필터 완화(`지난 문자 N건 더 보기`) | `apps/web/src/app/(app)/dashboard/page.tsx:328-343` | S |

**완료 정의(DoD)**

- 2-1의 **P0 재현 시나리오 표 7행이 전부 기대값으로 통과**한다(동시성 2건 포함: link/link, promote/promote, link/delete).
- 수동 입력 USD 10.00이 대시보드·가맹점 정리·예산에서 동일한 환산 금액으로 보인다.
- `2,147,483,647` 및 `+1` 경계 금액이 잡 무한 재시도 없이 저장되거나 명확한 코드로 격리된다.
- 3일이 지난 파싱 실패 문자를 홈에서 다시 열어 확정할 수 있다.
- **집계 무회귀 확인**: ADR-0026이 배포 전 근거로 쓴 것과 같은 방식으로 2026-07 `812,414원/63건`, 2026-08 `411,089원/28건`을 재측정한다(`docs/adr/0026-single-spend-aggregation-contract.md:182`). 이번 수정은 취소 상계·외화 환산 교정으로 **합계를 낮출 수 있다** — 차이가 나면 건별로 설명 가능해야 하고, 설명되지 않는 변동은 회귀로 본다.

**왜 이 순서인가**: P0-4·7·8·10·11은 전부 "화면에 뜬 금액이 틀리다"이고, 그 위에 얹는 모든 기능(예산 원장·정기 지출·주간 브리핑)의 입력값이다. **틀린 실지출 위에 계획 기능을 만들면 두 번 만든다.** P0-9(멱등 키)를 여기 넣는 이유는 S3의 수집 마법사 템플릿이 이 계약을 그대로 인쇄하기 때문이다.

**잘라낼 순서**: P1-19 → P1-18 → P1-6. P0는 자르지 않는다. P0-7·8·11이 ADR 초안 단계이므로, ADR 확정이 늦어지면 P0-4·9·10을 먼저 배포한다.

---

### Sprint 3 (5~6주) — 새 구성원이 앱 안내만으로 첫 거래를 만든다

**목표**: 초대 링크를 받은 사람이 앱 밖 문서 없이 장치를 연결하고, 자기 문자가 무엇으로 저장되는지 알고 동의한다.

**포함**

| 항목 | 콘셉트 | 공수 |
|---|---|---|
| 플랫폼별 3단계 수집 마법사 + 설정 전체 복사 + `ping-token` 연결 테스트 + 첫 수신 대기/복구 안내 | C-2 | M~L |
| `firstEventAt`·`lastEventAt`을 `DeviceSummary`에 노출, UI를 "연결 확인 / 마지막 문자 수신"으로 분리, 첫 수신 전 미완료 배지 (P1-10, D-2) | C-2 | S |
| `GET /v1/household-invitations/:token` 신설 + `/join`에 가족명·초대자·역할·만료 표시 | C-1 | S |
| invite-preserving login `returnTo` (P1-11, D-4) | C-1 | S |
| 첫 대시보드를 온보딩 체크리스트 1장으로 대체 (거래 0건 && 카드 0장 조건) | C-1 | M |
| 동의 화면 확장: 수집 대상·저장 데이터·공개 범위·기본 보존 정책·해제 방법 + **버전된 동의 기록** | C-3 1단계 | M |
| 장치별 동의 철회 → 즉시 revoke (S1의 P0-2 위에서 동작) | C-3 1단계 | S |

**완료 정의(DoD)**

- 빈 계정에서 iOS/Android 각 1경로가 **앱 안내만으로** 장치 등록 → 인증 테스트 → 첫 문자 → 첫 거래까지 완주된다(앱 밖 문서 참조 0회).
- 장치 목록이 "연결 확인"과 "마지막 문자 수신"을 분리해 보여주고, 인증만 된 장치는 정상으로 표시되지 않는다.
- 기존 계정 사용자의 `/join → 로그인 → 수락` E2E가 한 번에 완주된다. 만료·이미 수락·이메일 불일치도 복귀 화면에서 처리된다.
- 거래 0건·장치 0건 계정의 홈이 빈 카드 6장 대신 체크리스트 1장이고, 3/3 완료 시 사라진다.
- 동의 버전·시각·범위가 서버에 기록되고 본인과 owner가 조회할 수 있다. 철회 후 수집 차단이 한 요청 이내다.
- 장치 등록→첫 문자 수신 **전환율과 소요시간 이벤트가 수집되기 시작**한다(현재 이 수치가 없어 활성화 판단이 `[가설]`에 머물러 있다).

**왜 이 순서인가**: 수집 마법사는 활성화의 관문이지만 **S1의 경계와 S2의 금액 정합보다 먼저 올 수 없다** — 유입을 늘리는 개선은 새는 곳을 막은 뒤에 해야 손해가 안 커진다. 마법사가 체크리스트보다 먼저인 이유는 의존관계에 적었다: 체크리스트 ③이 가리키는 곳이 마법사다.

**잘라낼 순서**: 온보딩 체크리스트 → 초대 미리보기 엔드포인트 → 동의 화면 확장. 마법사와 `firstEventAt` 계약은 자르지 않는다(둘이 한 화면이다).

---

### Sprint 4 (7~8주) — 숫자 다음의 행동을 만든다

**목표**: 과거 예산을 불변 기록으로 만들고, 홈의 숫자에서 원인 화면으로 1탭에 도달하게 한다.

**포함**

| 항목 | 콘셉트 | 공수 |
|---|---|---|
| 예산에 `effectiveMonth`/월 버전 도입, 조회는 선택 월의 유효 버전, 과거월 삭제 금지, 기존 행 마이그레이션 (P1-7, D-3) | C-4 | M |
| 다음 달 예산 복사 + 지난달 실지출·3개월 평균 참고 UI | C-4 | S |
| 예산 초과 행의 주 액션을 `어디서 썼는지 보기` 딥링크로, `수정`은 `⋯`로 강등 (P1-22) | C-4 | S |
| 홈 집계 위젯(카테고리·가맹점·구성원·카드)에 딥링크 + chevron (P1-21 포함) | C-7 | S |
| 정기 결제 후보 결정적 규칙 + 사용자 확정 + 홈 요약. 확정 전에는 알림 없음 | C-5 | M |
| P1-16 거절 별칭 그룹 일치(화면·스케줄러가 같은 정규화 함수) | C-5 선행 | M |
| P1-13 notification transactional outbox (거래·예산·리마인더·주간요약·거절 공통) | — | L |
| P1-14 가구 예산 partial unique · P1-15 장치 active credential partial unique + row lock | — | M |
| P0-11 후속: AI 미지원 의도 명시 거부 + "무엇이든" 카피 축소 | C-6 축소 | S |

**완료 정의(DoD)**

- 현재월 예산 수정·삭제 후 모든 과거월 응답이 **바이트 단위로 동일**하다. 기존 예산이 손실 없이 월 버전으로 이관된다.
- 예산 초과 행과 홈 집계 행에서 1탭에 필터가 걸린 거래 목록에 도달한다. 대시보드 "확인이 필요한 거래 N건"의 N과 도착 화면 목록 건수가 일치한다.
- 3개월 샘플셋에서 정기 결제 후보 정밀도 목표를 **사전에 정의하고 측정**한다. 미확정 후보는 알림을 만들지 않는다.
- 표기가 갈린 같은 가맹점(`GS25`/`지에스25`)의 거절 2건이 하나의 묶음으로 임계를 넘는다.
- 승격 커밋 직후 프로세스 kill 또는 Redis 일시 장애 후에도 인앱 이력과 push가 **논리 이벤트당 정확히 한 번** 남는다. 예산 임계 알림이 dedupe 선점으로 영구 유실되지 않는다.
- AI가 지원하지 않는 질문에 이번 달 총지출로 답하지 않는다.

**왜 이 순서인가**: 예산 원장은 S2에서 실지출이 정확해진 뒤라야 의미가 있다. 정기 지출 후보는 별칭 정규화(P1-16)와 파서 앵커링(P0-10) 뒤라야 정밀도를 측정할 수 있다. 알림 outbox는 예산 알림 신뢰와 직결되므로 예산 원장과 같은 스프린트에 둔다 — 백엔드·데이터 두 진단이 **독립적으로 같은 결론(outbox)** 에 도달한 항목이다.

**잘라낼 순서**: P1-13 outbox → C-5 정기 결제 후보 → 다음 달 예산 복사. 예산 월 버전과 딥링크는 자르지 않는다(각각 D-3 해소와 최저 비용 최대 체감).

---

## 5. 문서화하지만 지금 하지 않기로 한 것

8주 안에 넣지 않은 항목과 **그렇게 정한 이유**다. 나중에 이 문서를 여는 사람이 "왜 이건 안 했지"를 묻지 않도록 남긴다.

### 5-1. 콘셉트 단위 보류

| 항목 | 규모 | 지금 하지 않는 이유 | 다시 볼 조건 |
|---|---|---|---|
| C-3 Control Center 본체 (보존정책 선택 · 원문 purge 잡 · 삭제 이력) | L | 법적 보관·삭제 요구가 관할·운영 정책 검토를 필요로 한다. 8주에 불완전하게 밀어 넣으면 "지웠다고 했는데 남아 있다"가 되어 P0-2보다 나쁜 신뢰 사고가 된다 | **하지 않기로 함 (2026-08-18 사용자 결정)** — 저장 압력이 없고(원문 ~150B/건), 원문은 RAG·학습·파서 회귀검증 자산이며, 되돌릴 수 없는 자동 잡의 위험이 비대칭이다. 보존정책은 `none` 동결. 다시 볼 조건: 외부 사용자 개방 · 법정 요구 · 저장량 임계 |
| owner 데이터 내보내기 · 가족 그룹 삭제 (PO B9) | L | 비동기 export·만료 링크·재인증·유예 기간·감사 이벤트가 한 묶음이다. 위 항목과 같은 데이터 모델을 쓰므로 따로 만들면 두 번 만든다 | **하지 않기로 함 (2026-08-18 사용자 결정)** — 단일 가족 운영에서 이탈·종료 시나리오가 없다. 외부 사용자에게 열 때 다시 본다 |
| C-6 Dual-mode AI 허브 (Slack 업로드 · 업무 질의 · 기억 후보 승인 · 타임라인) | L | RICE 15.0으로 최하위이고 owner 전용이라 Reach가 가장 작다. **Memory·Graph 목록 API에 페이지 상한이 없어**(`apps/api/src/memory/memory.controller.ts:59-77`) 표면을 열면 그대로 성능 사고가 된다. 구현 비용은 이미 지불됐으므로 자산이 사라지지는 않는다 | 페이지네이션(아래) 완료 후. 그 전에 S4에서 카피·거부만 정직하게 만든다 |
| ~~C-8 할 일 탭 신설 + `/more` 3그룹 재편 + 아바타 메뉴 확장~~ **(2026-08-10 처리됨)** | M + S | 보류 조건이던 "표면 확정"이 `0f56d77`로 충족돼 **한 덩어리로** 옮겼다(ADR-0031). '더보기' 탭이 헤더 아바타로 올라가고 그 슬롯을 '할 일'이 받았다. 재학습은 한 번으로 끝났고, IA에 묶여 있던 P2·P3도 같이 정리했다(아래 표 참조) | — |
| 비밀번호 찾기 | M | 저장소 전체에 `password-reset`/`forgot` 구현이 0건이고, 메일 발송 인프라(발송 경로 선택·도메인 인증·토큰 만료 설계)부터 필요하다 | **하지 않기로 함 (2026-09-03 사용자 결정)** — 2인 운영이고 둘 다 로그인 상태다. `/more/password`로 **아는 상태에서의 변경**은 가능하니 실사용 공백은 "잊었을 때"뿐이고, 그때는 owner가 DB로 복구할 수 있다. 다시 볼 조건: 외부 사용자 개방, 또는 구성원이 실제로 잠긴 사건 1회 |
| ~~정기 결제 완전판 중 **다음 예상일**~~ **(2026-08-18 처리됨)** | S | `forecastRecurring`은 `last_seen_at`·`interval_days`의 순수 함수라 금액 계약과 무관하다. 창(±N일)과 함께 말한다 | — |
| 정기 결제 **금액 레이어** (월 구독 총액 · 예정 알림 금액 · 해지 종료 처리 · 카드 교체 CTA) | M | 금액 위의 **예고**라서 ADR-0027 7단계(레거시 186건 수리)가 선행이다. 후보 표시는 관측된 사실만 말하므로 그 게이트에 걸리지 않는다 | 7단계 완료 후. **2026-09-03 실행기 완성**(`repair.ts`·`repair-money-contract.mjs`) — 남은 것은 실행과 사람 검토 큐 처리다 |

> **2026-09-03 — 플래그로 잠겨 있던 기능 2건을 켰다.** 코드는 완성돼 있는데 env 값이 없어
> 사용자에게 닿지 않던 것들이다. `RECURRING_RADAR_ENABLED=true`(C-5 후보 표시·확정),
> `CARD_SMS_LLM_MODE=on`(ADR-0023 L2 폴백 — 규칙 파서가 **실패한 문자에만** 개입하고 결과는
> `quarantined`로 적재돼 사람 확인 전까지 거래로 승격되지 않는다).
>
> 배운 것: **"구현 완료"와 "사용자에게 닿음" 사이에 플래그라는 구간이 있고, 이 문서는 그
> 구간을 세지 않았다.** 로드맵이 ✅로 적은 C-5는 3주 넘게 화면에서 "아직 준비 중"이었다.
> 앞으로 플래그가 붙은 기능은 상태를 `✅ 구현` / `🔓 활성` 둘로 나눠 적는다.
>
> **켠 뒤에 안 것 — 효과는 데이터에 달려 있다(커밋 메시지 정정).** 커밋 `8790629`는 LLM
> `on`이 "조용히 버려지던 문자를 구제한다"고 적었지만, 실측하니 카드문자 **280건이 전부
> `parsed`**다(parse_failed 0 · parse_error 0). 규칙 파서가 100% 성공 중이라 L2가 태울 대상이
> 지금은 없다 — 호출량 0, 비용 0, 실제 역할은 카드사 문구 개편 시의 안전망이다.
> 정기 지출도 금액 밴드까지 넣으면 후보가 1건(영등포구청 91원×3회)뿐이다. 가맹점 반복은
> 많지만(쿠팡 25회 등) 금액이 제각각이라 구독이 아니다. **이 가족의 구독이 카드문자로
> 들어오지 않는다**는 뜻이고(계좌 자동이체 가능성), 판별기의 문제가 아니다.

### 5-2. P2 — 지금 서비스가 죽지는 않는 것

| 항목 | 근거 | 보류 이유 |
|---|---|---|
| HMAC nonce 만료 행 정리 잡 부재 (테이블 무한 증가) | `apps/api/src/devices/device-hmac.guard.ts:121` · `docs/adr/0007-device-hmac-authentication.md:129` | 현재 수집량에서 즉시 장애는 아니다. **테이블 크기를 운영 지표로 감시하다가 임계를 넘으면 승격한다** |
| ~~Memory·Graph 목록 API 페이지 상한 없음~~ **(2026-08-09 처리됨)** | `apps/api/src/memory/pagination.ts` | C-6 표면을 열기 직전에 커서 페이지네이션으로 해소. 남은 미적용: `graph/timeline` · `graph/entities/:id`(둘 다 단일 엔티티 범위라 상한이 그 엔티티의 차수로 묶인다) |
| ADR-0023 파서 품질 지표(`llm_span_reject_rate` 등) 미저장 | `docs/adr/0023-card-sms-ai-parsing-cascade.md:198` · `apps/worker/src/processors/card-sms-parse.processor.ts:227` | 카드사 문구 개편을 조기 감지하는 관측 자산이지만, S2에서 파서 자체를 바꾸므로 **변경 후의 파이프라인에 맞춰 지표를 정의**하는 편이 낫다 |
| ~~`/more/merchants` 액션 바가 iOS 탭바와 겹침~~ **(2026-08-10 처리됨)** | `apps/web/src/app/globals.css`의 `--app-tabbar-h` | IA 개편과 함께 토큰으로 교체(ADR-0031). 키보드가 열리면 토큰이 0이 되어 액션 바가 입력바에 붙는 동작도 따라온다 |
| Android 하드웨어 뒤로가기가 루트에서 앱을 닫지 못함 | 프론트 진단 P2 | 네이티브 셸 사용자 한정 |
| `/devices`에서 권한 없는 구성원에게 폐기·재발급 메뉴 노출 | 프론트 진단 P2 | 서버가 권한을 막고 있어 데이터 사고는 아니다. 마법사 개편(S3)에서 같은 다이얼로그를 만지므로 그때 함께 |
| SSE 힌트 무효화 범위에 결제 실패·가맹점·카드 누락 | 프론트 진단 P2 | 새로고침으로 복구된다 |
| 취소 연결 후보를 "최근 승인 100건"에서만 탐색 | 프론트 진단 P2 | S2에서 취소 도메인 서비스를 공통화하므로 그 위에서 다시 판단 |
| 딥링크로 열 수 없는 거래를 열면 무반응 | 프론트 진단 P2 | 남아 있다. 거래 상세 폴백(403/404)에서 조용히 목록에 머무는 동작 — IA 개편 때 화면을 열지 않아 손대지 않았다 |
| ~~터치 타깃 44px 불일치 · `PageBackHeader` 뒤로가기 `/more` 고정 · `useSearchParams` Suspense 경계 불일치~~ **(2026-08-10 처리됨)** | 프론트 진단 P2 | IA 개편 배치에서 함께 정리(ADR-0031). 뒤로가기는 `lib/nav-history.ts`로 "온 길"과 "딥링크로 연 화면"을 구분한다. 44px은 **만진 화면 안에서만** — 전면 스윕은 하지 않았다 |

### 5-3. P3 · 디자인 시스템 부채

| 항목 | 근거 |
|---|---|
| 모바일 `trailingSlash: true`와 알림 딥링크 경로 표기 불일치 `[가설]` · `/budgets` 전월 예산 이중 조회 · `/declines` React key 충돌 가능 · `/ai` 대화 내역 휘발 | 프론트 진단 P3 |
| ~~빈 상태 마크업 4종~~ **(2026-08-10 처리됨)** | `apps/web/src/components/widgets/empty-state.tsx`로 승격. 홈·카드·가족·예산이 그것을 쓴다(ADR-0031) |
| 페이지 헤더 3종 (`PageBackHeader` / `sr-only h1` / 일반 `h1`) · 파괴적 확인 버튼 배치 2종 · 월 선택 인터랙션 2종(`MonthSwitcher` vs 필터칩) | 디자인 진단 D-2 |
| `components/ui`에 checkbox 프리미티브 부재로 원시 `<input type="checkbox">` 사용 | `apps/web/src/app/(app)/transactions/page.tsx:1392` · `apps/web/src/app/join/page.tsx:146` |
| 하드코딩 색상 4곳(`text-amber-600`, `bg-destructive text-white` 2곳, `member-color.ts` 팔레트) — 토큰 우회 | `apps/web/src/app/(app)/cards/page.tsx:596` 외 |
| 버튼 라벨·로딩 문구·종결어미 불일치 (`저장하기`/`저장`, `불러오는 중…`/`불러오고 있어요…` 5종, 합쇼체 혼재) | 디자인 진단 C-2·C-3·C-5 |
| ~~`/budgets`만 월 선택을 URL에 저장하지 않음~~ **(2026-08-10 처리됨)** | 홈·거래와 같이 `?month=`가 소유한다. 월 원장(ADR-0030) 이후로는 "어느 달의 계획인가"가 화면의 주제라 리셋이 더 어긋났다 |

**공통 이유**: 위 항목들은 개별 공수가 작지만 **각각 배포하면 리뷰·회귀 비용이 본체보다 크다.** S4 이후 IA 개편에 묶어 한 번에 처리하되, 해당 화면을 다른 이유로 여는 스프린트가 있으면 그때 함께 정리한다(예: S3의 마법사 작업 중 `/devices` 문구·권한 메뉴).

---

## 6. 리포트 간 관점 차이와 열린 질문

### 6-1. 판단이 갈린 지점 (숨기지 않고 남긴다)

| # | 쟁점 | PO 진단 | 디자인 진단 | 이 로드맵의 선택 |
|---|---|---|---|---|
| 1 | 카드 문자 파싱·검토의 완성도 | **완전** — 규칙·템플릿·LLM·격리·수동 검토 캐스케이드가 모두 있다 | 3일 창 밖 문자는 **앱에서 영영 사라진다**(진입점 0개) | **부분**으로 내림. 기능 존재(PO)와 사용자 도달성(디자인)을 함께 보면 후자가 결정적이다. 데이터 진단의 P0-7(검토 취소 미상계)도 같은 방향 |
| 2 | 예산 탭의 지위 | 예산을 **월 버전 원장**으로 강화 (핵심 재무 기록) | 예산 탭을 하단 탭에서 내리고 `/more`로 (홈 카드와 중복, 뷰어에겐 읽기 전용) | **데이터 모델 강화만 채택**(S4), 탭 위치 변경은 IA 개편으로 보류. 둘은 모순이 아니라 다른 층위지만, 같은 스프린트에 하면 "예산이 사라졌다"로 읽힌다 |
| 3 | AI 첫 화면 | "무엇이든 물어보세요"는 **거짓 약속** — 미분류 질문에 총지출로 답한다 | AI 빈 상태를 **"좋음"**으로 평가 (추천 질문 4개 존재) | 같은 화면을 정확성(PO)과 빈 상태 UX(디자인)라는 다른 축으로 본 것이다. **카피만 좁히고 추천 질문 구조는 유지**(S4) |
| 4 | 첫 가치의 관문 | 장치 등록 후 **설정 마법사**가 관문 | 그 앞에서 **홈에 다음 행동이 없는 것**이 더 큰 마찰 | 하나의 콘셉트(C-1·C-2)로 병합하고 **순서는 마법사 → 체크리스트**. 체크리스트가 먼저 나오면 막다른 길로 안내한다 |
| 5 | Slack·기억 자산의 우선순위 | 8주 안(원안 Sprint 4)에 최소 제품으로 개방 — 가장 짧은 차별화 경로 | to-be IA에 해당 표면이 아예 없음 — 그 자리는 "할 일" 탭 | **둘 다 8주 밖으로 보류.** P0 11건이 용량을 가져갔다. 차별화보다 "지금 매일 쓰는 화면의 금액이 맞는가"가 먼저다 |

**서로 보강한 지점**: 백엔드와 데이터 진단이 **독립적으로** 알림 유실을 발견하고 같은 해법(transactional outbox)에 도달했다(P1-13). 서로 다른 코드 경로를 봤는데 결론이 같다는 점에서 확신도가 높아, S4에 넣되 자르기 순서 1번으로 두지 않았다.

### 6-2. 열린 질문

| # | 질문 | 왜 중요한가 | 확인 방법 |
|---|---|---|---|
| 1 | 프로덕션 `AUTH_REGISTRATION_MODE`의 실제 값 | `invite`면 `/login`의 "회원가입하기" 링크가 사용자를 **영문 403 막다른 길**로 보낸다(`apps/api/src/auth/auth.service.ts:505` → `register/page.tsx:66`). 코드 기본값은 `invite`(`packages/config/src/config.ts:188`), dev `.env`는 `open`, 운영은 `env_file` 참조라 저장소에서 확인 불가 `[가설]` | 운영 환경 변수 확인 후, `invite`면 S1의 웹 묶음에 링크 문구 교체를 추가 |
| 2 | 장치 등록→첫 문자 수신 전환율의 실제 수치 | 이 로드맵이 활성화를 최우선으로 놓은 근거가 정적 코드 분석뿐이다. 전환율이 이미 높다면 S3보다 S4(기록 신뢰)를 앞당기는 게 맞다 | S3 DoD의 이벤트 수집이 시작되면 확정. **그 전까지 이 순서는 `[가설]`이다** |
| 3 | 기존 사용자 초대 비중 | C-1(합류 여정)의 Reach 5는 "기존 계정 초대가 흔하다"를 전제한다 | 초대 수락 로그에서 신규 가입 경로 vs 기존 로그인 경로 비율 |
| 4 | 3개월 주기 판별이 가능한 거래량을 가진 가구 비율 | C-5(정기 지출 Radar)의 Confidence 4 근거 | 가구별 월 거래 건수 분포 |
| 5 | 외부 자동화 템플릿(iOS 단축어·MacroDroid)이 OS·앱 업데이트를 견디는가 | C-2의 최대 위험. 견디지 못하면 템플릿 버전 관리와 서버 호환 계층이 추가로 필요하다 | S3에서 실제 템플릿을 만든 뒤 두 OS의 다음 마이너 업데이트에서 재검증 |

---

## 부록: 용어

- **드리프트**: 코드가 존재하고 동작하지만, PRD/Phase가 약속한 것과 **다르게** 동작하는 상태. 미구현보다 신뢰를 크게 깎는다(1-2 참조).
- **P0**: 개인정보·테넌트 경계 위반, 데이터 유실, 화면 크래시, 또는 사용자에게 보이는 금액을 직접 틀리게 만드는 결함.
- **공수**: S = 1시간~1일, M = 반나절~수일, L = 1일 이상 또는 마이그레이션·계약 변경 동반.
- **`[가설]`**: 정적 진단으로 확증하지 못한 추정. 운영 데이터나 실행 검증이 필요하다.
