# 뒷마당 화면·저장 검증

실제 배포 게임과 실제 부모 호스트를 `sandbox="allow-scripts"` iframe으로 실행한다.
이 서버의 HTTP 저장소는 메모리 fixture이며 운영 API가 아니다.

저장소 루트에서 실행한다.

```sh
node_modules/.pnpm/esbuild@0.25.12/node_modules/esbuild/bin/esbuild apps/web/src/lib/miniapp-host.ts --bundle --platform=browser --format=iife --global-name=BackyardHost --alias:@family/shared=./packages/shared/src/miniapp-bridge.ts --outfile=/tmp/backyard-s4-host.js
python3 scripts/verify-backyard/server.py
```

브라우저에서 `http://127.0.0.1:8766/`을 연다. 번들 파일을 만든 뒤 새로고침해야 한다.
상단 버튼은 폭 320/360/430px, 재진입, GET/PUT 503, PUT 10초 지연을 제공한다.
게임 bridge의 timeout은 실제 8초다. `/evidence`와 서버 stdout에 HTTP 요청을 기록한다.
초기 GET 실패 검증은 실패 주입 직전·직후 요청 목록의 차이에서 PUT 0을 확인한다.

실제 API·DB 최대 상태는 별도 실행한다.

```sh
node scripts/verify-play-state-isolated.mjs > /tmp/backyard-s4-db.log 2>&1
```

기존 verification-database-guard가 허용하는 일회용 DB만 생성·폐기한다.
운영 데이터와 API에는 쓰지 않는다. 실제 컨트롤러·검증 파이프·서비스의 HTTP PUT/GET을
컨테이너 내부 임의 localhost 포트에서 실행하며 인증 주체만 일회용 사용자로 주입한다.
최대 상태는 배포 codec으로 생성하고 raw JSON·`pg_column_size`를 별도로 측정한다.

## 슬라이스 6·7: 정적 export와 수명 검증

모바일 빌드 후 아래 명령으로 재현한다. `export.mjs`는 임의 localhost 포트에서
실제 `apps/web/out`을 서비스하고, API만 Playwright 라우트의 메모리 fixture로 격리한다.
운영 API로 전달하지 않는다. 설치된 Playwright 모듈은 `PLAYWRIGHT_MODULE` 환경변수로
지정할 수 있으며 기본값은 개인 gstack 설치의 `node_modules/playwright/index.mjs`다.

```sh
pnpm --filter @family/web build:mobile > /tmp/backyard-s6-mobile.log 2>&1
node scripts/verify-backyard/export.mjs > /tmp/backyard-s6-export.log 2>&1
python3 scripts/verify-backyard/artifact.py > /tmp/backyard-s6-artifact.log 2>&1
pnpm --filter @family/web exec vitest run src/lib/game-backyard-lifecycle.test.ts
```

- 실제 `/play/app/?key=backyard` 호스트와 opaque sandbox 게임의 GET/PUT·재진입 일치.
- 폭 320/360/430px, 높이 470px 안의 마당·문구·44px 버튼 경계와 스크린샷.
- 가짜 epoch 시각의 8100/10800초 성장 경계·우물 이동 후 시각 보존·장기 방치 1개 수확.
- 완료 대화상자의 배경 inert·닫은 뒤 꽉 찬 마당 swap.
- 초기 GET 503 시 PUT 0. 정상 과정 오류와 의도한 503 오류를 결과 JSON에서 분리.
- `lifecycle.js`로 실제 브라우저의 등록 API를 계측한다. 최초 제품 앱을 pagehide로
  종료한 뒤 같은 DOM에서 실제 app 팩토리를 20회 생성·해제하며, 각 회차의 실패 저장
  재시도 timer·RAF·listener·ResizeObserver가 0으로 돌아오는지 검사하고 API를 복구한다.
- `artifact.py`는 entry의 script/CSS 참조 전체를 따라 public과 out의 바이트를 비교하고
  SHA-256을 기록한다. OTA와 같은 Info-ZIP 기본 압축으로 `/tmp/backyard-s6-ota.zip`을
  생성하며, 결과는 `docs/evidence/backyard-s6/`에 기록한다.

브라우저/API fixture 검증은 실제 인증·DB나 Capacitor 실기기 검증을 대체하지 않는다.
