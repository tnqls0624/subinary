# 뒷마당 RPG 슬라이스 6·7·8 구현 보고

2026-09-07. 범위: 주민 3명·대사 56개, 채집 8종, 낚시 8종과 기존 5키 저장 연결. 운영 스택·API·DB 변경 및 배포 없음.

## 구현

- `rpg-rules.js`의 `BackyardRpgLife`는 엔진·DOM 없는 순수 규칙이다. g01~g08/f01~f08을 기존 저장 ID s0~s15에 매핑했다. 문자열은 정적 JS에만 있고 저장하지 않는다.
- 모루는 작은 둥근 귀와 몸통, 두리는 부리와 날개, 소담은 긴 귀로 그린다. 주민별 8방향×5포즈를 부팅 때 생성한다. 각 주민은 주 장소에서 시작해 6개 고정 waypoint를 24px/s로 순회하며 3~8초 쉰다. 보행 가능한 격자 경로·발 충돌체를 검사하고, 10초 길막 때 현재 위치는 그대로 둔 채 안전한 목적지로 바꾼다. NPC 위치·목적지·걷기 위상은 저장하지 않는다.
- 주민당 인사 4 / 장소 4 / 배치 4 / 발견 2 / 친밀 2의 고유 완성문 16개와 공통 틀 8개다. 직전 대사를 피하고 상황에 맞는 완성문을 선택한다. 명사 슬롯에 조사까지 넣어 치환한다. 배치 반경 96px의 종류·위치와 물가 인접 여부를 정규화한 uint32 서명이 달라지면 배치 반응을 우선한다.
- 친밀도는 12비트 마스크의 비트 수다. 인사·세 장소·세 물건·채집/벌레/물고기 관찰·표본 보여주기·함께 앉기 경험을 언제든 다시 만들 수 있다. 주민이 세 장소를 순회하며, 표본 보여주기는 보유 표본을 차례로 보여주고 소비하지 않는다. 같은 경험 +0이며 비접속·날짜 감쇠가 없다.
- 자연 채집점 12개와 고정 화분 슬롯 최대 48개를 사용한다. 다가가서 행동해야 하고, 0.35초 손 동작 또는 0.4초 뜰채 뒤에 도감·수량·다음 획득 시각을 **collection 한 키**로 확정한다. 획득 후 60초 재생성, 99개 거절, 오래 비워도 한 번분만 준비된다. 화분 보관·재배치에서 ID와 collection 시각을 유지한다.
- 낚시는 2~4초 대기 → 무기한 입질 → 0.6초 끌어올림 → 카드/저장이다. 북쪽 점은 메기·은빛 물고기·점박이 물고기, 가운데 서쪽 둑은 붕어·잉어, 남쪽 점은 송사리·피라미·미꾸라지다. 미발견을 우선하고 이후 시드와 점별 인덱스로 순환한다. 취소는 수량을 바꾸지 않는다.
- HTML 대화·획득 카드와 canvas 주민·벌레·낚싯대를 연결했다. 대화 중 입력을 멈추고 초점을 대화 안에 유지한다. 숨김/작은 viewport/blur/패널 일시정지 때 진행 delta를 소비하지 않는다. 도감 화면은 만들지 않았고, 후속 패널이 사용하는 `backyard.panel` CustomEvent의 `{open:boolean}` 일시정지 계약만 제공한다.
- 이전 ACK 전에는 새 획득·관계·꾸미기를 막으며 걷기는 유지한다. 획득 카드는 ACK 전 “저장 중”, ACK 후 “도감에 남겼어요”, 실패 시 “저장 후 계속할 수 있어요”다. 공통 “저장 다시” 버튼으로 기존 writer를 flush한다. writer는 기존 표본 수량 감소·최초 발견 시각 변경·자연/화분 시각 삭제·역행·관계 비트 삭제도 거절한다.

## 저장 계약 결정

