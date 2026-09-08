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

## 슬라이스 6·7: 정적 export와 수명 검증 — 2D 하네스는 슬라이스 9에서 삭제됨

이 절이 설명하던 v0 2D 하네스(`export.mjs`·`lifecycle.js`)와 RPG 2D 수명 하네스
(`rpg-lifecycle.mjs`·`rpg-lifecycle.js`·`rpg-host-lifecycle.mjs`·`rpg2d-legacy.html`)는
**슬라이스 9에서 함께 삭제했다.** 검증 대상이던 iframe 2D 표현이 사라졌기 때문이다
(`#world[data-ready=true]`·`rpg-engine.js`·`phaser.min.js` 모두 없음). 그 하네스가
남긴 측정 — 특히 Phaser 4.2.1이 destroy에서 정리하지 않는 **리스너 +40** — 은
[`docs/rpg-s91011-report.md`](../../docs/rpg-s91011-report.md)에 기록으로 남아 있다.

현재 살아 있는 재현은 3D 전체 화면 라우트(`/play/app/?key=backyard`)를 대상으로 한다.

```sh
pnpm --filter @family/web build:mobile > /tmp/backyard-mobile.log 2>&1
node scripts/verify-backyard/rpg3d-s567.mjs > /tmp/rpg3d-s567.log 2>&1
python3 scripts/verify-backyard/artifact.py > /tmp/backyard-artifact.log 2>&1
```

- `rpg3d-s567.mjs`가 실제 정적 export를 임의 localhost 포트에서 서비스하고, API만
  Playwright 라우트의 메모리 fixture로 격리한다. 운영 API로 전달하지 않는다. 설치된
  Playwright 모듈은 `PLAYWRIGHT_MODULE` 환경변수로 지정하며 기본값은 개인 gstack 설치의
  `node_modules/playwright/index.mjs`다.
- `artifact.py`는 entry의 script/CSS 참조 전체를 따라 public과 out의 바이트를 비교하고
  SHA-256을 기록한다. OTA와 같은 Info-ZIP 기본 압축으로 `/tmp/backyard-s6-ota.zip`을
  생성하며, 결과는 `docs/evidence/backyard-s6/`에 기록한다. **기준값(baselineRawBytes·
  baselineZipBytes)은 v0 시절 값 그대로이므로 증가율 필드는 참고로만 읽는다** —
  현재 실측은 [`docs/rpg3d-s9-report.md`](../../docs/rpg3d-s9-report.md)에 있다.

`index.html`·`server.py`(v0 sandbox iframe 하네스)와 `rpg-export.mjs`·`rpg-s45.mjs`·
`rpg-s678.mjs`·`rpg3d-s1.mjs`의 2D 비교 분기는 **슬라이스 2·3에서 iframe 라우트가
사라진 시점부터 이미 실행 불가**다. 이번에는 지시서가 지목한 2D 수명 하네스만 지웠고
이 파일들은 과거 슬라이스 증거의 출처로 남겨 두었다.

브라우저/API fixture 검증은 실제 인증·DB나 Capacitor 실기기 검증을 대체하지 않는다.
