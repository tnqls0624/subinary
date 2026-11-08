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

`chromium` 심볼릭 링크 대상은 Playwright `playwright-core@1.62.0` 레지스트리 기준이다. `linux-x64`는 `chrome-headless-shell`, 홈 Mac 운영 빌드(`linux/arm64`)는 `chrome-linux/headless_shell`이다. Dockerfile은 두 이름을 모두 찾아 링크한다.

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
4. 실제 수자인 로그인·추가 인증 성공 여부는 반영 후 화면에서 확인한다. 이 문서는 로그인 성공을 보증하지 않는다.

## 읽는 화면과 흐름 (2026-11-08 확인)

로그인된 브라우저에서 구조만 확인했다(값은 보지 않았다). runner는 이 구조에만 기대고, 값이 아니라 개수·머리 글자만 진단에 남긴다.

1. 공식 로그인(`form#frm` → `a.btnLogin`) 뒤 `/mypage/payment`(분양대금조회)로 간다.
2. 처음에는 납부 표(`table.st1`)의 `tbody`가 비어 있다. 표 밖 단지 `select#preInsp`에서 값이 빈 자리표시(「선택」)를 뺀 첫 세대 option을 고른다.
   - 고를 세대가 없으면 `unit_not_registered`(「수자인 사이트의 My 분양단지에 등록된 세대가 없어요. 사이트에서 먼저 등록해 주세요.」).
   - 세대가 여러 개여도 지금은 **첫 번째만** 읽는다(개수는 진단 `units`로만 남긴다).
3. `onclick`에 `searchPayment`가 있는 조회 버튼을 누른다. 사이트는 동기 XHR(`/mypage/payment/getPaymentInfo`)로 표를 채운다. 조회 뒤 사이트 알림이 뜨면 글자는 남기지 않고 닫는다(로그인·세션 안내면 `authentication_required`, 그 밖은 `unsupported_layout`).
4. 보이는 `table.st1`의 `tbody`에 칸 있는 줄이 생길 때까지 표 대기 예산(기본 15초) 안에서 기다린 뒤 읽는다.
   - caption 「아파트 분양대금」: 머리(`thead th`) 8칸 `회차|약정일자|약정금액|납부일자|납부원금|연체료|할인료|실납부금`. 줄 첫 칸(`th`)이 회차 이름(계약금1차·중도금3차·잔금·계). 데이터 줄 사이 칸 없는 빈 `tr`은 건너뛴다.
   - caption 「별도 계약 품목」: 옵션 계약마다 표 하나, 바로 앞 `div.ect_item`의 품목 이름 목록을 함께 보낸다. 줄은 계약금·중도금·잔금·계.
   - 숨겨진 연락처 입력 표(`table.basic_table`)는 읽지 않는다.
5. API는 회차 이름으로 종류·회차를 정하고(계약금→계약금, 중도금N차→중도금 N회, 잔금), `계` 합계 줄은 건너뛴다. 별도 계약 품목 줄은 모두 옵션이며 이름은 `<첫 품목>[ 외 N] · <회차 이름>`이다. 금액=약정금액, 예정일=약정일자, 낸 금액=납부원금, 납부일=납부일자.

세대 내 설치 품목(`/mypage/unit-items`)은 입주 뒤에만 메뉴가 열리고(사이트 `showInstalled()`가 입주 정보에 설치 URL이 있을 때만 보인다) 입주 전 계정은 `/mypage/payment`로 되돌려진다. 옵션 대금은 위 별도 계약 품목 표에 있으므로 runner는 그 화면에 가지 않는다.

실패 경고 줄의 진단은 `stage=scrape_payment layout=payment:t=<표 수>;searched=<0|1>;units=<세대 option 수>;h=[머리…];…` 모양이다. `searched=0`이면 조회 버튼까지 가지 못했고, `units=0`이면 단지 option이 없었다.

## Chromium 샌드박스(루트 컨테이너)