1. 설계서 §6의 나무 3시간과 이번 지시서의 채집점 60초가 다르므로 **이번 지시서를 우선해 나무·화분까지 모든 채집 재생성을 60초로 통일**했다. 이전 화분의 미래 readyAt은 줄이지 않고 그대로 기다린다. 화폐·우물 가속·감쇠를 추가하지 않았다.
2. 공통 8개 문장의 직전 대사도 기억하기 위해 residents의 `lastLine` 허용 범위를 0~15에서 **0~23**으로 확장했다. DTO v2와 5키·필드 수는 유지하며 이전 0~15 저장을 그대로 읽는다. 오래된 s45 앱은 새 16~23 값을 복원 오류로 보수적으로 거절할 수 있다.
3. 기존 최대 fixture는 이미 16종·60개 채집점을 포함했다. 이번에는 정적 이름·그림이 연결됐지만 DTO 문자열 길이가 늘지 않는다. `lastLine` 최대값도 두 자리여서 최대 바이트는 동일하다.

| 키 | 최대 canonical raw | 예산 | API 상한 |
|---|---:|---:|---:|
| rpg_meta | 76B | 256B | 8192B |
| rpg_world | 662B | 3072B | 8192B |
| rpg_collection | 2005B | 4096B | 8192B |
| rpg_residents | 101B | 512B | 8192B |
| rpg_player | 84B | 256B | 8192B |

[최대 raw 측정](evidence/rpg-s678/raw-bytes.json) · [public/out 자산 12개 바이트 일치](evidence/rpg-s678/export-assets.json).

합계 2928B. 실제 codec 최대 fixture를 UTF-8 `Buffer.byteLength(JSON.stringify(dto))`로 측정했다. DB jsonb 크기가 아니다.

## 검증

[전체 테스트 출력](evidence/rpg-s678/tests.txt): **12개 파일, 206개 테스트 통과**. 지시서의 기존 필수 10개 파일에 기존 RPG 규칙 테스트와 신규 `game-backyard-rpg-life.test.ts`를 포함했다.

- 주민: 고유 48문장+8틀, 모든 12경험 재현·재경험 +0, 표본 비소모, 배치 서명 변화, 24px/s·3~8초 쉼·10초 길막 후 무순간이동 복구와 실제 재이동.
- 대사: 주민별 30회, 총 90회 규칙 출력에서 빈 슬롯·undefined·알려진 잘못된 조사 패턴 0. 실제 브라우저 버튼 대화도 30회 수행했다. 이는 **사람이 자연스러움을 검수했다는 의미가 아니다**.
- 채집: 8종·자연12+화분48=60점, 59/60초 경계, 시계 역행, 30일 방치 뒤 기존 기록 보존·추가 한 개, 99개 상한, 중복 요청, 화분 보관/재배치 시각 보존.
- 낚시: 2~4초·입질 60초 유지·600ms 끌어올림·취소 변화 0·소속 종 수 이내 전부 발견·일시정지 delta 0.
- 실제 HTTP 메모리 서버+제품 client+제품 host 큐+제품 session: 채집 PUT 1개에 `species=['s0:1:1000']`, `nodes=['node-0:1060']`, fishing을 같이 기록한다. ACK 전 중복 commit은 거절하며 낚시도 collection PUT 하나다. GET 실패 PUT=0·meta 마지막 ACK·기존 503 복구·재진입 게이트도 유지했다.

| 명령 | 결과 |
|---|---|
| `pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2` | 9/9 성공, cache 0 — [출력](evidence/rpg-s678/packages-build.txt) |
| `pnpm --filter @family/web typecheck` | 통과 — [출력](evidence/rpg-s678/web-types.txt) |
| `pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit` | 통과 — [출력](evidence/rpg-s678/rules-types.txt) |
| `pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit` | 통과 — [출력](evidence/rpg-s678/dom-types.txt) |
| `pnpm --filter @family/web build:mobile` | 통과 — [출력](evidence/rpg-s678/mobile-build.txt) |

### 브라우저

재현: 모바일 빌드 후 `node scripts/verify-backyard/rpg-s678.mjs`.

실제 정적 `/play/app/?key=backyard`, `sandbox="allow-scripts"` iframe, 모든 `/v1/**`를 격리한 Playwright 메모리 fixture를 사용한다. 접근 시작 위치만 저장 fixture로 놓고 획득은 실제 화면 버튼을 누른다. 의자 이동은 작업대·패드 키보드·이동·확정의 실제 꾸미기 UI로 수행한다. 운영 API 요청으로 해석하면 안 된다.

