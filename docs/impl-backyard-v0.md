# 뒷마당 v0 구현 설계

작성일: 2026-09-06. 상태: 구현 전 설계 완료, 제품 코드 작성·복원·배포 없음.

**canvas 2D를 채택한다. 호스트 복원과 실기기 검증을 포함한 8개 슬라이스로 구현한다.** 게임은 4×4 마당, 화분·우물·의자, 열매 하나, 절대시각 성장, 권한 0개, 가구 공동 저장을 유지한다. 규칙은 순수 JS이고 canvas는 표현만 담당한다.

## 1. 근거와 확인 범위

다음을 지시 순서대로 전부 읽었다.

1. [게임 설계](design-tycoon-game-2026-09.md)
2. [sandbox 실행 검증](verify-sandbox-engine-2026-09.md)
3. [엔진 조사](research-game-library-2026-09.md)
4. [구현 지시서와 확정 부록](impl-backyard-brief.md)

현재 HEAD는 `feb1201728570409c1378f194a3d13dc812c1eb4`다. 삭제 내역은 `git show --stat b88588a`, 복원 후보 원문은 `git show b88588a^:<path>`, 라우팅 사고는 `git show 055bc45`로 확인했다. 현재 `apps/web/package.json`, `apps/web/vitest.config.ts`, `apps/web/next.config.ts`, `packages/shared/{package.json,tsconfig.json,tsup.config.ts}`, API·계약·DB 스키마도 확인했다.

| 확인 대상 | 실제 확인값·경로 |
|---|---|
| 패키지 매니저 | 루트 `package.json`: `pnpm@9.15.4` |
| 실행 Node | `node -p process.version`: `v22.23.1` |
| 설치된 Next / 웹 Vitest | 각 `apps/web/node_modules/.../package.json`: `16.2.10` / `4.1.10` |
| 웹 테스트 검색 | `apps/web/vitest.config.ts`: `src/**/*.test.ts`, 기본 Node 환경 |
| 모바일 빌드 | `pnpm --filter @family/web build:mobile`; `BUILD_TARGET=mobile`, `output: export`, `trailingSlash: true` |
| OTA 입력 | `scripts/ops/deploy-ota-bundle.sh`: `apps/web/out` 안에서 `zip -qr ZIP .` |
| 네이티브 입력 | `apps/mobile/capacitor.config.ts`: `webDir: '../web/out'` |
| 저장 구현 | `apps/api/src/play/play.service.ts`, `packages/contracts/src/play.ts`, `packages/database/drizzle/0061_play_states.sql` |
| 남은 웹 API 연결 | `apps/web/src/lib/api-client.ts`의 `play`, `queries.ts`의 `usePlayStates`·`useSavePlayState`·`useDeletePlayState` |

이번 작업에서는 기존 로컬 export를 읽고 메모리 안에서 압축 크기를 측정했다. 설계서 외 파일 생성·수정 금지이므로 재빌드하지 않았다. 현재 운영 배포 ZIP 및 로컬 export와 HEAD의 완전한 일치 여부는 **확인 못 함**이다. 실행 검증 보고서의 Chromium 결과를 인용하며 이번에 브라우저·실기기를 다시 실행한 것은 아니다. Memory·context7·sequential-thinking MCP는 현재 도구 목록에 없어 과거 Memory 로드·ADR 저장·학습 기록 및 해당 MCP 분석은 **확인 못 함**이다. 결정 근거와 반복 방지 사항은 이 문서에 남긴다.

## 2. 게임 설계서에서 고친 것

아래 네 가지는 새 제안이 아니라 지시서 부록의 코디네이터 확정 답변이다. 원 게임 설계 파일은 고치지 않는다.

| 항목 | 구현에 적용할 확정값 | 근거와 고정할 테스트 |
|---|---|---|
| 시작 상태 | 이미 익은 화분 **3개**, 열매 0 | 원안 2개는 수확 2 < 첫 가격 3이라 즉시 루프가 안 돈다. 3개 수확→열매 3→화분 구매·배치→열매 0을 테스트한다. 밸런스 상수에 “설계서 원안 2개에서 고친 값”이라는 한국어 주석을 남긴다. |
| 화분 가격 | **3, 4, 6, 8, 11, 14, 18, 22, 27, 32, 38, 44, 51, 58, 66, 74** | 공식으로 추정하지 않고 16개 배열을 둔다. 구매 횟수 `n`을 0 기반 인덱스로 쓴다. 범위 초과는 방어적으로 74를 반환하되 정상 구매로는 초과 인덱스에 도달하지 못함을 테스트한다. |
| 회수 | 선택→새 칸 확정의 **원자적 이동**, 점유 칸이면 **swap** | 보관·인벤토리·환불 없음. 16칸이 차도 재배치할 수 있다. 취소는 상태 무변경, swap은 두 물건과 생산 시각 보존, 저장 요청 한 번을 테스트한다. v0에서 swap을 포함한다. |
| 우물 | 화분 배치 직후·수확 직후에 다음 `readyAt`을 한 번 확정 | `p:칸:익는시각`에는 시작 시각이 없으므로 현재 주기 재계산은 하지 않는다. 우물 이동·화분 이동·swap으로 현재 `readyAt`은 바뀌지 않는다. 다음 주기부터 인접 효과를 적용한다. |

시작 화분은 증정이므로 `n=0`이다. 시작 칸은 0·1·2, `readyAt=nowSec`으로 정한다. 우물 해금의 “화분 3개 놓음” 조건은 시작 배치도 만족하므로 초기 `k=['p','w']`다. 의자는 우물을 실제 구매·배치한 순간 해금한다. `k`는 원 형식대로 해금 이력이며 v0에는 도감 화면을 만들지 않는다. 시작 배치와 구매 횟수를 혼동해 첫 구매가 네 번째 가격 8이 되는 회귀를 금지한다.

원문의 “`game-snake.ts` + 테스트”는 실제 `b88588a^` 트리와 다르다. 당시에는 `game-snake.test.ts` 안에 판정 함수를 복제했고 별도 `game-snake.ts`는 없었다. **이번에는 배포하는 규칙 파일 자체를 테스트**하여 테스트 복제본만 맞는 상황을 없앤다.

