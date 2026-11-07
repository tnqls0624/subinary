# 수자인 신축 조회 실행기 — 운영 활성화

공식 경로만 사용한다: `tools/sujain-web-runner` + Playwright `playwright-core@1.62.0` + 이미지에 넣은 전용 Chromium(headless shell). 신한 `bank-web-runner` / `BANK_WEB_*` 경로·실행 파일·공급자와 섞지 않는다. ego lite / ego-browser와 개인 브라우저 프로필·쿠키·비밀번호 저장소·인증서를 쓰지 않는다.

자격증명은 앱이 FinanceVault에 저장한 뒤 stdin으로만 runner에 전달한다. `SUJAIN_WEB_*` 환경 변수·compose·문서·이미지에 아이디·비밀번호·금고 키를 넣지 않는다.

관련(동일하지 않음): [bank-web-connections.md](./bank-web-connections.md), [finance-connections.md](./finance-connections.md).

## 이미지에 포함되는 것

`infrastructure/docker/Dockerfile.prod` 런타임 단계가 다음을 설치·검증한다.

| 경로 | 역할 |
| --- | --- |
| `/app/tools/sujain-web-runner/run.mjs` | 공식 runner 진입점 |
| `/app/tools/sujain-web-runner/node_modules/playwright-core` | 정확히 `1.62.0` (API 가용성 검사) |
| `/app/tools/sujain-web-runner/chromium` | 전용 headless Chromium 실행 파일로 가는 심볼릭 링크 |

전체 Chromium·ffmpeg는 넣지 않고 headless shell만 둔다(홈서버 디스크). 시스템 라이브러리는 이미지 빌드 시 `playwright-core install-deps chromium`으로 맞춘다.

## Compose 연결

`docker-compose.prod.yml`의 **api** 서비스만 아래를 넣는다(worker/web과 공유 이미지는 빌드 산출물을 갖지만, 스위치·경로는 api에만 연결한다).

| 변수 | 운영 값 | 비고 |
| --- | --- | --- |
| `SUJAIN_WEB_CONNECTIONS_ENABLED` | 기본 `true` (`${SUJAIN_WEB_CONNECTIONS_ENABLED:-true}`) | 비밀 아님. 끄려면 호스트 `.env`에 `false` |
| `SUJAIN_WEB_RUNNER_PATH` | `/app/tools/sujain-web-runner/run.mjs` | 이미지 고정 경로 |
| `SUJAIN_WEB_BROWSER_EXECUTABLE` | `/app/tools/sujain-web-runner/chromium` | 이미지 고정 심볼릭 링크 |

금고 스위치(`FINANCE_CONNECTIONS_ENABLED`와 vault.env)는 기존 문서대로 유지한다. 수자인 조회는 금고가 켜져 있어야 자격증명을 읽고, 위 세 값이 런타임을 켠다.

## 운영자 활성화 절차

1. 이 변경이 포함된 커밋으로 운영 이미지를 **재빌드**한다(`pnpm ops:infra:bootstrap` / 공식 `deploy.sh`). 이전 이미지는 runner 소스는 있어도 `playwright-core`·Chromium이 없다.
2. api 컨테이너만 확인한다(값은 출력하지 않는다).

```bash
docker exec family-memory-ai-api-1 sh -c 'test -f "$SUJAIN_WEB_RUNNER_PATH" && test -x "$SUJAIN_WEB_BROWSER_EXECUTABLE" && test -f /app/tools/sujain-web-runner/node_modules/playwright-core/package.json && echo ok'
docker exec family-memory-ai-api-1 sh -c 'node -e "const p=require(\"/app/tools/sujain-web-runner/node_modules/playwright-core/package.json\"); if(p.version!==\"1.62.0\") process.exit(1); console.log(\"playwright-core ok\")"'
docker exec family-memory-ai-api-1 sh -c 'test "$SUJAIN_WEB_CONNECTIONS_ENABLED" = true && echo enabled'
```

3. 앱에서 수자인 자격증명이 금고에 저장된 뒤 「확인」을 누른다. 런타임/실행 파일/`playwright-core` 부재만으로 `runtime_unavailable`(「신축 조회 실행 환경이 준비되지 않았어요.」)에 바로 떨어지지 않아야 한다.
4. 실제 수자인 로그인·화면 구조·추가 인증 성공 여부는 반영 후 화면에서 확인한다. 이 문서는 로그인 성공을 보증하지 않는다.

## 끄기

호스트 `.env`(compose 보간용)에 `SUJAIN_WEB_CONNECTIONS_ENABLED=false`를 두고 api를 재생성한다. runner 바이너리는 이미지에 남아 있어도 API는 조회를 시작하지 않는다.

## 하지 않을 것

- `BANK_WEB_RUNNER_PATH` / `BANK_WEB_BROWSER_EXECUTABLE`를 수자인에 재사용
- 호스트 개인 Chrome/Chromium 프로필 마운트
- 자격증명·vault 키를 compose·이미지·문서·진단 로그에 기록
