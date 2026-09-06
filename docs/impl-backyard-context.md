# 뒷마당 구현 컨텍스트 — 이미 확인된 사실 (2026-09-06)

> **이 문서의 목적은 재유도를 막는 것이다.** 아래는 앞선 워커들이 실제로 측정·확인한 값이다.
> 다시 `git show`·`wc -c`·`cat package.json`으로 재지 마라. 필요하면 이 표를 인용하라.
> 값이 틀렸다고 의심되면 그때만 재측정하고, 이 문서를 고쳐라.

## 환경

| 항목 | 값 | 출처 |
|---|---|---|
| 패키지 매니저 | `pnpm@9.15.4` | 루트 `package.json` |
| Node | `v22.23.1` | `node -p process.version` |
| Next | `16.2.10` | `apps/web/node_modules` |
| 웹 Vitest | `4.1.10` | 동일 |
| 웹 테스트 검색 | `src/**/*.test.ts`, 기본 Node 환경 | `apps/web/vitest.config.ts` |
| 모바일 빌드 | `pnpm --filter @family/web build:mobile` (`BUILD_TARGET=mobile`, `output: export`, `trailingSlash: true`) | `next.config.ts` |
| OTA 입력 | `apps/web/out` 안에서 `zip -qr ZIP .` | `scripts/ops/deploy-ota-bundle.sh` |
| 네이티브 입력 | `webDir: '../web/out'` | `apps/mobile/capacitor.config.ts` |

## 크기 기준값 (슬라이스 7의 비교 대상)

| 측정 | 값 |
|---|---:|
| `apps/web/out/` 일반 파일 293개 raw 합계 | 3,864,248 B |
| 같은 out의 ZIP | **1,123,874 B** |
| (참고) Phaser UMD를 넣었을 때 ZIP 증가 | +354,712 B = **+31.56%** |

Phaser는 이 수치 때문에 기각됐다. canvas 2D로 간다. 엔진 재조사 금지.

## 저장 상한 — 두 겹이다

| 층 | 검사 | 값 |
|---|---|---|
| API | `Buffer.byteLength(JSON.stringify(state))` | 8192 |
| DB | `pg_column_size(state)` CHECK | 8192 |

**raw만 보면 안 된다.** 슬라이스 5 실측: raw 8192B padding fixture가 API를 통과한 뒤
DB CHECK에서 거절됐다.

## 실측된 게임 DTO 크기

| fixture | raw | 비고 |
|---|---:|---|
| 초기 | 114 B | |
| 9생산+7비생산 | 270 B | 설계서 손계산 ~265B와 일치 |
| 16생산 | 342 B | |
| 안전정수최대+3종해금 | **469 B** | 최대. `pg_column_size` **548 B** |

8192B의 5.7%. **저장은 이 게임의 제약이 아니다.**

## 확정 밸런스 — 조정 금지

| 항목 | 값 |
|---|---|
| 마당 | 4×4 = 16칸 |
| 시작 | 이미 익은 화분 **3개**, 열매 0, `n=0`, 칸 0·1·2, `k=['p','w']` |
| 화분 가격 | `3,4,6,8,11,14,18,22,27,32,38,44,51,58,66,74` (16개 배열) |
| 우물 / 의자 | 15 / 4 |
| 성장 | 10800초 (우물 인접 시 8100초) |
| 수확량 | 열매 1 |
| 해금 | 화분 3개 배치→우물, 우물 배치→의자 |

`readyAt`은 자라기 시작할 때 **한 번만** 확정. 이웃이 바뀌어도 다시 쓰지 않는다.
회수 = 원자적 이동, 점유 칸이면 swap. 보관·인벤토리·환불 없음.

## 완성된 것 (건드리지 마라)

| 파일 | 상태 |
|---|---|
| `public/miniapps/backyard/{balance,rules,codec,session}.js` | 테스트로 고정. **수정 금지** |
| `public/miniapps/bridge.js` | 슬라이스 5에서 handshake 세대 경쟁 수정됨 |
| `packages/shared/src/miniapp-bridge.ts` + 테스트 | 복원 완료 |
| `src/components/miniapp/miniapp-host.tsx`, `src/lib/miniapp-host.ts` | 복원 완료 |
| `src/lib/miniapp-registry.ts` | `backyard` 등록됨 (`height: 470`, `permissions: []`) |
| `src/app/(app)/play/{page,app/page}.tsx` | 쿼리 파라미터 방식 |

테스트 **138개** 통과 상태다(7 files). 이 숫자가 줄면 회귀다.

## 저장소 함정 — 이미 당한 것들

| 함정 | 내용 |
|---|---|
| `output: export` | 동적 라우트 불가. `[key]` 금지, 쿼리 파라미터 + Suspense (`055bc45`) |
| `packages/shared` | DOM 타입 쓰면 `typecheck`는 통과하고 `build:packages`가 터진다 |
| `build:packages` | `FULL TURBO`(캐시) 통과는 검증이 아니다. `--force --concurrency=2` |
| `\| tail` | vitest를 EPIPE로 죽여 **없던 실패를 만든다.** 출력은 파일로 |
| `pnpm test` 병렬 | turbo 경합으로 무작위 패키지 실패. `--concurrency=1 --force` |
| `apps/web/public/` | 정적 export·OTA 번들에 그대로 실려 **폰으로 내려간다** |
| 운영 스택 | `docker-compose.prod.yml` 12개 컨테이너가 실사용자 데이터. **쓰기 금지** |
| 격리 검증 | `scripts/verify-play-state-isolated.mjs` 참고. DB 이름은 가드가 정한 형식만 |

## 문서 지도 — 필요한 것만 읽어라

| 문서 | 언제 읽나 |
|---|---|
| `impl-backyard-v0.md` | **구현 계약.** §5(파일·인터페이스) §6(저장) §7(슬라이스) |
| `design-tycoon-game-2026-09.md` | 왜 그런 규칙인지 근거가 필요할 때. §8(아트) |
| `impl-backyard-s4-report.md` | 직전 상태 |
| `verify-sandbox-engine-2026-09.md` | CORS 제약 확인용 (요약: `<script src>` 가능, XHR/fetch 불가, 이미지 0개) |
| `research-game-library-2026-09.md` | **읽지 마라.** 엔진은 canvas로 결정됨 |