원문의 “ACK가 없다”도 구분이 필요하다. 삭제된 호스트는 `state.set`에서 API 저장을 await한 다음 성공 응답을 보냈다. **요청별 성공 응답은 있었고**, 서버 revision·충돌 제어와 게임 측 영속 확인 사용이 없었다. 이를 신규 revision 프로토콜 도입의 근거로 삼지 않는다.

원문의 “API가 먼저 검사하므로 raw만 보면 된다”는 충분조건이 아니다. 실제 DB에는 별도의 `pg_column_size(state) <= 8192` CHECK가 남아 있다. v0는 raw 측정과 DB 왕복을 모두 검증하며, 이 수정은 형식·상한 변경이 아닌 검증 조건 보완이다.

## 3. 엔진 결정 — ADR: canvas 2D

### 3.1 OTA 크기 실측

`public/`에 엔진을 넣으면 게임에 진입하지 않은 휴대폰에도 OTA ZIP으로 내려간다. JS 청크의 초기 로드 여부와 OTA 전체 다운로드는 다른 문제다.

| 측정 대상 | 바이트 | 의미 |
|---|---:|---|
| 기존 `apps/web/out/` 일반 파일 293개 합계 | 3,864,248 | 디스크 블록이 아닌 실제 파일 길이 합계 |
| 기존 out를 `zip -qr - .`로 압축 | **1,123,874** | OTA와 같은 Info-ZIP 기본 압축, 결과를 stdout으로 받아 메모리에 보관 |
| Phaser UMD 원본 | **1,375,976** | `scripts/verify-sandbox-engine/vendor/phaser.min.js` |
| 같은 UMD gzip level 9, mtime 0 | **352,441** | 조사 결과와 일치, OTA 압축률 계산에 대신 쓰지 않음 |
| ZIP에 엔진 엔트리 추가 증가 | **354,712** | 메모리 ZIP에 `miniapps/vendor/phaser.min.js`를 DEFLATE level 6으로 추가한 결과 |
| 엔진 추가 후 ZIP | **1,478,586** | 엔진 한 파일만 추가한 비교; 새 게임·호스트 코드 미포함 |
| ZIP 증가율 | **31.56%** | `354712 / 1123874 × 100` |
| raw 증가율 | **35.61%** | `1375976 / 3864248 × 100` |

측정한 엔진은 선행 검증의 **Phaser 4.2.1** 고정 배포물이며 SHA-256은 `66348b1b5141e49b7d5ebbe688cddcb502eab1cb00f21c538686a5b2c5abe4de`로 재확인했다. 최신 버전을 새로 선정한 작업이 아니다.

재현 방법: Python `pathlib.Path.rglob`로 일반 파일 크기를 합하고, `subprocess.run(['zip','-qr','-','.'], cwd='apps/web/out', stdout=PIPE)`의 결과 길이를 잰다. 그 바이트를 `io.BytesIO`로 열어 `zipfile.ZipFile(...,'a', compression=ZIP_DEFLATED, compresslevel=6)`으로 위 엔진 경로를 추가하고 전후 길이를 비교한다. gzip은 같은 원본에 `gzip.compress(..., compresslevel=9, mtime=0)`를 적용했다. 측정용 파일은 쓰지 않았다.

추가 ZIP은 가상 엔트리의 비교 측정이다. 실제 배포 스크립트로 디렉터리 엔트리·시각·추가 필드까지 포함해 재생성한 ZIP과는 메타데이터 수십~수백 바이트가 달라질 수 있다. **실제 엔진 포함 제품 빌드·현재 운영 ZIP은 확인 못 함**이다. 그러나 354KB 전후 증가가 기존 로컬 OTA의 약 32%라는 결정 근거는 바뀌지 않는다. 선택한 canvas 게임 코드 증가량은 구현 전이라 **확인 못 함**이며 0B로 가정하지 않는다.

### 3.2 왜 지금도 v0.2도 canvas인가

v0 표현은 16칸·도형 3종, 정사각형 히트테스트, 짧은 수확 효과, 익은 물건의 bob이다. 카메라·물리·스프라이트 시트·씬 로딩을 쓰지 않는다. HTML이 HUD와 상점을 맡으므로 엔진 UI 시스템도 필요 없다. 필요한 변환·애니메이션만 작성하는 비용을 택한다.

v0.2의 원문은 **물건 5종 추가**, 즉 총 8종과 6×6=36칸·도감 화면이다. 도형 종류 함수가 늘고 칸 수가 36이 되며 HTML 도감이 추가될 뿐, 이것만으로 엔진 기능 의존성은 생기지 않는다. 36개 순회와 인접 4방향 조회는 구조적으로 단순하다. 실제 프레임 시간·메모리는 **확인 못 함**이며 적은 개수라는 이유로 성능 검증을 면제하지 않는다. 6×6도 4×4의 인덱스를 그대로 읽으면 행/열이 바뀌므로 확장 때 저장 스키마 마이그레이션은 별도 필요하다.

**포기하는 것:** Phaser의 통합 pointer 처리, tween 스케줄러, 텍스처 관리, 씬·카메라·타일맵 도구와 예제를 즉시 쓰는 편의. 대신 DPR 리사이즈, 탭 취소, RAF 수명, 이징·그림자·정렬을 직접 유지한다. 범용 엔진·범용 tween 라이브러리를 자체 제작하지 않는다. 선행 검증은 Phaser가 실행 가능함을 입증했지만, 이 범위에서 필요한 선택이라는 뜻은 아니다.

다수의 움직이는 캐릭터, 여러 씬·카메라, atlas 파이프라인이 실제 요구가 되거나 실측 성능이 목표를 못 맞출 때 엔진을 다시 검토한다. v0.2 자체를 자동 전환 시점으로 예약하지 않는다.

### 3.3 전환 비용의 경계

“행/열만 유지하면 렌더러만 바꾸면 된다”는 **입력·수명주기까지 표현 어댑터에 가둘 때** 맞다. 행/열만 정하고 규칙에서 Canvas·Sprite·픽셀 좌표를 참조하면 맞지 않는다.

| 그대로 남길 것 | 전환 때 교체·재검증할 것 |
|---|---|
| `Garden`·`Action`·경제·인접·시각·튜플 직렬화와 테스트 | `renderer.js`의 그리기·장면 수명·tween |
| 로드 상태 분기·저장 큐·실패 HUD·브릿지 | `input.js`의 pointer→논리 칸 변환과 터치 취소 |
| HTML 상점·완료·저장 문구 | app의 renderer 생성·해제 연결부, 리사이즈·숨김/복귀 연결 |
| 현재 4×4 저장 데이터 | 엔진 동봉 경로·sandbox 실행·OTA 용량·실기기 회귀 검증 |