운영 API 이미지는 `USER` 없이 uid 0으로 돈다. Chromium은 루트에서 샌드박스를 켠 채 시작하지 못하므로, `tools/sujain-web-runner`는 **uid 0일 때만** Playwright `chromiumSandbox`를 끈다. 비루트에서는 샌드박스를 유지한다. 신한 `bank-web-runner` 정책은 바꾸지 않는다.

Chromium 기동 실패는 `runtime_unavailable` + 고정 사유 `chromium_launch_failed`로 매핑한다(자격증명·원문 stderr는 응답/DB에 넣지 않는다). API는 stderr에서 Chromium/Playwright 신호만 짧게 골라 경고 로그에 남긴다. 화면의 「확인」 실패는 서버 `message`(및 갱신된 `connection.statusMessage`)를 보여 주며, 예전에 하드코딩했던 「추가 인증」 문구로 덮지 않는다.

## 끄기

호스트 `.env`(compose 보간용)에 `SUJAIN_WEB_CONNECTIONS_ENABLED=false`를 두고 api를 재생성한다. runner 바이너리는 이미지에 남아 있어도 API는 조회를 시작하지 않는다.

## 새 브랜드 추가 절차

설계와 이유는 [`docs/architecture/housing-brand-adapters.md`](../architecture/housing-brand-adapters.md) 6장(6단계)·7장에 있다. 여기에는 순서만 옮긴다. 아이디·비밀번호·금액·단지명 같은 값은 어디에도 적지 않는다.

지금 있는 이음매는 다음과 같다.

- 계약: `packages/contracts/src/housing-brands.ts` 가 브랜드 목록(`HOUSING_BRANDS`)·화면 이름·공식 사이트·허용 호스트(`HOUSING_BRAND_INFO`)의 단일 근거다.
- API: `apps/api/src/housing-brand-sync/` 의 `brand-adapter.ts`(경계)·`brand-registry.ts`(등록표, 부팅 시 `HOUSING_BRANDS` 와 1:1 검사, 주택 브랜드 브라우저 작업은 프로세스 전체에서 1개)·`sujain-adapter.ts`·`housing-brand-match.ts`(브랜드 무관 맞추기).
- 웹: 패널 글자와 brand 값을 `HOUSING_BRAND_INFO` 에서 가져온다. 브랜드 고르기 UI 는 없다.
- 러너: `tools/sujain-web-runner/kit/{stdin,launch,allowlist,result}.mjs` 가 브랜드 무관 뼈대(stdin 작업 JSON, Chromium 기동·context·닫기·신호, origin 허용 목록, 결과 JSON)다. `run.mjs` 는 키트와 수자인 `policy.mjs`·`collect.mjs` 를 조합만 한다. `import('playwright-core')` 는 `run.mjs` 에서만 한다.
- API `runner-process.ts` 는 아직 없다. 두 번째 브랜드 클라이언트보다 먼저 뽑는다.

