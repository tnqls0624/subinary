# 뒷마당 RPG 슬라이스 4·5 구현 보고

2026-09-07. 범위: v2 5키 codec, 세션 부팅·초기화·키별 writer, v1 이전, 실제 bridge·엔진 연결. 운영 API·DB 접근 및 배포 없음.

## 구현 결과

- `rpg-codec.js`: `rpg_meta/world/collection/residents/player` 검증. null, 알 수 없는 버전, 상위·튜플 손상을 구분한다. 정수 전체 토큰·고유 슬롯/위치·알려진 ID·개수·raw 예산을 검사하고 손상 데이터를 삭제하여 재저장하지 않는다.
- `rpg-session.js`: playable에만 데이터와 writer가 있는 판별 유니온. ready와 전체 초기 GET을 성공·검증한 뒤 누락 데이터 키만 순서대로 저장하고, 마지막 meta ACK 후 playable로 전환한다. meta가 있는데 필수 키가 없으면 복원 오류로 멈춘다. 부분 초기화 실패는 별도 initialization_error이며 재진입에서 이미 있는 키를 보존한다.
- v1 decoder는 기존 Garden·balance에 결합되어 있어 RPG 읽기에 재사용하지 않고 `garden` 이전에만 사용한다. 원본 배열 순서의 ID, 열 3~6/행 15~18 매핑, 기념 열매, collection의 `pot-{id}:readyAt`을 보존한다. garden은 읽기만 하고 meta 완료 뒤 다시 병합하지 않는다. 초기 seed는 4821이다.
- 키별 순번·최신 스냅샷·8초 timeout·1/2/4/8/16/30초 백오프를 구현했다. ACK는 해당 전송 순번까지만 반영하며 영구 오류는 자동 재전송을 멈춘다. 기존 실제 bridge의 오류 전파와 부모의 키별 PUT 큐를 그대로 연결했다.
- 엔진은 fixture에서 시작하지 않고 세션 초기화 완료 후 생성된다. 저장 위치·방향·옷을 복원하며 막힌 플레이어 위치는 가장 가까운 통행 타일로 복구한다. 의미 있는 변경의 ACK 전에는 다음 꾸미기 변경을 잠그고 걷기는 유지한다.
- 물건은 보관 포함 48개 고정 슬롯이다. 이동·보관·재배치는 world 한 키만 쓰며 보관으로 슬롯을 삭제하지 않는다. 이미 소유한 ID 삭제·종류 변경, collection의 화분 시각 삭제·역행을 writer가 거절한다. 수확 동작 자체는 후속 슬라이스다.
- 이동은 프레임에서 위치만 관측한다. 걷기 10초 checkpoint, 정지 1초 후 저장, 숨김 보조 flush를 구현했다. 복귀는 clean일 때 재읽고 dirty일 때 메모리를 유지하며 flush한다. HTML HUD에 미저장을 표시하고 최초 도움말에 같은 키의 마지막 저장 우선 한계를 안내한다.

## 저장 형식 경계

모든 키는 `v:2`이며 DTO 필드는 codec에서 명시적으로 제한한다.

| 키 | 필드와 범위 | 최대 canonical raw | 설계 예산 |
|---|---|---:|---:|
| rpg_meta | mapVersion=1, seed uint32, initialized=true, migrated boolean | 76B | 256B |
| rpg_world | items 최대 48, id 0~47, kind p/w/c, col 0~31·row 0~23 또는 b, legacyFruit 안전 정수 | 662B | 3072B |
| rpg_collection | species s0~s15·count 0~99·firstSeenAt 안전 정수, 자연 node-0~11·pot-0~47 최대 60, fishing 3개 인덱스 0~7 | 2005B | 4096B |
| rpg_residents | r0~r2, mask 0~4095, lastLine 0~15, layoutSignature uint32, sampleId b 또는 s0~s15 | 101B | 512B |
| rpg_player | mapVersion=1, x 0~511·y 0~383 (2월드px=1/16타일), direction 0~7, outfit 0~1, t 안전 정수 | 84B | 256B |

합계 2928B. 실제 codec 최대 fixture를 `Buffer.byteLength(JSON.stringify(dto),'utf8')`로 측정한 raw 수치이며 DB 크기가 아니다. 표본·주민 ID는 이번 형식 경계이며 이름·콘텐츠 매핑은 슬라이스 6~8에서 연결한다. 세계 튜플에는 readyAt이 없다.

손상 collection/residents를 읽기 전용으로 일부 표시하는 선택 대신 전체 복원 오류로 중단한다. 따라서 기록이 유실된 상태로 writer가 열리지 않는다. world 구조 손상도 같은 보수적 정책을 사용한다.

## 게이트와 증거

[tests.log](evidence/rpg-s45/tests.log): 10개 파일, **188개 테스트 통과**.