현재 범위를 그대로 옮기는 작업량은 **표현 파일 2개 + 연결부 + 실행 검증**이다. 일정 예산은 렌더·입력 1일, 수명/연동 1일, 브라우저·실기기 회귀 1일의 **3작업일을 잠정 배정**한다. 실제 전환을 해본 공수는 **확인 못 함**이고, 새로운 NPC·iso 기능 개발은 이 예산 밖이다. iso는 특히 hit-test·깊이 정렬·터치 가림까지 다시 검증한다. “그림 함수만 교체하는 반나절”로 약속하지 않는다.

## 4. 호스트 런타임 복원 계획

경로는 저장소 루트 기준이다. 삭제 커밋 전체를 revert하지 않고 아래 파일·부분만 취한다.

| 파일 | 판정 | 복원·변경 내용 |
|---|---|---|
| `packages/shared/src/miniapp-bridge.ts` | 고쳐서 복원 | 권한/메서드/요청/응답 계약과 검증 순서 유지. 배열 params 거절·응답 판별 추가. DOM 타입·SDK·타이머는 넣지 않음. |
| `packages/shared/src/miniapp-bridge.test.ts` | 고쳐서 복원 | 기존 **24건 전부** 유지하고 배열 params·불량 응답·버전 검사 추가. 기존 24건은 원본의 10행 `it.each`를 포함한 수다. |
| `packages/shared/src/index.ts` | 해당 부분 그대로 복원 | 삭제된 bridge 값/타입 export만 복구; 현재 나머지 export 유지. 새 응답 판별 export 추가. |
| `apps/web/src/components/miniapp/miniapp-host.tsx` | 고쳐서 복원 | sandbox·source·계약·권한 검사 유지. iframe 세대가 바뀐 뒤 이전 비동기 응답을 새 프레임에 보내지 않도록 수신 시 창/세대 캡처. 저장 핸들러 큐는 아래 참조. |
| `apps/web/public/miniapps/bridge.js` | 고쳐서 복원 | get의 catch→null과 set의 catch→무시 모두 제거. 부모 source·버전·응답 스키마 검사, 8초 timeout, ready 대기, 테스트용 팩토리 노출. |
| `apps/web/src/lib/miniapp-sdk.ts` | 원 파일 폐기 | 실행 경로에서 안 쓰이는 TS SDK와 정적 JS 클라이언트의 이중 구현을 없앤다. 팩토리·오류·timeout 책임을 실제 배포 `bridge.js` 한 곳으로 이전. |
| `apps/web/src/lib/miniapp-sdk.test.ts` | 고쳐서 복원·이름 이전 | 기존 **8건 전부**를 `miniapp-client.test.ts`로 옮겨 실제 bridge.js에 실행. 정상 2·짝짓기 2·오류 4의 의미 유지, 가짜 이벤트에 source 추가. |
| `apps/web/src/lib/miniapp-registry.ts` | 고쳐서 복원 | manifest 타입·findMiniapp 유지. 삭제된 4개 게임 등록을 복구하지 않고 backyard 하나 등록. |
| `apps/web/src/app/(app)/play/app/page.tsx` | 고쳐서 복원 | 쿼리+Suspense 유지. 상태 API 연결 유지, merchant handler 제거, 가구 준비 전 iframe 미마운트, 가구/앱 변경 시 호스트 세대 재생성. 주석의 오래된 `[key]` 표기 수정. |
| `apps/web/src/app/(app)/play/page.tsx` | 고쳐서 복원 | MINIAPPS 기반 목록만 복원. 지출 정보성 화면 ITEMS·설명 제거. |
| `apps/web/src/app/(app)/more/page.tsx` | 고쳐서 부분 복원 | `/play` 링크를 “뒷마당 / 함께 작은 마당을 꾸며요”로 노출. “지출로 보기” 문구 복원하지 않음. |
| `apps/web/src/lib/nav-tabs.ts` | 해당 부분 그대로 복원 | ACCOUNT_PATHS에 `/play`를 다시 넣어 더보기 탭 선택을 유지. |

관련 없는 삭제물의 판정도 명시한다. 아래는 **복원하지 않는다**. 각 목록은 실제 b88588a 삭제 경로다.

| 파일 | 이유 |
|---|---|
| `apps/web/public/miniapps/2048/index.html` | 기존 게임 콘텐츠는 v0 대상 아님 |
| `apps/web/public/miniapps/snake/index.html` | 동일 |
| `apps/web/public/miniapps/memory/index.html` | 동일 |
| `apps/web/public/miniapps/spend-quiz/index.html` | 동일, 지출 데이터도 미사용 |
| `apps/web/src/app/(app)/play/atlas/page.tsx` | 지출 정보성 화면 |
| `apps/web/src/app/(app)/play/forecast/page.tsx` | 지출 정보성 화면 |
| `apps/web/src/app/(app)/play/pace/page.tsx` | 지출 정보성 화면 |
| `apps/web/src/app/(app)/play/rhythm/page.tsx` | 지출 정보성 화면 |
| `apps/web/src/lib/atlas.ts`, `atlas.test.ts` | 위 화면 전용 계산·테스트 |
| `apps/web/src/lib/forecast.ts`, `forecast.test.ts` | 위 화면 전용 계산·테스트 |
| `apps/web/src/lib/pace.ts`, `pace.test.ts` | 위 화면 전용 계산·테스트 |
| `apps/web/src/lib/rhythm.ts`, `rhythm.test.ts` | 위 화면 전용 계산·테스트 |
| `apps/web/src/lib/game-2048.test.ts` | 이전 게임 판정 복제 테스트 |
| `apps/web/src/lib/game-snake.test.ts` | 이전 게임·기억력 카드 판정 복제 테스트 |

요구된 런타임 테스트 **32건=bridge 24+SDK 8**은 모두 보존·이전한다. 다른 게임 테스트까지 합친 삭제 커밋의 전체 테스트 수와 혼동하지 않는다. 새 테스트를 더하므로 최종 런타임 테스트는 32건보다 많다. 이번 설계 작업에서 테스트를 복원하거나 실행하지는 않았다.

