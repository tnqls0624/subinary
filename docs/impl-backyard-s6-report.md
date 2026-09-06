# 뒷마당 슬라이스 6·7 완료 보고

2026-09-06. **슬라이스 6·7 게이트 통과.** 슬라이스 8 실기기는 수행하지 않았다.

## 구현과 이어받은 부분

기존 커밋에 이미 성장 단계·익은 화분 bob·수확 +1·완료 화면·숨김/복귀·destroy 구현이 있었다.
이를 다시 만들지 않고 실제 배포 원본을 검증했다. bob은 CSS 좌표 진폭 2px, 주기 1400ms이며
8색 팔레트·4px 둥근 도형·물건 아래 고정 그림자 한 겹을 유지한다.

이번 제품 변경은 다음 두 가지다.

- `app.js`: 완료 대화상자가 열린 동안 배경 마당을 `inert` 처리하고 닫을 때 해제한다.
- `index.html`: sandbox에서 `Blocked autofocusing ... cross-origin subframe` 경고를 내던
  불필요한 `autofocus`를 제거했다. 완료가 실제로 표시될 때의 명시적 초점 이동은 유지한다.

`rules.js`, `codec.js`, `balance.js`, `session.js`, `bridge.js`는 수정하지 않았다.
완료는 16칸 점유·3종 해금으로 계산하며 저장 필드는 여전히 `v,t,s,f,n,k,p`뿐이다.
커밋·배포·운영 스택 쓰기는 하지 않았다.

## 자동 검증

| 게이트 | 결과 | 로그 |
|---|---|---|
| 지시서 7개 테스트 + 새 lifecycle 테스트 | **8 files / 142 tests 통과** | `/tmp/backyard-s6-tests.log` |
| 전체 웹 Vitest | **26 files / 347 tests 통과**, 기존 실패 없음 | `/tmp/backyard-s6-full-tests.log` |
| `turbo run build --filter="./packages/*" --force --concurrency=2` | **9/9 성공, 캐시 0개**, DTS 포함 | `/tmp/backyard-s6-packages.log` |
| 웹 `typecheck` | 통과 | `/tmp/backyard-s6-types.log` |
| `tsconfig.miniapps-rules.json` | 통과 | `/tmp/backyard-s6-rules.log` |
| `tsconfig.miniapps-dom.json` | 통과 | `/tmp/backyard-s6-dom.log` |
| `build:mobile` | 마지막 HTML 수정 후 재빌드 통과 | `/tmp/backyard-s6-mobile.log` |
| `git diff --check` | 통과 | 실행 확인 |

신규 `game-backyard-lifecycle.test.ts`는 실제 public 파일을 VM에서 실행한다.
저장 재시도 중 20회 생성·중복 destroy, 숨김 RAF 정지·복귀 중복 예약 방지,
해제 뒤 늦은 GET 무시, 완료 후 UI 탭 swap·저장, 익은 화분만 bob·그림자 고정,
700ms 수확 효과 소멸을 검증한다. 테스트에서 게임 규칙을 복제하지 않는다.

## 브라우저 통합 회귀

**Chromium 149.0.7827.55**, DPR 2, `apps/web/out`을 임의 localhost 포트의 정적 서버로 서비스했다.
실제 `/play/app/?key=backyard` 페이지·React 호스트·`allow-scripts` iframe·동봉 bridge를 실행하고,
인증·API 응답만 Playwright 라우트의 격리 메모리 fixture로 대체했다.

- 쿼리 직진입 → ready → GET → 실제 게임 표시 통과.
- 수확 3 → 화분 구매 → 이동 → swap → 페이지 재진입 후 DTO 일치.
- 가짜 epoch 시각으로 8100초·10800초 각각 직전에는 수확 불가, 경계부터 수확 1개.
- 우물을 2번 칸에서 15번 칸으로 옮겨도 기존 화분의 `readyAt` 9100/11800 불변.
- 장기 방치해도 기존 익는 시각 유지, 수확량 1개. RAF delta로 경제 시간을 누적하지 않는다.
- 완료 대화상자 표시·배경 inert 확인, 닫은 뒤 꽉 찬 16칸의 우물/의자 swap과 저장 통과.
- 폭 320/360/430px 모두 마당·상점·이동·취소·문구가 470px 안에 들어간다. 버튼 높이 최소 44px.
- 정상 통합 과정 JS/CORS/리소스 오류 **0개**. 의도적으로 주입한 초기 GET 503에서는 PUT **0개**.
  결과 JSON의 `normalErrors`와 `injectedFailureErrors`로 정상/주입 오류를 구분했다.