- 새 테스트: `game-backyard-rpg-codec/session/integration.test.ts`; 배포 JS를 VM에서 직접 읽는다.
- 기존 필수 7개 파일: `game-backyard.test.ts`, `game-backyard-codec.test.ts`, `game-backyard-session.test.ts`, `game-backyard-input.test.ts`, `game-backyard-integration.test.ts`, `miniapp-client.test.ts`, `miniapp-host.test.ts`.
- 5개 RPG 키 및 garden 각각의 초기 GET reject에서 PUT=0. 각 RPG 키의 unknown v/손상/undefined에서 PUT=0. meta 존재+필수 null에서도 PUT=0.
- 데이터 4키와 meta 각각의 초기 PUT 실패 후 재진입: 기존 키 값 보존·기존 키 PUT 없음·meta 마지막 요청 및 ACK 전 initializing 유지.
- 실제 HTTP 메모리 서버+제품 client+제품 host 큐에서 GET 503 PUT=0, PUT 503 미저장·복구, world 이동 ACK 뒤 재진입 일치.
- 주입 시계에서 ready/GET 8초 무응답·PUT 8초 timeout, 늦은 ACK 후 최신 dirty 유지, 백오프 상한·영구 오류·destroy 타이머 정리.
- **정확한 가상 60,000ms/3,600프레임 걷기:** player PUT **7회**, 정지 저장 **1회 포함**, observePlayer 호출 자체의 프레임별 PUT **0회**. 이는 실기기 성능 측정이 아닌 저장 빈도 단위 검증이다.
- v1 원본 보존·한 번만 이전, 화분 보관/재배치 후 시각 보존, 슬롯 삭제·종류 변경·시각 삭제 거절.

추가 필수 명령:

| 명령 | 결과/로그 |
|---|---|
| `pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2` | 9/9 성공, cache 0 — [packages-build.log](evidence/rpg-s45/packages-build.log) |
| `pnpm --filter @family/web typecheck` | 통과 — [web-types.log](evidence/rpg-s45/web-types.log) |
| `pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit` | 통과 — [rules-types.log](evidence/rpg-s45/rules-types.log) |
| `pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit` | 통과 — [dom-types.log](evidence/rpg-s45/dom-types.log) |
| `pnpm --filter @family/web build:mobile` | 통과, /play/app 정적 산출 — [mobile-build.log](evidence/rpg-s45/mobile-build.log) |

최종 public/out entry와 참조 자산 12개 바이트 일치도 확인했다: [export-assets.json](evidence/rpg-s45/export-assets.json).

## 브라우저 연결 확인

재현: `node scripts/verify-backyard/rpg-s45.mjs` (모바일 빌드 후).

기존 export 검증 방식으로 실제 정적 /play/app/?key=backyard 호스트와 allow-scripts iframe을 사용하고 모든 /v1 API를 Playwright 메모리 fixture로 대체했다. 운영 서버에 요청을 전달하지 않는다.

[브라우저 결과](evidence/rpg-s45/browser-results.json), [실행 로그](evidence/rpg-s45/browser.log):

1. 빈 저장에서 데이터 4키→meta PUT→엔진 부팅.
2. 브라우저 키보드와 실제 꾸미기 버튼으로 화분 이동→world ACK→페이지 재진입→저장 DTO 일치. collection 화분 시각은 그대로다. 이동 대상 접근을 위한 테스트 시작 위치·배치는 명시적인 fixture를 사용했다.
3. 초기 GET 503 주입 시 네트워크 GET 1회, PUT 0회, world 엔진 부팅 없음.
4. 정상 과정 JS/콘솔 오류 0개. 의도적으로 주입한 503 오류 1개를 별도 기록.
5. 부모 폭 320/360/430의 iframe 캡처를 직접 확인했다. 이는 실기기 터치·사용성 승인을 대신하지 않는다.

[320 화면](evidence/rpg-s45/layout-320.png) · [360 화면](evidence/rpg-s45/layout-360.png) · [430 화면](evidence/rpg-s45/layout-430.png) · [이동 후](evidence/rpg-s45/moved.png) · [로드 실패](evidence/rpg-s45/get-failure.png).

## 결정·리뷰·확인 한계

- 읽기 오류를 신규 null로 바꾸지 않고, 초기 쓰기 권한과 일반 playable writer 생성을 분리했다. 메타 마지막 ACK는 초기화 완료 표식이지 여러 키 서버 트랜잭션이 아니다.
- 부모 큐는 같은 호스트의 키별 요청 순서를 보장한다. 두 기기의 같은 키 동시 편집은 여전히 마지막 쓰기 우선이며 무손실 합집합이나 완전한 멱등 저장을 보장하지 않는다.
- ACK 전 앱 종료의 미저장 변경 소실 가능성은 남는다. 종료 flush는 보조 수단이다.
- 실제 API·DB raw/jsonb 왕복·두 기기 경합은 슬라이스 10이며 **확인 못 함**. 운영 스택은 변경하지 않았다.
- iOS/Android 실기기·WebView·사람의 산책 반응·접근성 탐험 전체는 **확인 못 함**. 주민/채집/낚시 콘텐츠·도감 화면은 만들지 않았다. v0 파일을 병행 보존했다.
- Memory/context7/sequential-thinking MCP는 노출 도구에서 찾지 못해 과거 학습 로드·외부 ADR/학습 기록은 **확인 못 함**. 외부 프레임워크 신규 도입 없이 기존 Phaser 어댑터·브릿지 API와 설치된 타입 정의를 이용했다.
- Aside 스킬의 `aside guide`가 가이드 대신 일반 대화 응답을 반환하여 브라우저 조작에는 사용하지 못했다. 기존 저장소 Playwright 검증 코드를 확장했다.
- 반복 방지 기록: fractional fake-timer 간격을 누적하면 60초라는 주장이 실제 가상 경과와 달라질 수 있으므로 프레임마다 정수 경과 차이를 주어 정확히 60,000ms로 검증한다. console 출력이 테스트 환경에서 누락되어 바이트·네트워크 게이트는 process.stdout에 명시적으로 출력한다. 검증 명령은 파일로 출력하고 vitest에 tail 파이프를 연결하지 않는다.