등록 항목은 `key: 'backyard'`, `name: '뒷마당'`, `description: '함께 작은 마당을 꾸며요'`, `entry: '/miniapps/backyard/index.html'`, `permissions: []`, **`height: 470`**으로 확정한다. 진입은 `/more`→`/play`→`/play/app?key=backyard`이며 모바일 trailing slash가 붙은 `/play/app/?key=backyard`도 유지된다. `[key]` 동적 폴더는 만들지 않는다. `055bc45`가 고친 `useSearchParams`의 Suspense 경계를 유지한다. 성공 기준은 웹 dev 접속만이 아니라 `build:mobile` 후 `out/play/app/index.html` 및 `out/miniapps/backyard/index.html` 존재다.

### 브릿지와 저장 핸들러의 수정 계약

- `MiniApp.state.get(key: string): Promise<unknown | null>`: 정상 응답의 `{state: null}`만 null로 반환. 데이터 필드 누락·잘못된 응답·host_error·timeout은 reject한다. `res?.state ?? null`로 필드 누락을 신규로 간주하지 않는다.
- `MiniApp.state.set(key: string, value: GardenSaveV1): Promise<void>`: 호스트의 저장 완료 응답을 확인하면 resolve, 실패하면 reject. 재시도와 HUD는 게임 session이 담당한다.
- 기존 `{v,kind,requestId,ok,data/error}` 형식과 8초 제한을 유지한다. 자식은 `event.source===parent`를 확인한다. 부모는 기존 iframe source 검사에 세대 확인을 추가하고 permissions는 등록부 값만 사용한다.
- 문서 로딩 중 bridge가 먼저 ready 리스너를 등록한다. ready를 기록하여 app이 늦게 구독해도 읽는다. ready 대기가 8초를 넘으면 로드 실패 화면으로 끝내며 사용자의 “다시”가 handshake/로드를 재시도한다. 늦은 이전 로드 응답은 세대 번호로 무시한다.
- `state.get`은 성공한 `api.play.list`에서 해당 key가 없는 경우에만 `{state:null}`로 응답한다. 인증·가구 준비 실패를 빈 목록으로 바꾸지 않는다. `appKey`와 `householdId`는 호스트 컨텍스트에서 정하고 자식 params로 받지 않는다.
- 원본처럼 `state.set`은 `api.play.save` 완료를 await한 뒤 응답한다. 브릿지의 timeout이 부모 HTTP 처리를 취소했다는 뜻은 아니다. **동일 호스트 세대·가구·앱·state_key의 PUT은 부모에서도 직렬 큐로 실행**한다. 자식에서 timeout 후 재전송해도 이미 실행 중인 오래된 PUT이 최신 PUT 뒤에서 끝나는 일반적인 역전 경로를 줄인다. 큐의 작업은 각자 Promise와 requestId에 응답하며 앞 작업 실패가 큐 전체를 깨지 않게 한다.
- 부모 API 자체가 결과 불명 상태로 종료한 뒤 서버가 늦게 커밋하거나, 서로 다른 호스트/기기가 동시에 저장하는 경우까지 순서를 보장하지는 않는다. 서버 revision/CAS 없이 보장할 수 없고 v0는 마지막 쓰기 우선 한계를 유지한다. 이를 “완전한 멱등 저장”이라고 부르지 않는다.
- optional `updatedAt` 전달·badge·lastChangedBy·presence는 이번 필수 복원에서 제외한다. 데이터 형식에 revision·sessionId를 추가하지 않는다. 요청 ID와 세대·로컬 순번은 메모리에만 둔다.

## 5. 파일 구성과 모듈 경계

아래는 **향후 구현할 경로**이며 이 설계 작업에서는 만들지 않는다.

| 경로 | 책임·노출 계약 |
|---|---|
| `apps/web/public/miniapps/backyard/index.html` | canvas, HTML HUD·상점·로드/오류 화면, 시스템 한글 폰트, 정적 script 순서 |
| `apps/web/public/miniapps/backyard/style.css` | 470px 내부 배치, 팔레트 6~8색, 터치 타겟·상태 문구 |
| `apps/web/public/miniapps/backyard/balance.js` | 4×4, 시작 화분 3, 가격 16개, 우물 15·의자 4, 10800초·8100초·수확량 1의 단일 출처 |
| `apps/web/public/miniapps/backyard/rules.js` | **순수 규칙 원본**: 초기화·격자·인접·구매배치·수확·이동/swap·해금·완료 |
| `apps/web/public/miniapps/backyard/codec.js` | **순수 저장 원본**: DTO와 튜플 검증·직렬화/역직렬화 |
| `apps/web/public/miniapps/backyard/session.js` | 엔진·DOM 없는 로드 상태 기계·저장 큐, 주입된 bridge/clock/timer를 사용 |
| `apps/web/public/miniapps/backyard/renderer.js` | canvas 도형·그림자·성장/익음·bob·짧은 수확 tween·DPR |
| `apps/web/public/miniapps/backyard/input.js` | CSS 픽셀→논리 칸, 탭 취소·선택 모드, Action 생성 |
| `apps/web/public/miniapps/backyard/app.js` | DOM 이벤트·HUD 렌더·session·renderer 조립, 생성/해제 |
| `apps/web/public/miniapps/bridge.js` | 공용 실제 통신 클라이언트, §4 |
| `apps/web/src/lib/game-backyard.test.ts` | 실제 balance/rules 파일로 순수 규칙 검증 |
| `apps/web/src/lib/game-backyard-codec.test.ts` | 실제 codec 왕복·부분 손상·상한 검증 |
| `apps/web/src/lib/game-backyard-session.test.ts` | 실제 session의 로드·즉시 저장·백오프·늦은 응답·해제 검증 |
| `apps/web/src/lib/miniapp-client.test.ts` | bridge 실제 배포 JS로 이전 SDK 8건과 오류 회귀 검증 |
| `apps/web/src/lib/miniapp-host.test.ts` | 복원 호스트의 source·세대·가구 경계와 저장 큐 검증; 필요 시 핸들러를 DOM 없는 web lib로 분리하여 테스트 |

