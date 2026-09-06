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
