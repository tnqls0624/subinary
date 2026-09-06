# 뒷마당 슬라이스 4·5 구현 보고

2026-09-06. 계약: `docs/impl-backyard-s4-brief.md`, `docs/impl-backyard-v0.md`, 코디네이터의 `docs/impl-backyard-verify-env.md`.

검증 진행 중인 보고서다. 최종 완료 여부와 브라우저 증거는 아래에 보완한다.

## 구현

- `index.html`·`style.css`: 470px 내부 HTML HUD·상점·저장 상태·로드 오류와 다시 시도. 시스템 한글 폰트, 이미지·웹폰트·외부 CDN 0개.
- `renderer.js`: CSS 280px 마당, 4×4 타일과 화분·우물·의자·그림자·선택/배치 표시. DPR 버퍼와 CSS hit-test 분리, 리사이즈 대응.
- `input.js`: 탭 확정만 전달. pointercancel·scroll·blur·다중 포인터·8px 초과 이동·다른 칸/경계 밖 종료는 취소.
- `app.js`: `BackyardApp.createApp(bridge)`에 가짜 또는 실제 저장 의존성 주입. 제품 페이지는 실제 MiniApp을 연결하고 playable writer의 dispatch로만 수확·구매배치·이동·swap을 확정한다. 규칙의 미리보기 결과를 표시하며 경제·인접·성장 시각을 별도로 계산하지 않는다. 방향키/Enter/Escape 입력도 제공한다.
- 부모 PUT 큐와 세션 최신 스냅샷·백오프·오래된 ACK 방어는 앞 슬라이스 제품 구현을 사용한다. 상점 선택/취소는 저장하지 않는다.
- 실제 브라우저 연결에서 발견한 초기 ready 경쟁을 `bridge.js`에서 수정했다. 최초 captureReady 대기는 iframe load 이후 ready 이벤트만 기다리고, 8초 실패 후 재시도에 host.info를 사용한다. 이전 코드는 최초 host.info가 load 전 GET을 열어 부모 loaded의 세대 변경으로 GET 응답이 폐기될 수 있었다. 수정 전 실패/후 통과 회귀 테스트를 남겼다.

`rules.js`·`codec.js`·`balance.js`·`session.js`는 수정하지 않았다. 슬라이스 6의 bob·수확 효과·성장 주기 갱신·완료 화면·숨김/복귀 마무리와 이후 실기기/OTA 회귀는 구현하지 않았다. 커밋·배포는 하지 않았다.

## 자동 검증

- 규칙·codec·session·client·host·새 입력·실제 HTTP 통합: **138개 통과**. `/tmp/backyard-s4-tests.log`.
- 새 입력 9개는 정상 탭, 취소 세 가지, 이동 후 복귀, pointermove 누락, 경계/다른 칸, 다중 포인터/해제, DPR 2→3 및 크기 변경을 검증한다.
- 실제 HTTP 통합 2개는 초기 GET 503→writer 없음·PUT=0, 수확 3→구매→이동→swap→새 세션 DTO 일치를 검증한다. `/tmp/backyard-s4-integration.log`.
- `tsc -p tsconfig.miniapps-dom.json --noEmit` 통과. 모든 backyard JS를 포함하도록 검사 범위를 확장했다.
- `node --check` 새 renderer/input/app 통과.
- `pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2` 통과(캐시가 아닌 강제 실행). `/tmp/backyard-s4-packages.log`.
- `pnpm --filter @family/web typecheck` 통과. `/tmp/backyard-s4-types.log`.
- `pnpm --filter @family/web build:mobile` 통과. bridge 수정 후 재빌드했다. `/tmp/backyard-s4-mobile.log`.

## 실제 API·DB

`scripts/verify-play-state-isolated.mjs`는 기존 `verification-database-guard.mjs`와 카드 문자 검증 스크립트의 생성→migration→검증→finally 폐기 구조를 사용한다. 운영 데이터 및 운영 API에는 쓰지 않는다.

일회용 DB `family_memory_verify_20260906035554_5f78955c`에서 실제 PlayController·ZodValidationPipe·PlayService를 컨테이너 내부 localhost 임의 포트로 띄워 HTTP PUT→GET을 수행했다. 인증 주체만 해당 일회용 DB의 신규 사용자로 주입했다. 배포 codec의 최대 DTO를 사용했으며 반환 DTO 일치·DB 저장 모두 통과했다. 종료 후 해당 DB 폐기도 성공했다.

| 측정 | 결과 |
|---|---:|
| 최대 DTO raw JSON | 469B |
| 최대 DTO `pg_column_size(state)` | 548B |
| 서비스 직접 왕복 | 통과 |
| 실제 HTTP controller PUT→GET | 통과 |
| raw 8193B 서비스 거절 | 413 |

raw 8192B padding fixture는 서비스의 raw 검사 통과 후 DB `play_states_state_size` CHECK에서 거절됐다. 이는 raw 크기와 jsonb 크기가 다르다는 설계서 위험의 실측이며 최대 게임 DTO의 성공과 구분한다. 이 차이를 숨기거나 API가 8192B를 최종 저장했다고 쓰지 않는다. 로그: `/tmp/backyard-s4-db.log`.

API·서비스는 현재 운영 이미지의 변경되지 않은 play 구현을 일회용 컨테이너로 실행했다. 운영 인증/실사용자/운영 URL의 제품 화면 종단 검증을 대신하지 않는다.

## 브라우저 검증

`scripts/verify-backyard/`의 재현용 harness는 실제 배포 게임·bridge와 실제 부모 호스트 런타임을 번들해 사용하고 HTTP 저장소만 메모리 fixture로 대체한다. sandbox는 allow-scripts만 사용한다.

320·360·430px × 470px에서 HTML HUD·상점·마당·취소의 DOM 경계가 모두 내부인 것을 확인했다. canvas는 CSS 280×280, DPR 2에서 실제 버퍼 560×560이다. 추가 브라우저 행동·오류 증거는 검증 종료 후 보완한다.

## 한계와 학습 기록

Memory·context7·sequential-thinking MCP가 제공되지 않아 해당 MCP 기록은 수행하지 못했다. 기존 저장소 계약과 실제 배포 파일·실행 결과로 확인했다. 새로운 제품 외부 라이브러리는 추가하지 않았다.

반복 방지: 초기 handshake와 iframe load 세대 경쟁을 실제 브라우저에서도 검증하기, 테스트에 규칙 복제하지 않기, GET 실패를 null로 바꾸지 않기, UI에도 playable writer 경계를 유지하기, raw와 jsonb 크기를 별도 실측하기, 운영 DB 이름이 아닌 가드가 생성한 이름만 폐기하기.