`balance/rules/codec/session`은 일반 JS 팩토리/IIFE로 각각 명시적 이름 공간에 API만 노출한다. 규칙 계산 자체는 DOM·Date.now·Math.random·엔진·스토리지 접근을 하지 않는다. 시각·시드는 호출자가 주입한다. 전역 등록 외 부팅 부작용이 없는 팩토리로 만든다. public의 기존 일반 script 관례를 따르며 **별도 번들러·복제된 TS 규칙 파일을 만들지 않는다**.

테스트는 `node:fs`로 위 실제 파일을 읽고 `node:vm`의 격리 context에서 순서대로 평가하여 팩토리 결과를 검사한다. 브라우저 팩토리에는 최소한의 가짜 window·timer·message source를 주입한다. 규칙 파일을 테스트 안에서 재작성하지 않는다. 공개 JS API는 한국어 JSDoc `@typedef`, `@param`, `@returns`와 `// @ts-check`를 사용하고 `any`는 쓰지 않는다. 구현 단계에서 전용 JS 검사 tsconfig를 **apps/web 안**에 마련하여 순수 파일은 ES 라이브러리만, DOM 파일은 DOM 라이브러리로 검사한다. 기존 전체 웹 typecheck만으로 public JS가 검사된다고 가정하지 않는다.

로딩 순서는 일반 `defer` script로 `../bridge.js`→`balance.js`→`rules.js`→`codec.js`→`session.js`→`renderer.js`→`input.js`→`app.js`다. `type="module"`, dynamic import, fetch/XHR JSON 로더를 쓰지 않는다. 정적 상수도 script 데이터로 제공한다. `<script src>`의 선행 통과 결과와 XHR/CORS 실패를 구분한다. CSS도 동봉하며 실제 WebView scheme에서 로딩은 슬라이스 8의 검증 대상이다. 외부 이미지·폰트·엔진 CDN 의존성은 없다.

`packages/shared`에는 브릿지 **순수 계약만** 둔다. Window·EventListener·Canvas·TextEncoder에 의존하는 브라우저 코드와 SDK는 모두 web에 남긴다. shared의 tsup DTS 빌드를 포함한 `pnpm build:packages`를 필수 게이트로 삼는다.

### 규칙 및 표현 인터페이스

시그니처 표기는 설계 계약이며 실행 코드는 아니다.

- `createInitialGarden(nowSec: number, seed: number): Garden`
- `potPrice(purchasedCount: number): number`
- `applyAction(garden: Garden, action: Action, nowSec: number): ActionResult`
- `serializeGarden(garden: Garden, savedAtSec: number): SerializeResult`
- `deserializeGarden(raw: unknown): DeserializeResult`
- 표현 어댑터: `render(garden: Garden, view: ViewState, nowSec: number): void`, `hitTest(clientX: number, clientY: number): Cell | null`, `resize(): void`, `destroy(): void`.

`Cell`은 `{row:number,col:number}`로 각 값 0~3이다. 저장할 때만 `row*4+col`로 변환한다. `Garden`은 `lastSavedAtSec`, `seed`, `fruit`, `purchasedPots`, `unlocked`, `placements`의 명시적 타입을 가진다. 배치는 `kind:'p'`이면 Cell과 `readyAtSec`, `'w'|'c'`이면 Cell만 가진 판별 유니온이다. 엔진 ID·화면 픽셀·선택·타이머는 없다.

`Action`은 `harvest(cell)`, `buyAndPlace(kind,cell)`, `move(from,to)`다. 구매 버튼은 메모리 선택만 바꾸고 빈 칸 확정 때 지불·배치·구매 횟수·해금을 한 번에 변경한다. 구매와 배치를 따로 저장하여 돈만 빠진 상태를 만들지 않는다. 잘못된 칸·점유 구매·미해금·자원 부족·미성숙 수확·빈 출발 칸은 명시적 오류 결과, 상태 무변경이다. 같은 칸으로 이동은 no-op이며 저장하지 않는다. 성공 결과만 새 불변 상태와 표시용 이벤트를 반환한다.

우물 인접은 상하좌우 하나 이상이면 25% 단축, 중첩하지 않는다. 3번 칸과 4번 칸을 인접으로 계산하지 않는다. 수확 시점이 readyAt 이상일 때만 열매 1을 주며 장기간 경과 배수를 주지 않는다. `effectiveNow=max(nowSec,lastSavedAtSec)`로 역행 경과를 0으로 취급하고 기존 readyAt을 다시 쓰지 않는다. 새 주기와 저장 t에도 역행하지 않는 effectiveNow를 사용한다. 표시용 RAF의 delta를 경제 시간에 누적하지 않는다.

상점 해금은 화분 3개 배치→우물, 우물 배치→의자이며 `k`는 단조 증가한다. 완료는 16칸 점유와 세 종류 해금을 만족하면 계산하고 별도 저장 필드를 추가하지 않는다. 완료 UI를 닫아 계속 재배치할 수 있다. 이동 선택은 HTML “옮기기” 모드로 일반 익은 화분 탭 수확과 구별하고, 대상 칸이 점유되면 swap 미리보기를 표시한다. 좌표 경계·pointercancel·스크롤 동작은 Action을 발생시키지 않는다.

## 6. 저장 계약과 실패를 구분하는 구조

### 6.1 DTO와 함수 결과

저장은 `app_key='backyard'`, `state_key='garden'` 한 키다. 바깥 값은 **JSON 문자열이 아니라 객체**이며 배열 `p`의 각 원소만 튜플 문자열이다. `MiniApp.state.set('garden', dto)`에 넘긴다.

| 타입/필드 | 계약 |
|---|---|
| `GardenSaveV1` | 정확히 `v,t,s,f,n,k,p`를 출력하는 plain object |
| `v` | 리터럴 1 |
| `t` | 음이 아닌 안전한 정수 epoch seconds |
| `s` | 0~4294967295 정수 시드 |
| `f` | 음이 아닌 안전한 정수; 수확 결과가 안전 정수 범위를 넘으면 오류로 무변경 |
| `n` | 0~16 정수, 구매한 화분 누계. 시작 화분은 제외 |
| `k` | 중복 없는 `('p'\|'w'\|'c')[]`, 순서 p,w,c로 정규화 |
| `p` | `string[]`, 최대 16개; `p:cell:readyAt`, `w:cell`, `c:cell` |
| `SerializeResult` | `{status:'ok', value:GardenSaveV1}` 또는 `{status:'invalid_state', issues:Issue[]}` |
| `DeserializeResult` | `{status:'ok', garden:Garden, warnings:TupleIssue[]}` 또는 `{status:'unsupported_version', version:unknown}` 또는 `{status:'invalid_state', issues:Issue[]}` |
| `TupleIssue` | 원소 index와 명시적 reason; UI에는 “일부 물건을 복원하지 못했어요”로 표시 |