실제 브라우저에서도 최초 앱을 pagehide로 종료한 뒤 같은 DOM에서 app 팩토리를
20회 생성·해제하며 실제 등록 API를 계측했다. **모든 회차 활성 상태는 리스너 18개·RAF 1개·
재시도 timer 1개·ResizeObserver 1개이고, destroy 후 네 항목이 모두 0개**다.
브릿지 수명은 최초 pagehide 정리와 기존 client 테스트가 담당하고, 반복 계측은 게임 app의
가짜 실패 저장 의존성을 사용한다. 이는 실기기 메모리 프로파일 결과가 아니다.

재현: `node scripts/verify-backyard/export.mjs`. 자세한 환경 설정은
[`scripts/verify-backyard/README.md`](../scripts/verify-backyard/README.md)에 적었다.

증거:

- [브라우저 전체 결과·네트워크 경로·20회 자원 계측](evidence/backyard-s6/export-results.json)
- [320px](evidence/backyard-s6/layout-320.png), [360px](evidence/backyard-s6/layout-360.png), [430px](evidence/backyard-s6/layout-430.png)
- [10800초 성장·수확 효과](evidence/backyard-s6/grown-10800.png)
- [완료 화면](evidence/backyard-s6/complete.png), [완료 후 swap](evidence/backyard-s6/complete-swap.png)

스크린샷 6장을 직접 열어 도형·팔레트·문구·버튼 잘림 여부를 확인했다.
브라우저 fixture 초기 작성 중 카드문자 목록을 객체로 반환해 앱 셸이 실패했으며,
실제 계약인 배열 응답으로 바로잡았다. 제품 회귀나 전체 웹 테스트 실패와 구분한다.

## export / OTA 실측

`artifact.py`는 게임 entry가 참조하는 모든 script/CSS를 읽어 export와 public의 바이트를
비교한다. **entry·CSS·bridge·7개 게임 JS 총 10개 전부 일치**하며,
`out/play/app/index.html`도 존재한다. 파일별 SHA-256은 아래 결과에 기록했다.

| 측정 | 기준 | 새 산출물 | 증가 |
|---|---:|---:|---:|
| 일반 파일 수 | 293 | 324 | 31 |
| out raw | 3,864,248B | **4,030,572B** | **166,324B (+4.30%)** |
| OTA ZIP | 1,123,874B | **1,179,233B** | **55,359B (+4.93%)** |
| 게임+브릿지 public 10개 raw | — | 55,574B | — |

OTA와 같은 Info-ZIP 기본 압축(`zip -qr - .`)으로 전체 out을 압축했다.
ZIP은 `/tmp/backyard-s6-ota.zip`, SHA-256은
`d61a049e93fe0142819236ee8fc72c187820b1541164cb6d6639b27f2dcfb3dc`다.

재현: `python3 scripts/verify-backyard/artifact.py`.
[측정값·파일별 바이트·SHA-256](evidence/backyard-s6/artifact-results.json).
ZIP에는 파일 시각 등 메타데이터가 있어 재빌드 시 해시/몇 바이트 차이가 날 수 있다.

canvas 구현과 호스트 복원까지 포함한 전체 증가량은 약 55KB로, 설계서의 Phaser 엔진 한 파일
추가 추정치 354,712B보다 299,353B 작다. **이 차이를 동일 기능 Phaser 구현과의 정확한 절감량으로
보지는 않는다**. 이번에는 Phaser 제품 빌드를 만들지 않았으며, 실제 확인한 값은 canvas 선택 후
전체 out 증가 55,359B다.

## 한계와 반복 방지 기록

슬라이스 8 iOS·Android 실기기/로컬 scheme/실제 터치/프로세스 종료 검증은 남아 있다.
이번 브라우저 API fixture는 실제 인증·DB E2E를 대체하지 않는다. 슬라이스 5의 격리 DB 결과는
이어받았으며 운영 데이터에 재실험하지 않았다.

Memory·context7·sequential-thinking MCP가 노출되지 않아 Memory 로드·ADR·학습 기록은
실행하지 못했다. 제품 외부 라이브러리를 추가하지 않았다. 검증 도구 API는
[Playwright 문서](https://playwright.dev/docs/api/class-page)와
[시계 문서](https://playwright.dev/docs/api/class-clock), autofocus는
[MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/autofocus)을 확인했다.

반복 방지: 기존 작업물의 실제 상태를 보고 재구현하지 않기, 브라우저에서 sandbox 경고까지 확인하기,
완료 overlay에 aria-modal만 쓰지 말고 배경 입력 차단도 확인하기, timer가 실제 대기 중인 상태로
20회 destroy 계측하기, export/public 바이트 일치를 먼저 강제한 뒤 ZIP 측정하기,
검증 API fixture의 응답 모양 오류를 제품 결함과 분리하기.