1. **사전 확인**: 정상 브라우저로 이용 조건, 로그인 방식, 조회 경로, 허용 호스트, 표 머리, 세대 선택 방식을 본다. 보안 키패드·캡차·2FA 는 우회하지 않고 `authentication_required` 로 둔다. 구조만 적고 값은 남기지 않는다.
2. **id 정하기**: 소문자 영숫자로 하고 기존 금고 공급자(`toss_securities`·`shinhan_bank`·`sujain`)와 겹치지 않게 한다. 금고 AAD·login_fingerprint·DB brand 값으로 영구 고정된다.
3. **계약**: `HOUSING_BRANDS` 와 `HOUSING_BRAND_INFO[id]` 를 추가한다. 오류 코드는 `housingBrandSyncErrorSchema` 에 추가만 한다. 값 출처 토큰은 `HOUSING_BRAND_FETCH_SOURCE`(`sujain_fetch`)를 그대로 쓴다.
4. **웹**: 브랜드가 2개 이상일 때만 패널에 고르기 UI 를 둔다. 계약+웹 OTA 를 먼저 배포한다(옛 번들의 strict parse 보호). 공용 컴포넌트를 바꿔야 하면 영향 화면을 보여 주고 먼저 묻는다.
5. **DB**: brand CHECK 를 IN 목록으로 바꾸는 마이그레이션, `schema.ts` 의 check·`$type`, `migrations.test.mjs`, `HOUSING_BRANDS`↔CHECK 일관성 테스트를 같이 넣는다. 배포 전에 백업한다.
6. **금고**: `finance-vault.ts` 의 provider 유니온·`PROVIDERS`·`CREDENTIALS_ONLY` 에 id 를 넣고 왕복 테스트를 추가한다. provider·지문 접두사는 브랜드 id 그대로 둔다(일반형으로 바꾸지 않는다).
7. **러너**: 같은 러너 디렉터리에 `brands/<id>/{urls,policy,collect}.mjs` 를 둔다. 허용 origin 은 `allowedHosts` 와 맞추고 ERRORS·STAGES·토큰 허용 목록, `validateJob(provider===id)`, 진단 sanitize 를 둔다. 프로세스 뼈대는 `kit/` 를 쓴다. 브라우저 쪽 수집 함수는 자기완결로 짠다. Chromium 은 한 벌을 같이 쓴다.
8. **러너 테스트**: 가짜 page·DOM 으로 로그인 실패·추가 인증·표 없음·세대 미등록·정상 표·허용 밖 요청 abort·진단에 셀 값 없음을 확인한다. 기존 CI 글롭(`tools/*/test/*.test.mjs`)이 잡는 위치에 둔다.
9. **API 클라이언트**: `<id>-browser.ts` 를 만들고 spawn 공용부는 `runner-process.ts` 로 쓴다. 응답 zod·stdout 상한·stderr 거르기를 둔다. 자격 증명은 stdin `{provider:id, credentials}` 로만 넘긴다.
10. **API 파서**: `<id>-parse.ts` 가 `HousingBrandFetchedItem[]` 와 unread 를 만든다. 모르는 칸은 null 과 사유로 남기고, 합계 줄은 건너뛰고, 옵션 label 은 결정적으로 만들어 골든 테스트로 고정한다.
11. **API 어댑터**: `<id>-adapter.ts` 는 0건이면 `unsupported_layout` 을 던진다. 사이트 고유 용어 문구는 `publicErrorOverride` 로 내고, 서비스의 `PUBLIC_ERROR_OVERRIDES` 표에도 같은 함수를 넣는다(빠뜨리면 컴파일이 막힌다). module providers 와 `HousingBrandRegistry` 생성자에 등록한다(빠뜨리면 부팅 검사가 막는다). 다른 브랜드로 다시 연결하면 `lastPreview` 를 비우게 한다.
12. **설정·compose**: `packages/config` 에 브랜드별 enabled(기본 false)를 두고 runnerPath·browserExecutable 은 같이 쓴다. compose 에는 비밀이 아닌 값만 넣는다. `config-validation.test.mjs`·`.env.example` 을 갱신한다.
13. **이미지**: Dockerfile 변경이 없어야 한다. 새 디렉터리를 만든다면 이유와 이미지 증가량을 PR 에 적는다.
14. **문서**: 이 문서에 그 브랜드의 허용 호스트, 읽는 화면, 확인 날짜, 진단에 남는 값 목록, 끄는 법을 추가한다.
15. **배포 순서**: 계약+웹 OTA → DB 마이그레이션 → API·러너 이미지(enabled=false) → 본인 계정 실조회 1회와 api 로그에 개인 값이 없음을 확인 → enabled=true. 롤백은 enabled=false 가 먼저이고, CHECK 되돌리기는 새 brand 행이 0건일 때만 한다.

## 하지 않을 것

- `BANK_WEB_RUNNER_PATH` / `BANK_WEB_BROWSER_EXECUTABLE`를 수자인에 재사용
- 호스트 개인 Chrome/Chromium 프로필 마운트
- 자격증명·vault 키를 compose·이미지·문서·진단 로그에 기록