`deserializeGarden`은 **null을 신규로 처리하지 않는다**. 신규 판단은 성공한 네트워크 읽기의 상위 분기만 한다. codec에 null이 직접 들어오면 invalid_state다. 모든 숫자는 NaN/Infinity·소수·음수·안전 정수 범위 초과를 거절한다. JSON 객체에 v가 없으면 invalid_state, v가 있으나 1이 아니면 unsupported_version이다. 필수 스칼라·k·p의 컨테이너가 틀리면 초기값으로 채우지 않고 invalid_state다. 정상 범위의 손상 데이터라도 규칙이 요구하는 구조를 벗어나면 오류에 이유를 남긴다.

직렬화는 새 객체를 생성하고 칸 인덱스 오름차순으로 튜플을 출력한다. 입력 객체를 변경하지 않는다. 역직렬화는 유효한 저장을 Garden으로 바꾸고 경고가 있어도 남은 요소를 살린다. `t`는 `max(garden.lastSavedAtSec, savedAtSec)`이며 저장 성공 전후의 로컬 dirty 상태와 혼동하지 않는다. 고정 시각으로 serialize→deserialize→serialize 한 결과가 같아야 한다.

### 6.2 로드 실패가 신규 저장으로 갈 수 없는 분기

session 상태는 `waiting_host | loading | load_error | unsupported_version | invalid_state | playable`의 판별 유니온이다. **Garden과 writer는 playable에만 존재한다.** 다른 상태는 HUD와 다시 시도만 가능하며 Action 전달·자동 저장·visibility 저장·재시도 타이머 생성이 불가능하다. 게임 app은 bridge.set을 직접 호출하지 않고 playable session의 dispatch에만 접근한다.

| 읽기 결과 | 다음 상태 | 저장 가능 여부 |
|---|---|---|
| ready 지연·get reject·timeout | load_error, “불러오지 못했어요 · 다시” | 없음. 초기 상태 생성 함수 호출 횟수 0, set 횟수 0 |
| get **성공** + 정확한 null | createInitialGarden→playable | 이 분기에서만 신규 초기 스냅샷을 즉시 저장 |
| get 성공 + 정상 객체 | codec ok→playable | 로드만으로 재저장하지 않고 확정 행동 때 저장 |
| get 성공 + 일부 깨진 튜플 | 남은 Garden으로 playable, 경고 | 자동 청소 저장은 하지 않음. 다음 확정 행동에서 보존한 상태 전체 저장 |
| get 성공 + 알 수 없는 v | unsupported_version, “앱을 업데이트해 주세요” | 없음, 덮어쓰기·초기화 버튼 없음 |
| 응답 필드 누락 또는 상위 상태 손상 | load_error 또는 invalid_state | 없음, 재시도만 가능 |

loading 진입 때 전 로드 세대의 timer·writer를 폐기한다. 사용자가 재시도한 뒤 전 요청이 늦게 끝나도 현재 세대와 다르면 버린다. 빈 마당을 먼저 만들고 나중에 GET 결과로 바꾸는 UI 구조를 금지한다. 브릿지 null 변환 제거와 writer 생성 위치 두 층으로 가장 위험한 덮어쓰기 버그를 막는다.

### 6.3 깨진 튜플을 한 개씩 처리

p 배열은 원본 순서대로 개별 검증한다. 종류별 토큰 개수는 p=3, w/c=2로 엄격하게 확인하고, 정수 토큰은 전체 문자열을 검사한다. `parseInt('1junk')`로 일부만 읽지 않는다. 칸 0~15, readyAt 음이 아닌 안전 정수, 중복 칸 여부를 확인한다.

불량 문자열·배열 안 비문자열·알 수 없는 종류·범위 밖 칸·중복 칸은 **그 요소만** 버린다. 중복 칸은 먼저 나온 유효 요소를 남긴다. 정상 p 원소는 뒤 원소가 깨졌어도 유지한다. 스칼라 f/n/t와 k는 튜플 제거 때문에 초기화하지 않는다. k는 유효 알려진 종류의 이력을 유지하고, 정상 배치에서 증명되는 해금은 보충할 수 있으나 이미 해금된 종류를 지우지 않는다. 16개보다 긴 p 배열은 상위 상태 오류로 차단한다.

모든 튜플이 깨졌다면 빈 placements와 기존 자원·이력을 보존한 손상 복구 결과다. **신규가 아니므로 시작 화분 지급·n 초기화·로드 직후 저장을 하지 않는다.** 자원이 없어 진행이 막히는 손상 상태를 완벽하게 자동 복구하지는 않는다. 경고와 재로드를 제공하고 원격 데이터의 임의 초기화는 v0에 없다.

### 6.4 즉시 저장과 재시도

playable session만 `localSequence`, `ackedSequence`, `latestSnapshot`, `inFlight`, `retryTimer`를 가진다. 이 값은 저장 DTO에 넣지 않는다.

1. 확정 행동 성공 직후 같은 이벤트 흐름에서 스냅샷을 만든다. API 요청이 없으면 즉시 보낸다. 이미 하나 전송 중이면 최신 전체 스냅샷 하나로 pending을 교체한다. 이것은 사용자 입력 debounce가 아니라 앞 요청 완료를 기다리는 직렬화다.
2. 해당 request의 성공 응답이 오면 보낸 순번까지만 acked로 올린다. 더 최신 행동이 있으면 바로 최신 스냅샷을 보낸다. 오래된 ACK가 새 변경의 “저장 안 됨” 표시를 지우면 안 된다.
3. host_error·timeout이면 최신 상태를 유지하고 HUD에 **“저장 안 됨”**을 표시한다. 1·2·4·8·16·30초 후 재시도하고 이후 30초 상한을 유지한다. timer는 하나뿐이다. 다음 확정 행동은 백오프를 취소하고 최신 전체 상태를 즉시 전송 가능 큐에 넣는다.
4. 불량 스키마·버전·권한처럼 반복해도 낫지 않는 오류는 미저장 표시와 명시적 실패 상태를 유지하고 자동 반복을 멈춘다. host_error가 구체적인 영구 오류를 숨기는 현재 계약에서는 30초 간격으로 계속 실패할 수 있는 한계를 기록한다.
5. 숨김 시 dirty이면 보조 flush를 요청하지만 종료 이벤트를 영속성 보장으로 쓰지 않는다. destroy는 RAF·리스너·재시도 timer를 정리하고 이후 UI 갱신을 막는다. 호스트가 이미 시작한 요청은 끝날 수 있다.