[브라우저 결과](evidence/rpg-s678/browser-results.json) · [실행 출력](evidence/rpg-s678/browser.txt).

- 4키→meta 초기화, 320/360/430 viewport 부팅.
- 의자 실제 이동→world PUT→같은 모루의 새 배치 대사: [전](evidence/rpg-s678/chair-before.png), [후](evidence/rpg-s678/chair-after.png).
- [모루](evidence/rpg-s678/moru.png), [두리](evidence/rpg-s678/duri.png), [소담](evidence/rpg-s678/sodam.png)의 귀·부리/날개 외형을 캡처로 확인한다. 사람의 귀여움/식별성 사용성 평가는 확인 못 함이다.
- 자연 채집 12점을 근접 행동으로 획득하고, 각 획득에서 collection PUT 하나만 발생했다: [채집](evidence/rpg-s678/gathered.png).
- 3점에서 총 물고기 8종, 입질 상태에서 **실제 60초 대기 후 획득**, 취소 시 수량 변화 0: [입질](evidence/rpg-s678/fishing-0-bite.png).
- 패널 일시정지 이벤트와 visibility 숨김/복귀를 주입한 후 획득 1개. 네이티브 앱의 실제 background 이벤트 검증은 아니다.
- collection PUT 503 뒤 새 획득을 잠그고 “저장 다시”로 정확히 1개를 기록한다. 초기 GET 503에서는 PUT=0·엔진 없음. 의도적 503을 제외한 정상 JS/콘솔 오류 0.
- [16종 이후 획득 카드](evidence/rpg-s678/all-species.png)는 전체 도감 화면이 아니다. 이번 범위는 도감 데이터까지다.

## 리뷰 기록과 확인 한계

- 대화가 footer 전체를 숨겨 저장 상태까지 가렸던 문제를 발견해 패드·행동 버튼만 숨기도록 수정했다. 관계 저장 실패에도 재시도 버튼이 보여야 하므로 저장 재시도를 획득 카드 밖으로 옮겼다.
- 고정 시간 키 입력만으로 의자 이동 칸을 가정하던 브라우저 절차가 반복 중 실패해, 정지 checkpoint의 실제 저장 좌표를 읽으며 목표 위치까지 이동하도록 검증 스크립트를 수정했다.
- 단순 시선 검사만으로 NPC 발 충돌체 여유를 보장할 수 없어 직선 경로도 발 사각형으로 샘플링한다. 길막 복구는 좌표 이동 대신 목적지 변경이며, 격자 경로의 다음 경유점을 유지해 중심점 왕복을 피한다.
- 새 규칙 타입의 테스트 유틸 참조 누락으로 웹 typecheck가 처음 실패했으며 reference path 추가 후 통과했다. 오류를 숨기지 않고 public checkJs와 웹 타입 검사 둘 다 수행한다.
- Memory·context7·sequential-thinking MCP는 제공 도구에서 찾지 못했다. 과거 학습 로드·외부 ADR/반복 패턴 저장은 **확인 못 함**이며 위 결정·리뷰를 로컬 기록으로 남긴다. 새 라이브러리는 추가하지 않았고, Phaser 공식 [텍스처](https://docs.phaser.io/phaser/concepts/textures)·[Image](https://docs.phaser.io/phaser/concepts/gameobjects/image) 문서와 기존 고정 4.2.1 선언을 참조했다.
- aside-browser의 `aside guide`가 사용 가이드 대신 일반 대화 응답을 반환하여 사용할 수 없었다. 저장소의 기존 Playwright 격리 export 검증 방식을 확장했다.
- 사람이 30회 대화의 자연스러움·주민 매력을 평가한 결과, 손가락으로 낚시 3점을 조작한 결과, iOS/Android 실기기·WebView·글자 확대 사용성은 **확인 못 함**이다. 자동 검사와 이미지 관찰로 대신 통과했다고 주장하지 않는다.
- 실제 API·DB 8192B/jsonb 왕복·두 기기 같은 키 경합은 슬라이스 10이다. 기존 마지막 쓰기 우선과 ACK 전 종료 시 미저장 소실 가능성은 유지한다.
- 도감 화면·오늘 변주·완료 화면·화폐·연속 접속 보상·표본 소멸·관계 감쇠를 추가하지 않았다. v0 파일을 보존했다.