실패 중에도 게임은 메모리에서 진행 가능하다. **저장 성공 전에 화면을 닫거나 앱이 죽으면 마지막 미저장 행동은 잃을 수 있다.** sandbox에 로컬 영속 outbox가 없으므로 숨김 이벤트와 무한 재시도로도 이를 없앨 수 없다. 같은 기기의 요청 역전 방지와 두 사람 동시 편집 방지는 별개이며, 후자는 v0 범위 밖이다.

### 6.5 8KB 측정 시점과 방법

**슬라이스 2에서 실제 codec 출력으로 처음 측정**, 슬라이스 5에서 실제 API·DB 왕복으로 확인한다. 설계서의 ~265B를 실측값으로 재인용하지 않는다. 이번 작업에서 구현된 직렬화 결과 크기는 **확인 못 함**이다.

- Node 테스트에서 `Buffer.byteLength(JSON.stringify(dto),'utf8')`를 잰다. 브라우저 송신 직전에는 `TextEncoder().encode(JSON.stringify(dto)).byteLength`를 측정한다. TextEncoder는 web 경계에서만 사용한다.
- 초기 상태, 설계서 예시인 9생산+7비생산, 16생산 최악 배치, 자원·시각이 큰 안전 정수 경계, k 3종 상태를 측정하여 fixture별 실제 B를 테스트 출력으로 남긴다. 모든 허용 최대 상태가 8192B 이하인지 고정한다.
- 임의 padding 문자열을 사용한 API 경계 fixture는 8192B 수용·8193B API 거절을 확인한다. API가 raw를 통과시켜도 DB CHECK가 따로 거절할 수 있으므로 DB 왕복 결과와 `pg_column_size`는 별도 기록한다. 게임 허용 최대 fixture가 양쪽을 통과해야 출하한다.
- API 검증은 테스트 가구로 PUT→GET하며 같은 DTO가 돌아오는지 확인한다. DB 크기는 테스트 환경에서 조회한다. 운영 사용자 상태로 경계 실험을 하지 않는다.
- 6×6 및 12×12 바이트 수는 v0 codec의 0~15 경계를 풀어서 재는 것이 아니라 후속 스키마 확장 시 다시 측정한다.

## 7. 하루 단위 구현 슬라이스 — 총 8개

아래 명령은 **향후 완료 게이트**다. 이번 설계 작업에서 통과했다고 주장하지 않는다. 하루는 작업량 목표이며 실패가 남으면 날짜와 무관하게 다음 의존 슬라이스를 열지 않는다.

| # | 만드는 것 | 끝났다는 구체적인 증거 | 의존 |
|---|---|---|---|
| **1** | 엔진 없이 balance·rules와 테스트. 초기화·4×4·경제·인접·수확·원자적 이동/swap·해금·완료 | `pnpm --filter @family/web exec vitest run src/lib/game-backyard.test.ts` 통과. 시작 3수확→첫 가격3, 자원 부족/점유 구매 무변경, 3↔4 비인접, 중첩 우물 미가속, 10800/8100초, 장기 방치 1개, 역행, 꽉 찬 swap, 가격 범위 도달 불가 포함 | 없음 |
| **2** | codec·주입식 session의 로드 상태 기계와 테스트; public JS 타입 검사 구성 | `pnpm --filter @family/web exec vitest run src/lib/game-backyard-codec.test.ts src/lib/game-backyard-session.test.ts` 통과. 가짜 get 실패 때 초기화/set=0, null일 때만 초기화, unknown v 무저장, 혼합 손상 보존, 실제 최대 DTO 바이트 출력. 순수 JS 검사 통과 | 1 |
| **3** | 호스트 계약·실제 bridge·등록부·쿼리 라우트·목록·더보기 복원; 기존 32건 이전 | `pnpm --filter @family/shared test` 및 `pnpm --filter @family/web exec vitest run src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts`, `pnpm build:packages`, `pnpm --filter @family/web typecheck`, `pnpm --filter @family/web build:mobile` 통과. out/play/app/index.html 존재, get reject 전파·set 실패 전파·source/세대 거부·권한 0 검사. 게임 entry가 아직 없으면 호스트 단독 harness로 통신 확인하고 제품 화면 완료로 세지 않음 | 2의 계약 |
| **4** | index/style·canvas renderer·탭 input·HTML HUD/상점, 가짜 저장 의존성을 붙인 로컬 플레이 | sandbox에서 320·360·430px 폭/470px 높이 화면 확인. 화분 수확→구매·배치→이동/swap이 rules Action만으로 수행됨. 모서리·DPR/리사이즈 hit-test, 스크롤 취소, 실패 행동 무차감 확인. `node --check` 각 새 JS 및 DOM JS 타입 검사 통과 | 1, 2, 3 |
| **5** | 실제 bridge와 session 연결, 부모 PUT 큐·백오프·미저장 HUD·전체 상태 저장 | session/client/host 테스트 통과. 실제 앱에서 수확·구매·이동 후 닫고 다시 열어 DTO 일치, 테스트 가구 API/DB 최대 상태 저장 성공. API 실패와 8초 timeout 주입 때 미저장 표시·최신 재전송, 초기 GET 실패 시 PUT=0을 네트워크 로그로 확인. 이전 요청 ACK가 최신 dirty를 지우지 않음 | 2, 3, 4 |
| **6** | 성장 표시·idle bob·수확 피드백·완료 화면·숨김/복귀·정리 마무리 | 2px/1.4초 bob, 도형/그림자/팔레트 확인. 가짜 시각으로 3시간/2시간15분 성장·익은 채 유지·우물 이동 후 기존 시각 불변 확인. 16칸 완료 후 swap 가능, 20회 진입/이탈 뒤 리스너/RAF/timer 누적 없음. CSS와 HTML 버튼이 470px 안에서 사용 가능 | 4, 5 |
| **7** | 브라우저 통합 회귀와 실제 export/OTA 산출물 검사 | 관련 모든 Vitest, `pnpm build:packages`, 웹 typecheck, public JS 검사, `pnpm --filter @family/web build:mobile` 통과. out에 entry와 모든 script/CSS가 있고 검사 대상 public 파일과 바이트 일치. export 정적 서버에서 쿼리 직진입·브릿지 복원·CORS 오류 없음 확인. 새 out raw/ZIP 크기와 기준 대비 증가량 기록. 기존 전체 웹 테스트 실패는 원인·기존 여부 별도 분리 | 3~6 |
| **8** | iOS·Android Capacitor 실기기 승인 시험 및 첫 세션 사용성 확인 | 동일 `allow-scripts` iframe에서 로컬 scheme 부팅·진짜 터치·스크롤·백그라운드/복귀·강제 종료 재진입·네트워크 단절/복구 시험. 온라인 수확→구매→배치→복원이 3분 내 한 세션으로 가능. 오프라인은 셸 부팅+로드 실패 화면이며 빈 게임 자동 저장 없음. 기종·OS/WebView·증거·실측을 기록; 둘 중 미시험이면 출하 검증 미완료 | 7 |

슬라이스 1의 도달 불가 테스트는 단순히 potPrice에 큰 수를 넣는 테스트와 다르다. 시작 3칸과 무보관/무삭제 불변식으로 정상 경로에서 구매 가능한 화분은 최대 13개임을 검증하고, 빈 칸이 없으면 가격 적용·차감 전에 구매가 거절됨을 고정한다. 손상 입력의 n=16을 위한 반환값 방어 테스트는 별도로 둔다.

public JS 타입 검사에는 구현 시 마련할 `apps/web/tsconfig.miniapps-rules.json` 및 `apps/web/tsconfig.miniapps-dom.json`을 쓰고, 완료 명령을 `pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit` 및 대응 dom 명령으로 고정한다. 새로운 외부 라이브러리는 필요 없다. TS/React 복원 API를 실제 작성할 때는 이용 가능한 context7/공식 문서로 설치 버전을 확인한다.

밸런스 7~10일 목표와 두 사람의 재방문·배치 고민·변화 인지는 8일 구현 게이트와 별개인 후속 실제 플레이 관찰이다. 이번 부록 외 가격·성장값을 구현 중 임의 조정하지 않는다.

## 8. 위험·미확인·재검토 조건

| 위험 | 확인된 사실과 남은 검증 | 대응·출하 조건 |
|---|---|---|
| **로드 실패를 신규로 덮어씀** | 기존 bridge get은 실제 catch→null이었다. 피해는 마당 소실 | 최비용 위험. playable 밖 writer 부재, 실패 시 PUT=0을 단위·통합 둘 다 고정. 이 게이트 실패 시 출하하지 않음 |
| 저장 실패·앱 종료 | sandbox 로컬 영속성 없음, 언마운트 저장 보장 불가 | 행동 직후 저장·성공 응답·HUD·재시도. ACK 전 종료 손실은 명시적 한계 |
| 두 기기 동시 저장 | API는 revision 없는 가구 단위 upsert | 마지막 쓰기 우선 수용. v0.3 동시 편집 범위를 몰래 앞당기지 않음 |
| Capacitor 자산 scheme/CSP | Chromium HTTP 일반 script 통과, 실제 local scheme은 **확인 못 함** | iOS/Android 각각 export 동봉 script/CSS·부모 source·ready 검사. allow-same-origin 완화로 해결하지 않음 |
| 모바일 입력 | 선행 결과는 Phaser의 에뮬레이션 터치, 자체 canvas input은 미구현 | 실제 손가락 탭·pointercancel·부모 스크롤·화면 회전·DPR 검사 |
| 앱 수명·타이머 | 백그라운드 정지·프로세스 종료·WebView 회수 동작은 **확인 못 함** | 경제는 epoch sec 재평가, 렌더만 재시작. OTA 교체 후 새/구 버전 state 읽기 확인 |
| 성능·메모리 | 선행 60프레임은 FPS 벤치마크가 아님 | 실기기 프로파일에서 프레임 시간·메모리·20회 재진입 누적 측정. 초기 목표는 상호작용 중 60Hz 기기에서 프레임 예산 16.7ms 이내이며 실측 전 달성 주장 금지 |
| 미래 렌더 교체 | 좌표만 분리해서는 충분하지 않음 | input·수명까지 adapter 경계 유지. 새로운 씬/NPC 요구 또는 실측 성능 문제 발생 때 엔진 재검토 |
| 8KB DB 조건 | raw와 jsonb 조건은 다른 측정 | 실제 최대 codec DTO를 API+DB로 왕복. 대형 확장 추정치를 v0 실측으로 대체하지 않음 |
| 초기 게임성 | 시작 3개로 산술 루프는 성립, 재미는 **확인 못 함** | 3분 첫 세션과 이후 7~10일 관찰로 판단. 엔진 도입으로 해결하려 하지 않음 |

엔진 선택이 틀리면 표현 2개 파일과 연결·검증을 다시 한다. 저장 부트스트랩이 틀리면 두 사람의 기존 마당을 잃는다. 따라서 엔진 없는 첫 두 슬라이스와 저장 분기 게이트를 가장 먼저 둔다.

## 9. 설계 자체 검토 결과

지시서 6개 질문과 부록 4개 결정을 대조했다. 엔진은 크기 실측과 포기 항목으로 결정했고, 삭제된 호스트 파일/테스트는 복원·변경·폐기를 구분했으며, public 실제 JS와 Node 테스트의 단일 출처를 확정했다. 저장 실패와 null·버전·부분 튜플 손상을 분리했고, 순수 규칙부터 실기기까지 8개 완료 게이트를 적었다.

반복 방지 기록: **공용 패키지 typecheck만 믿지 말고 DTS build까지 검사**, **dev 화면만 믿지 말고 mobile export와 out 포함 여부까지 검사**, **테스트에 규칙 복사 금지**, **실패를 빈 데이터로 정규화 금지**, **gzip 수치를 OTA ZIP 증가로 대신 쓰지 않기**. Memory 기록은 도구 부재로 수행하지 못했다. 구현·자동 테스트·실기기 결과는 이 문서 작성 완료와 구분한다.
