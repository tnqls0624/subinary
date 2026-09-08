# 뒷마당 재설계 — 앱 전체 화면 스타일라이즈드 3D

작성일: 2026-09-08. 상태: 설계 완료, 구현·빌드·배포·실기기 검증 전.

**Three.js r128을 동봉하고, `/play/app?key=backyard`를 앱 전체 화면으로 연다. 기존 32×24 논리 타일은 32×24 3D 단위로 표현하며, 하루 단위 9개 슬라이스 중 첫날에 지형·나무·조명·캐릭터의 매력을 판정한다.** 주민 3명·채집 8종·낚시 8종·도감과 저장 v2는 유지한다. 이 문서는 표현·화면·그 연결부만 바꾼다.

## 1. 확인 범위와 근거

[지시서](redesign-backyard-3d-brief.md)를 전부 읽고, [v0 구현 §6.2](impl-backyard-v0.md#62-로드-실패가-신규-저장으로-갈-수-없는-분기), [RPG 설계 §7](redesign-backyard-rpg.md#7-저장-모델--adr-3-원자-행동을-기준으로-키-분리), [원 게임 설계 §3·§4·§7](design-tycoon-game-2026-09.md)을 대조했다. `git show 6b5abdf` 자체는 인프라 변경 커밋이므로 해당 시점의 **트리**를 기준으로 삼았다. 현재 게임·앱 라우트·저장 호스트 파일과 그 트리 사이의 `git diff 6b5abdf -- …`는 비어 있다. 기존 작업자의 `docs/evidence/rpg-s678/*` 변경과 지시서는 건드리지 않는다.

### 확인한 사실

| 대상 | 확인값 | 근거 |
|---|---|---|
| 패키지·도구 | pnpm 9.15.4; 설치 Next 16.2.10, React 19.2.7, TypeScript 5.9.3, Vitest 4.1.10 | 루트 package.json 및 apps/web/node_modules 각 package.json 읽기 |
| 테스트·빌드 | Vitest `src/**/*.test.ts`; `typecheck`는 tsc; 모바일은 Next static export + trailingSlash | apps/web/package.json, vitest.config.ts, next.config.ts. `lint`는 실패를 noop으로 삼키므로 통과 증거로 쓰지 않음 |
| 현재 OTA ZIP | 1,570,734B | 지시서의 코디네이터 배포 후 실측. 이번 운영 ZIP 재취득은 확인 못 함 |
| 현재 화면 제한 | `(app)`의 헤더·하단 5탭·본문 여백, 등록 높이 520px **상한** | `(app)/layout.tsx`, miniapp-registry.ts, backyard-viewport.tsx의 Math.min |
| Phaser 동봉 파일 | 1,375,976B, gzip -9 상당 352,441B | public/miniapps/vendor/phaser.min.js 직접 읽기, Python gzip level 9·mtime 0. 지시서의 gzip 355KB는 반올림 참고값 |
| Three 동봉 후보 | **r128**, 603,445B, gzip level 9 148,739B | cdnjs `/ajax/libs/three.js/r128/three.min.js`를 메모리로 내려받아 길이·압축 재측정. 지시서의 gzip 145KB와 단위상 대응 |
| ZIP 엔진 기여분 | Three 149,184B / Phaser 354,578B, 차 205,394B | 메모리 zipfile ZIP_DEFLATED level 6의 각 엔트리 compress_size 측정. 실제 배포 ZIP의 엔트리·메타데이터와 동일하다는 보장은 없음 |
| 원본 엔진 바이트 차 | **772,531B, 약 772KB** | 확인한 두 원본 길이의 산술: 1,375,976−603,445. OTA ZIP 감소량이 아님 |
| 규칙 파일 | rpg-rules.js 27,923B, DOM·Phaser 참조 없는 순수 규칙 | 파일 전체의 지도·통행·대상·배치·Life 상태 전이 확인 |
| 표현 파일 | rpg-engine.js 42,411B | Phaser Boot/World·Arcade 물리·생성 스프라이트·HTML 바인딩·세션 연결이 함께 있음 |
| 저장 결합 | rpg-session은 bridge.ready/get/set·주입 타이머에 의존; 브라우저 이벤트 자체는 소유하지 않음 | rpg-session.js. rpg-codec는 legacy BackyardCodec에만 이전 의존 |
| 네이티브 뒤로 | native.ts가 App backButton을 native-bootstrap 콜백으로 보냄 | native-bootstrap.tsx는 현재 일반 경로 back/home/exit 판정만 수행 |
| 저장 훅 | usePlayStates는 가구+appKey로 list; useSavePlayState는 성공 시 query invalidation | queries.ts:747 이후. 키별 직렬 큐는 훅에 없고 miniapp-host.ts에 있음 |

Three 후보 SHA-256: `9274bbcec8d96168626c732b5d31c775aa8cfb7eaa0599bec0c175908a2c1ce2`. 이 파일을 고정한다. 최신 버전이라고 주장하지 않는다. 라이선스 고지와 배포물 해시는 구현 시 동봉 검증에 포함한다.

Memory·context7·sequential-thinking MCP는 이 세션의 사용 가능한 도구 목록에서 찾지 못했다. 과거 학습 로드·Memory ADR 저장·학습 기록은 **확인 못 함**이며 아래에 ADR과 검토 기록을 대신 남긴다. 외부 API는 r128 공식 소스와 Next 공식 문서로 확인했다. 이것은 Task Master 태스크나 신규 PRD가 아닌 지정된 표현 설계 작업이며, 추가 PRD·Task Master 산출물은 만들지 않는다. 문서 검토는 doc-coauthoring의 컨텍스트·구조·독자 질문 관점을 사용하되 지정된 단일 문서 범위 안에서 자체 수행했다.

### 추론·목표 — 실측과 분리

| 판단 | 값·선택 | 근거 |
|---|---|---|
| 전체 OTA 예상 | **약 1.37MB + 새 연결·표현 코드 및 메타데이터 차이** | 추론: 1,570,734−205,394=1,365,340B를 교체만의 기준선으로 계산. 최종 ZIP은 확인 못 함 |
| 일정 | 9작업일, 실패 시 제한된 보정일 별도 | 추론: 기존 콘텐츠·순수 규칙을 재사용. 완성 공수 실측 아님 |
| 시각·성능 | 부드러운 도형 3D, 모바일 지속 30fps 이상 | 추론: 아직 3D 화면·프레임·메모리 실측 없음 |

ZIP 엔트리 수치는 측정된 중간 산술 근거이며 완제품 예측과 구분한다. 재현은 원본 바이트를 메모리에서 gzip level 9 및 ZIP_DEFLATED level 6으로 압축하고 `compress_size`를 읽는 방식이다. 게임 진입 지연 로딩은 초기 JS 실행을 줄여도 OTA 전체 다운로드를 줄이지 않는다. 최종 감소는 슬라이스 9에서 같은 배포 스크립트의 ZIP끼리 재야 확정한다.

## 2. ADR-3D-01: 실행 화면과 라우트

**새 `(game)` 라우트 그룹을 만들고 기존 `(app)/play/app/page.tsx`를 `(game)/play/app/page.tsx`로 이동한다.** 공통 최상위 `app/layout.tsx`와 Providers는 유지한다. URL은 `/play/app?key=backyard`, 모바일 `/play/app/?key=backyard`, 출력은 `out/play/app/index.html` 그대로다. 두 그룹에 같은 page를 동시에 두지 않는다. `/play` 목록·`/more` 진입·appKey=backyard·미니앱 등록부·OTA 배송은 유지한다. 라우트 그룹은 URL에 포함되지 않으며 중복 URL을 만들 수 없다는 [Next 공식 규칙](https://nextjs.org/docs/app/api-reference/file-conventions/route-groups)을 따른다.

게임 화면은 자기 canvas와 HTML HUD를 가지며 iframe·카드·폭 max-w-2xl·520px 상한이 없다. `(app)`의 전체 화면 모드 분기는 금융 화면과 게임 수명주기를 계속 결합하므로 선택하지 않는다. 대신 인증/가구 준비·offline/로그인/온보딩 판정만 공통 경계로 추출해 두 그룹에서 사용한다. 내비게이션 카운터 `noteInAppNavigation`은 공통 단일 관찰 지점으로 옮겨 경로당 한 번만 기록한다. 게임에서 금융 ActivityProvider·PullToRefresh·헤더·하단 탭을 마운트하지 않는다.

등록부는 실행 방식으로 구분한다. backyard는 내장 전체 화면 실행 식별자를 사용하고 `entry`/`height`를 요구하지 않는다. 다른 미니앱의 iframe 실행 항목은 기존 entry·permissions·height를 유지한다. 외부 URL을 내장 코드로 실행하는 범용 로더는 만들지 않는다. 알 수 없는 key는 전체 화면 오류와 `/play` 복귀 버튼을 제공한다. 기존 `/miniapps/backyard/index.html`은 게임 구현 대신 정규 진입 경로 안내/이동용 얇은 호환 페이지로 다시 쓴다. 그 안에는 엔진·독립 저장 writer를 만들지 않는다.

같은 문서 실행으로 opaque iframe의 부모 접근·브릿지 CORS 문제는 없어진다. 다만 Capacitor origin에서 별도 API 서버로 가는 인증/CORS 구성은 기존 api-client가 계속 담당한다. 이를 “모든 네트워크 CORS가 없어진다”로 확대 해석하지 않는다. 게임이 부모 DOM을 볼 수 있다는 교환은 확정된 사용자 결정이다. UI의 기존 “격리 실행” 문구는 제거하고, 지출 미연동·공동 저장 사실만 도움말에 남긴다.

### 전체 화면의 실제 경계

세로를 기본으로 하고 **가로도 허용**한다. 방향 잠금·새 네이티브 플러그인·Fullscreen API 호출에 의존하지 않는다. 게임 루트는 앱 WebView의 가시 영역 전체를 채우고 canvas는 가장자리까지 그린다. 웹 브라우저 주소 표시줄과 OS 상태바까지 숨기는 약속은 하지 않는다. 기본 100dvh와 visualViewport의 resize/offset 변화를 반영하며 body 스크롤 잠금은 진입 시 저장·이탈 시 복원한다.

HUD만 safe-area top/right/bottom/left 안쪽에 12~16 CSS px 여백을 둔다. 기존 viewport-fit=cover를 활용한다. 상태바는 표시한 채 게임의 밝은 하늘과 어울리는 어두운 아이콘을 사용한다. native-bootstrap의 테마 효과와 경쟁하지 않도록 하나의 상태바 소유자가 게임 경로 오버라이드를 적용하고, 이탈 때 앱 테마로 복원한다. 실패하면 OS 기본 표시를 유지하고 HUD를 침범하지 않게 한다. 실제 Android edge-to-edge·iOS 노치 렌더링은 확인 못 함이다.

### 나가기·뒤로·저장

좌상단에 항상 44×44 CSS px 이상 `마당 나가기`를 둔다. 활성 패널 닫기 → 꾸미기 미확정/채집·낚시 취소 → 마당 나가기 순으로 뒤로를 소비한다. Android는 **기존 native-bootstrap의 콜백 한 곳**에서 활성 게임의 back handler를 먼저 호출하고 처리되지 않은 경우에만 기존 판정을 사용한다. App backButton 리스너를 게임이 중복 등록하지 않는다. 마당 본화면에서는 돌아온 앱 경로가 있으면 back, 직접 진입했으면 replace(`/play`)한다. 마당에서 exitApp을 직접 부르지 않는다.

나가기 요청 시 입력을 0으로 만들고 player checkpoint를 flush한다. dirty가 없으면 즉시 이동한다. dirty이면 저장 상태 화면에서 ACK를 기다리고, 8초 실패 후 `다시 저장`·`마당에 머물기`·`저장하지 않고 나가기`를 제공한다. 마지막 선택에만 미저장 변경 소실 가능성을 명시한다. 무한 대기로 사용자를 가두지 않는다.

iOS 가장자리 스와이프와 브라우저 뒤로는 기본 탐색을 유지한다. 패드는 화면 가장자리 24px 바깥에서 시작시키고 전역 touchmove 차단을 하지 않는다. OS 스와이프가 라우트 이탈을 확정한 뒤 이를 취소하거나 위 패널 우선순서를 강제할 수 있다고 가정하지 않는다. 이 경로는 숨김/이탈 flush가 보조 수단이며 마지막 ACK 전 변경은 잃을 수 있다. WKWebView 스와이프 활성 여부는 확인 못 함이므로 항상 보이는 나가기 버튼이 유일한 필수 탈출 경로다. 슬라이스 2·8에서 실제 네이티브 탐색을 확인한다.

## 3. ADR-3D-02: 저장은 직접 연결, 5키 계약은 보존

화면 컴포넌트가 가구·인증을 확인하고 **가구 ID와 backyard를 캡처한 직접 저장 어댑터**를 생성한다. 어댑터 → api-client → 기존 Play API를 사용한다. Three 객체에는 토큰·가구 ID·api-client를 주입하지 않는다. 렌더러는 검증된 논리 상태와 행동 콜백만 받는다.

`usePlayStates`를 호출하는 것만으로 세션을 대체하지 않는다. 이 훅의 캐시 초기값·전역 invalidation과 `useSavePlayState`의 비직렬 mutation을 그대로 연결하면 stale 읽기를 부팅 성공으로 보거나 dirty 상태를 원격 값으로 교체할 수 있다. 이번에는 기존 `createMiniappStateHandlers`의 **키별 HTTP 직렬 큐 책임을 추출·재사용**하고, 직접 어댑터가 세션용 ready/get/set 인터페이스를 제공한다. ready는 postMessage handshake 대신 인증·가구 준비를 뜻한다. 이름은 이행 시 storage로 정리할 수 있지만 행동 의미는 바꾸지 않는다.

한 load 세대에서 API list를 한 번 새로 요청하여 스냅샷을 검증하고 5키와 필요 시 garden을 조회한다. 성공한 items 목록에 키가 없을 때만 null이다. malformed items·state 누락·중복 key·401/403·503·timeout은 오류이며 빈 목록으로 바꾸지 않는다. 다음 load는 같은 캐시를 재사용하지 않는다. 이렇게 5~6회의 list를 1회로 줄여도 서로 다른 기기의 동시 저장에 대한 서버 snapshot/transaction 보장을 추가한 것은 아니다.

### 보존하는 실제 DTO

| 키 | 현재 의미·상한 | 근거 |
|---|---|---|
| rpg_meta | v=2, mapVersion=1, seed=4821 초기값, initialized, migrated; 256B | rpg-codec.js decode/initial/budgets |
| rpg_world | id 0~47, p/w/c, col 0~31·row 0~23 또는 b 보관; legacyFruit; 3072B | 같은 파일. 슬롯 삭제·종류 교체 금지는 session.commit |
| rpg_collection | 16종·수량 99·최초시각·선택적 최초 장소, 최대 60개 재생성 시각, 낚시 3인덱스, completed; 4096B | codec 및 Life. 완료·기록 감소 차단은 session |
| rpg_residents | 주민 r0~r2·경험 비트·대사·배치 서명·표본; 512B | codec 및 Life.talk |
| rpg_player | x 0~511, y 0~383, 방향 0~7, 옷 0~1, t, mapVersion=1; 256B | codec. 기존 engine은 읽을 때 x/y×2 논리 px |

위 B는 **codec가 검사하는 예산**이다. 최대 저장 데이터의 실제 DB 바이트 수로 오인하지 않는다. 각 키 raw JSON과 DB jsonb가 각각 8192B 이하여야 하는 기존 조건도 유지한다. 3D의 Y 높이·메시·조명·카메라·애니메이션은 저장하지 않는다. v3·새 mapVersion·추가 키가 필요 없다.

### 로드 실패와 신규의 분리

다음은 전부 이번 이행의 설계 결정이다. 기존 코드·문서는 보존할 의미의 근거이며 새 어댑터의 실측 결과가 아니다.

| 읽기 결과 | 처리 | 쓰기 | 근거 |
|---|---|---|---|
| 인증/가구 미준비 | waiting, 게임 행동 비활성 | PUT=0 | 설계 결정: 기존 인증 경계 유지 |
| 초기 GET 실패·8초 초과·응답 손상 | load_error, 재시도 | **PUT=0, writer 없음** | v0 §6.2 및 현재 RPG session/integration 테스트 |
| meta 존재 + 필수 키 누락/손상/미지원 버전 | invalid_state/unsupported_version | PUT=0 | 현재 RPG codec/session의 더 엄격한 분기 유지 |
| 정상 5키 존재 | 검증 후 playable | 읽기만으로 PUT하지 않음 | 현재 session |
| 정상 응답에서 meta 없음 | garden·기존 부분 키 검증 → 없는 데이터 4키 ACK → meta 마지막 ACK → playable | 없는 키만 초기 PUT | 현재 session. meta 선쓰기 금지 |
| 초기 PUT 일부 실패 | initialization_error, 부분 상태 유지 후 재로드 | 실패 전 성공 키 덮어쓰지 않음 | 현재 session 및 session 테스트 |

v0의 “손상 튜플 일부 버리고 진행” 정책은 RPG에 옮기지 않는다. 실제 RPG는 잘못된 튜플이나 화분 참조 불일치면 전체 playable 진입을 막는다. meta가 없을 때 garden 이전은 기존 decoder를 사용하며 garden을 수정·삭제하지 않는다. 기존 부분 RPG 키가 정상이면 그것을 우선 보존한다. 기존 session이 메모리 초기값을 내부 준비하는 것과 원격에 신규 저장하는 것은 별개이며, 필수 보장은 실패 시 writer 없음·PUT=0이다.

### ACK·실패·수명

- 키별 localSequence/ackedSequence, 최신 pending 한 개, 요청별 8초 대기, 1/2/4/8/16/30초 상한 재시도를 유지한다. 오래된 ACK는 최신 dirty를 지우지 않는다. HTTP 큐는 session timeout과 별도로 실제 요청 완료까지 직렬화한다. 재시도 Promise가 timeout됐다고 이미 간 서버 PUT이 취소되었다고 취급하지 않는다.
- 획득·대화 기억·꾸미기는 해당 행동의 단일 키로 즉시 저장하고 비위치 변경 ACK 전 다음 의미 있는 변경을 잠근다. 걷기·도감 읽기는 허용한다. 플레이어는 정지 1초·걷기 10초·숨김 flush 기준을 그대로 쓴다.
- 영구 오류는 재시도 중단과 지속 표시, 일시 오류는 최신 스냅샷 유지와 재시도다. 직접 어댑터는 인증/권한/유효성 오류를 host_error 하나로 뭉개지 않는다.
- 복귀 시 clean이면 새 GET을 검증한 뒤 교체, dirty이면 flush하고 ACK 후 재조회한다. 쿼리 캐시 변경이 session 상태를 직접 덮지 않는다. 가구/앱/로그아웃 변경은 세대를 폐기하고 입력·루프·타이머를 정리한다. 이전 가구 응답은 새 가구에 적용하지 않는다.
- 같은 가구·앱·키의 이탈 직전 HTTP와 재진입 HTTP도 같은 큐 레지스트리에서 순서를 지킨다. 큐의 이미 시작한 작업은 캡처한 가구로만 끝나며 새 UI 콜백을 호출하지 않는다. 정리된 큐는 완료 후 제거한다. 세션 재시도 타이머를 전역에 남기지 않는다.

서버 revision/CAS가 없으므로 두 기기의 같은 키는 마지막 쓰기 우선이다. 직접 연결이 그 한계를 없애지는 않는다. “같은 마당을 공유해요. 동시에 바꾸면 마지막 저장이 남아요” 안내를 유지한다. ACK 전 앱 강제 종료도 무손실 보장이 없다. 오프라인 outbox·공동 편집 프로토콜은 이번에 추가하지 않는다.

## 4. 파일별 재사용·교체 판정

경로 앞의 `backyard/`는 `apps/web/public/miniapps/backyard/`, `lib/`는 `apps/web/src/lib/`다. 다음은 **향후 구현 변경 계획**이며 이번에는 이 문서만 작성한다.

| 현재 파일 | 판정과 옮길 책임 | 근거 |
|---|---|---|
| backyard/rpg-rules.js | 규칙·Life 콘텐츠 그대로 보존. 필요 시 정적 모듈 export 포장만 변경 | 순수 함수이나 32px 타일·96px/s·40px 근접·14×10 발 충돌 등 논리 px 사용. 행/열만이라는 가정은 부정확 |
| backyard/rpg-codec.js | 그대로 보존, 로딩 방식만 맞춤 | DTO v2·mapVersion 1은 표현 독립; migrate만 BackyardCodec 의존 |
| backyard/rpg-session.js | 상태기계·writer 보존, 직접 storage 어댑터 연결 및 로드 세대 snapshot 사용 | bridge/타이머 주입 구조이므로 postMessage를 필수로 하지 않음 |
| backyard/balance.js | legacy 이전 의존으로 유지 | codec 이전 경로에서 필요한 v1 상수 |
| backyard/rules.js | legacy 이전 의존으로 유지 | v1 codec가 Garden 규칙을 참조. 3D 이동에 사용하지 않음 |
| backyard/codec.js | v1 읽기·이전 전용으로 유지 | rpg-codec.migrate의 직접 의존 |
| backyard/rpg-engine.js | Phaser 표현·Boot/World·Arcade 제거, 새 3D 씬/논리 controller/HUD 연결로 분리 | 렌더 외에 act, safePosition, 낚시 진행, 완료 ACK 뒤 패널, 모달 초점도 있어 단순 삭제하면 동작 손실 |
| backyard/rpg-input.js | 전체 화면 입력 어댑터로 다시 작성 | pointer 소유자 1개·cancel/lostcapture·blur/reset 원칙과 테스트 의미는 유지 |
| backyard/rpg-style.css | 게임 경계에 scope된 스타일로 다시 작성 | 현재 전역 *, body, main, button 선택자는 부모 금융 DOM에 누출됨 |
| backyard/index.html | Next 전체 화면 페이지가 게임 UI 소유; 옛 정적 URL은 안내/이동 페이지로 교체 | 독립 script 순서·iframe bridge·520px UI 불필요 |
| backyard/app.js | 새 제품 진입 그래프에서 제외 | 옛 v0 실행기, RPG index는 로드하지 않음 |
| backyard/input.js | 새 제품 진입 그래프에서 제외 | v0 전용 입력 |
| backyard/renderer.js | 새 제품 진입 그래프에서 제외 | v0 canvas 표현 |
| backyard/session.js | 새 제품 진입 그래프에서 제외 | v0 저장 세션; RPG session으로 대체되어 있음 |
| backyard/style.css | 새 제품 진입 그래프에서 제외 | v0 독립 UI |
| public/miniapps/vendor/phaser.min.js | 새 OTA에서 제외, Three 고정 파일 한 벌로 교체 | 새 3D는 Phaser 사용하지 않음. 구 배포물은 롤백 저장소에 보존 |
| public/miniapps/bridge.js | 다른 iframe 미니앱용 유지, backyard는 호출하지 않음 | 같은 문서에 postMessage·ready handshake 불필요 |
| components/miniapp/miniapp-host.tsx | 공용 iframe 호스트 유지, backyard 실행에서 제외 | 신뢰 경계가 다른 미니앱에 적용될 수 있음 |
| lib/miniapp-host.ts | iframe runtime 유지; state handler의 큐·가구 캡처를 재사용 가능한 저장 어댑터로 추출 | 전송 수단과 저장 직렬화는 다른 책임 |
| packages/shared/src/miniapp-bridge.ts | 공용 계약 유지 | 다른 미니앱·기존 테스트용. 새 게임에 message envelope 강제하지 않음 |
| components/miniapp/backyard-viewport.tsx | backyard 실행에서 제거·폐기 | iframe 높이·하단 탭 감지·부모 pause 전송 전용 |
| lib/miniapp-registry.ts | 내장/iframe 실행 방식 구분으로 변경 | appKey·목록·권한 0개는 유지, 내장에 height 강제 안 함 |
| (app)/play/app/page.tsx | (game)/play/app/page.tsx로 이동·다시 연결 | Suspense/useSearchParams/static export 유지 |
| (app)/layout.tsx 및 app/providers.tsx 주변 | 인증/가구·경로 관찰 공통 경계만 추출 | 게임이 금융 셸 없이도 인증·가구 준비를 통과해야 함 |
| lib/native.ts, components/native-bootstrap.tsx | 기존 back callback·상태바 소유자에 게임 경로 연결 | 두 개의 뒤로 리스너가 동시에 탐색하는 회귀 방지 |
| lib/queries.ts·api-client.ts·API/계약/DB | 저장 계약 유지, 엔진 때문에 서버 변경 없음 | 현재 list/save를 가구 캡처 어댑터가 직접 사용 가능 |

이전 v0 파일을 실제 저장소에서 삭제할지는 참조 테스트를 확인해 결정하되, 새 OTA에서 빼려면 public에 남겨 둘 수 없다는 점을 지킨다. 테스트 전용 fixture가 필요하면 제품 public 밖으로 옮긴다. 새 배포에 2D·3D 엔진을 둘 다 싣지 않는다.

테스트도 파일별로 판정한다.

| 파일 | 판정 | 근거 |
|---|---|---|
| lib/game-backyard-rpg.test.ts | 유지 | 이동 벡터·통행·근접·배치 순수 규칙 |
| lib/game-backyard-rpg-life.test.ts | 유지 | 3주 부재·재생성·주민·낚시 등 콘텐츠 규칙 |
| lib/game-backyard-rpg-album.test.ts | 유지 | 도감 기록·완료·장소·손상 판정 |
| lib/game-backyard-rpg-codec.test.ts | 유지 | v2 경계·라운드트립 |
| lib/game-backyard-rpg-session.test.ts | 유지, 직접 어댑터 실패 케이스 추가 | 초기 GET 실패·부분 초기화·meta 마지막·ACK·키 잠금·checkpoint |
| lib/game-backyard-rpg-test-utils.ts | 로더만 변경 | 현재 vm이 배포 JS를 읽음. 복제한 규칙을 테스트하면 안 됨 |
| lib/game-backyard-rpg-integration.test.ts | HTTP fixture·행동 기대 유지, bridge 연결부를 direct adapter로 변경 | 실제 PUT=0·단일 키 저장·503 복구 검증이 핵심 |
| lib/game-backyard-rpg-lifecycle.test.ts | 다시 작성 | iframe detachedDocuments와 Phaser 잔존 +40은 새 동일 문서 실행의 합격 기준이 아님 |
| lib/miniapp-host.test.ts·miniapp-client.test.ts·shared/miniapp-bridge.test.ts | 공용 계약 회귀로 유지 | 다른 iframe 실행을 보존하며 저장 큐 추출의 영향 확인 |
| scripts/verify-backyard/rpg-export.mjs | Three 전체 화면 E2E로 교체 | 현재 frame 탐색·Phaser scene/physics 직접 참조 |
| scripts/verify-backyard/rpg-host-lifecycle.mjs | 실제 Next 경로 반복 진입 검증으로 교체 | 문서 탈착이 아닌 같은 부모 문서에서 자원 해제 증명 필요 |
| scripts/verify-backyard/rpg-lifecycle.mjs·rpg-lifecycle.js | Three 반복 생성/해제·context loss 검증으로 교체 | Phaser 계수 기대 제거, 이벤트·RAF·GPU 자원 기준 신설 |
| scripts/verify-backyard/rpg-s45.mjs·rpg-s678.mjs | 행동 시나리오는 유지, frame/DOM/엔진 선택자는 교체 | 주민·채집·낚시·꾸미기 검증 의미는 동일 |

## 5. ADR-3D-03: 논리 세계를 보존하는 3D 씬

### 좌표·충돌·카메라

논리 좌표 `(u,v)`는 기존 `(x,y)` px 그대로 유지한다. Three 좌표는 **X=u/32−16, Z=v/32−12, Y=h(X,Z)**다. 타일 중심은 `(col+0.5−16, row+0.5−12)`이다. 지도는 X −16~16, Z −12~12, 플레이 가능 지형 32×24 단위다. 경계 밖 장식 지형 2단위는 통행·저장 대상이 아니다. 북쪽은 −Z, 동쪽은 +X다.

저장 player `(sx,sy)`는 논리 `(2sx,2sy)`, 렌더 `(sx/16−16, sy/16−12)`다. 저장할 때 논리 값을 2로 나눈 정수로 양자화하고 기존 허용 범위를 검사한다. 기존 초기 `(120,296)`은 논리 `(240,592)`, 3D `(−8.5,h,6.5)`로 복원된다. 읽기 위치가 막혔으면 기존 safePosition의 가까운 통행 타일 탐색을 controller로 옮기고, 로드만으로 보정 위치를 자동 저장하지 않는다.

Phaser Arcade 물리는 제거하되 물리 라이브러리를 추가하지 않는다. controller가 고정 1/60초 이동을 계산하고 `canStand`로 축별 이동·미끄러짐을 판정한다. 빠진 프레임 누적은 100ms까지만 허용하고 복귀 첫 프레임 delta는 0으로 한다. 한 검사 이동은 논리 4px 이하로 분할해 얇은 줄기·둑 통과를 막는다. 기존 발 영역 x±7·y−10~y, 장애물·물 마스크·배치 경로 검사를 그대로 쓴다. 높이는 시각 효과라 경사 때문에 새로운 통행 불가·점프·낙하를 만들지 않는다.

카메라는 원근 3인칭 추종, **방위각 고정**이다. 플레이어 뒤를 위치로 따르지만 방향 전환마다 회전하지 않는다. 북쪽을 향해 내려다보며 시선 하향 약 40°, 수직 FOV 45°, near 0.1, far 80, 초기 추종 오프셋 (0,8,10), 시선 목표는 발 위 0.65단위다. 세로에서 캐릭터가 너무 작으면 오프셋을 비례 축소하되 몸 전체 화면 높이 12~16%를 첫날 조정 기준으로 삼는다. 위치 추종 지연은 약 150ms, 캐릭터가 화면 가로 중앙·세로 55~60%에 보이도록 투영 기준을 맞춘다. 진입·저장 복원·회전 때는 보간 없이 목표에 붙이고 멀미를 만드는 급회전·카메라 흔들림은 없다.

가로는 수직 시야와 캐릭터 크기를 유지하며 좌우가 더 보인다. 카메라 목표는 지도 안에 두고 지도 끝에서는 바깥 2단위 지형·울타리·안개로 빈 배경을 막는다. 나무가 플레이어를 가리면 카메라 회전 대신 시선 통로에 들어온 수관만 축소/숨김하며 줄기·충돌은 그대로 둔다. 전체 수관을 투명하게 만들어 정렬 문제를 늘리지 않는다. 가림 해제는 약 150ms로 되돌린다.

### 구체적인 기하·재질 시작값 — 모두 설계값

| 요소 | 기하와 파라미터 | 근거 |
|---|---|---|
| 지형 | 32×24 셀 높이맵, 기본 33×25 정점·1536 삼각형; Y −0.1~0.45, 인접 높이 차 ≤0.12. 길·가구 발판·연못 둑은 평탄화 | 추론: 낮은 폴리 수와 안정된 접지. 삼각형 위 barycentric 높이를 캐릭터에도 적용해 떠 보임 방지 |
| 잔디 | vertex color 3톤 `#A9BF83`, `#B7CB91`, `#97B575`; 넓은 군집 단위 색 분포, smooth normals·Lambert 재질 | 추론: 무작위 타일 체커무늬를 피하고 큰 색 면 유지 |
| 길·둑 | rules.paths/water 마스크에서 지형에 맞는 면 생성; 길 `#D9C9A3`, Y +0.01; 외곽 둑 폭 0.15~0.2 | 추론: 화면 둑과 규칙 충돌이 다른 지도를 만들지 않음; 물 안으로 육지를 둥글게 확장하지 않음 |
| 나무 12그루 | 줄기 원기둥 반지름 0.18·높이 1.1·8면; 수관 구 2~3개, 반지름 0.65/0.8/0.55, 총높이 2.3~2.8, 구 12×8 분할 | 추론: rules.trees의 동일 위치, 수관만 변주. 줄기는 기존 논리 장애물 발자국에 맞춤 |
| 나무 재질 | 잎 `#6F965D`/`#85AA6B`, 줄기 `#947657`, Lambert, 불투명·양면 아님 | 추론: 잎 텍스처 없이 면의 명암으로 부피 표현 |
| 집·가구 | 집은 기존 4×2단위 footprint, 벽 상자+삼각 지붕; 가구는 1칸 안, 원기둥·구·모서리 작은 부품 조합 | 추론: 화분·우물·의자·작업대 의미·충돌 유지. 새 건물/가구 종류 없음 |
| 물 | 계단 마스크의 한 통합 mesh, 바닥 Y −0.18·수면 −0.08; `#7FB8B4`, opacity 0.72, transparent·depthWrite=false, 그림자 cast/receive 없음 | 추론: 평면 반사·굴절·SSR 없이 바닥색을 비침. 겹친 물 plane 금지 |
| 잔물결 | 최대 6개 얇은 타원 띠 기하, Y 수면+0.01, 3~5초 주기 확대·소멸, 위치는 고정 seed | 추론: 물리·획득 판정과 독립. PNG/normal map 없음 |
| 하늘·구름 | 카메라 중심 반구 16×8 분할, 아래 `#E7EAD0`→위 `#99CBDA` vertex gradient, Basic·BackSide·depthWrite=false; 구름 3무리 각 구 3개 | 추론: 하늘 이미지·HDRI 없이 배경 깊이. 구름 그림자·충돌 없음 |
| 공간 통일 | 안개색 `#DCE4C8`, 시작 25·끝 55단위, 시스템 한글 폰트 HUD | 추론: 원경 경계를 부드럽게 연결, 글자는 3D 메시로 만들지 않음 |

### 조명·색 관리·그림자

반구광 sky `#FFF2D4`, ground `#779067`, intensity 0.75, 방향광 `#FFF0D0` intensity 0.9를 시작값으로 둔다. 방향광은 장면 기준 (−10,16,8) 방향, 그림자는 하나만 만든다. 지형·나무는 완만한 명암, 캐릭터는 2단 툰 명암으로 구분한다. 계절·밤낮에 따라 매번 라이트를 다시 설계하지 않는다. 첫 장면은 따뜻한 낮으로 고정한다.

r128의 `outputEncoding=sRGBEncoding`과 NoToneMapping을 기준으로 색을 조정하고 입력 팔레트는 작업 색공간으로 일관되게 변환한다. 최신 버전의 outputColorSpace·색 관리 기본값을 r128 코드에 섞지 않는다. 해당 속성은 [r128 WebGLRenderer 원문](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/renderers/WebGLRenderer.js)에서 확인했다.

그림자는 **PCFSoftShadowMap, 1024×1024**, 방향광 정사영 그림자 영역은 카메라 주변 약 20×20단위·near 1/far 40부터 시작한다. 지도 전체 32×24를 한 맵에 무조건 넣어 선명도를 잃지 않는다. 카메라·그림자 영역 이동은 shadow texel 간격에 맞춰 흔들림을 줄인다. bias −0.0002, normalBias 0.02를 시각 검사 시작값으로 두고 발밑 그림자 분리·줄무늬가 보이면 조정한다. PCFSoft에서 radius만 올려 넓은 스튜디오 그림자가 된다고 약속하지 않는다. 반구광으로 그림자 대비를 낮추고 해상도·영역·접지의 조합을 먼저 본다.

캐릭터 4명·수관·집·가구만 cast, 지형·길·가구 주요 면만 receive한다. 수관 내부 작은 장식·눈·외곽선·물·구름은 cast하지 않는다. 기본은 움직임이 있을 때 매 렌더 프레임 갱신, 완전히 정지하면 재사용한다. 저품질은 512²·15Hz로 낮춘다. VSM의 추가 블러 패스는 초기 범위에서 제외한다. r128이 그림자 pass를 별도로 그리고 VSM이 두 방향 blur를 더 실행하는 것은 [공식 소스](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/renderers/webgl/WebGLShadowMap.js)로 확인했다. 1024² RGBA 색 버퍼만 약 4MiB라는 산술과 실제 depth/드라이버 포함 GPU 메모리는 구분하며 후자는 확인 못 함이다.

## 6. 캐릭터·주민·도감 표현

플레이어 키 1.35단위, 머리 지름 0.66(키 약 49%), 둥근 몸 높이 0.48·폭 0.44, 짧은 다리 0.23, 팔 0.30을 시작 비율로 삼는다. 머리는 구 16×12, 몸은 원기둥 양 끝에 반구를 합친 **캡슐 형태**다. r128 기본 geometry 목록에 CapsuleGeometry가 없으므로 최신 API를 전제로 쓰지 않는다. [r128 geometry 목록](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/geometries/Geometries.js)에 있는 구·원기둥을 결합한다. 눈은 검은 작은 구 2개, 머리카락은 얇은 구 일부로 표현하며 표정 텍스처는 없다. 기존 outfit 0/1은 옷색 변형만 유지한다.

MeshToonMaterial의 gradientMap에 **런타임 생성 2×1 DataTexture** 두 밝기(약 0.55/1.0), nearest 샘플링·mipmap 없음으로 2단 명암을 만든다. 이미지 **파일** 0개와 GPU에 생성하는 2픽셀 데이터는 다른 개념이다. 반구광이 완전한 검정 그림자를 막고 방향광만 툰 경계를 만든다. 툰 직접광/간접광 경로는 [r128 공식 셰이더](https://raw.githubusercontent.com/mrdoob/three.js/r128/src/renderers/shaders/ShaderChunk/lights_toon_pars_fragment.glsl.js)를 따른다.

외곽선은 머리·몸·귀의 뒤집은 hull을 normal 방향 0.012~0.018단위 팽창시키고 BackSide·짙은 올리브 `#4D5C48`로 그린다. 눈·손가락 등 작은 파츠마다 추가하지 않는다. 카메라에서 1~2 CSS px 정도로 보이는지 확인한다. 얼굴 안에 검은 겹침·팔 연결부 검은 링이 생기면 hull 대상을 줄인다. 화면 전체 OutlinePass·후처리·SSAO·Bloom은 쓰지 않는다. 외곽선 비용은 실제 드로우콜 예산에 포함한다.

걷기는 본·스킨 없이 Object3D 관절 부모의 회전으로 만든다. 이동거리 0.8단위마다 한 주기, 반대 팔·다리 ±20°, 몸 Y 진폭 0.025단위, 머리 ±2°를 기본으로 한다. 정지 시 120ms 동안 기본 자세로 복귀한다. 충돌로 제자리일 때 발만 달리지 않도록 의도 속도 대신 **실제 이동거리**로 위상을 진행한다. 주민 walk/휴식/대화 멈춤 시간은 Life 그대로이며 낚싯대·뜰채·앉기는 동일 관절의 짧은 포즈로 연결한다.

| 주민 | 색을 지워도 남는 실루엣 | 근거 |
|---|---|---|
| 모루 곰 r0 | 키 1.4, 폭 넓은 몸 0.65, 둥근 귀 2개·둥근 주둥이, 짧고 묵직한 발 | 추론: 기존 bear 정의의 시각화, 관계·대사·경로 유지 |
| 두리 새 r1 | 키 1.2, 물방울형 몸, 양옆 넓은 날개, 짧은 원뿔 부리·가는 발 | 추론: 기존 bird 정의의 시각화 |
| 소담 토끼 r2 | 몸 키 1.25+긴 귀 0.45, 폭 좁은 몸·길쭉한 발, 위로 긴 실루엣 | 추론: 기존 rabbit 정의의 시각화 |

채집·물고기 16종은 현재 species ID와 drawSpecies의 색·폭·날개·줄무늬·점·수염 구분을 작은 기하 조합으로 옮긴다. 도감 탭·발견 힌트·최초 장소·날짜·표본·완료는 그대로다. 각 카드마다 WebGL context를 만들지 않는다. 도감이 열리면 세계 렌더를 정지하고 **동일 renderer의 scissor 영역**으로 보이는 카드 표본만 정적으로 그리며, 카드 텍스트·초점·스크롤은 HTML이 맡는다. 도감 HTML의 표본 창은 투명하게 두고 canvas를 그 아래에 배치한다. getBoundingClientRect로 얻은 카드 영역을 canvas 좌표로 변환하고 스크롤 영역과 교차한 scissor만 그려 패널 밖으로 표본이 새지 않게 한다. 스크롤/탭/회전 때만 다시 그린다. 획득 카드 표본도 같은 모델을 사용한다. 캡처 PNG를 제품 에셋으로 저장하지 않는다.

## 7. 전체 화면 조작과 HUD

세로 패드는 좌하단 safe-area+24px 위치의 112px 원형(노브 44px), 우하단은 64px 이상 행동 버튼과 짧은 대상 라벨이다. 320px 폭에서는 패드를 96px로 줄이고 두 영역 사이 최소 24px를 둔다. 도감·나가기·저장 상태는 상단에 놓으며 금융 헤더처럼 띠 전체를 채우지 않는다. 저장 실패는 지속 표시하고 자동 소멸 토스트로 숨기지 않는다. 가로는 같은 좌우 모서리를 쓰되 최대 112px로 고정한다. HUD 면적을 뺀 별도 작은 canvas를 만들지 않고 그 위에 버튼을 겹친다.

입력 기준은 **카메라 화면 방향**이다. 수평 right와 전방을 XZ 평면에 투영해 논리 방향으로 변환한 뒤 기존 velocity의 8방향·정규화 규칙을 호출한다. 방위각 고정으로 패드 위=북쪽(−Z), 오른쪽=동쪽(+X)이 항상 성립한다. 속도 96px/s=3단위/s, NPC 24px/s=0.75단위/s는 보존한다. 패드 반경의 약 20%를 dead zone으로 두되 결과 속도는 기존 8방향 고정 속도다. 자유 카메라 회전·핀치·점프·탭 자동 길찾기는 추가하지 않는다.

pointer 한 개만 패드를 소유하고 두 번째 손가락은 행동 버튼을 누를 수 있다. pointercancel/lostcapture·창 blur·숨김·패널 열기·가구 변경·회전 때 같은 이벤트에서 입력 0. 모달이 열린 동안 WASD/방향키가 뒤 게임을 움직이지 않고 텍스트/버튼 포커스를 침범하지 않는다. Escape·Enter/Space·방향키, 최소 44px 터치 타깃, 모달 포커스 가두기·닫은 뒤 원래 버튼 복귀·reduced-motion의 bob 제거를 유지한다.

근접은 3D 메시와 Raycaster의 겉면 거리가 아니라 **발 위치의 논리 평면**에서 기존 `target`을 호출한다. 40px=1.25단위, 전방 ±60°, obstacles 기반 시선 차단, 거리 동률 ID 정렬을 그대로 유지한다. Raycaster는 있더라도 시각 가림 판정만 담당하고 획득 권위를 갖지 않는다. 행동 누르는 순간 다시 판정한다. 수관이 커져도 줄기의 논리 장애물은 바뀌지 않으며 표본을 멀리서 탭해 획득할 수 없다.

꾸미기는 기존 앞 칸 preview/placementReason으로 선택하고 타일 표식과 고스트 모델만 3D로 그린다. 색뿐 아니라 `놓을 수 있어요`/거절 이유를 함께 표시한다. 보관·이동·48슬롯·경로 연결성·화분 readyAt 보존은 기존 규칙에 맡긴다. HUD 문자열·도감 레코드·주민 기억의 단일 출처를 새 엔진 안에 복제하지 않는다.

## 8. 모바일 성능 목표·측정·수명

### 예산 — 아직 실측되지 않은 합격 목표

| 항목 | 목표 | 근거 |
|---|---|---|
| 일반 품질 | 60fps 지향, 30fps 최소; 낮은 기기에서는 명시적 30fps cap | 추론: 전체 화면 픽셀 수 증가를 고려 |
| 지속 프레임 | 30fps 모드의 화면 제출 간격 p95 ≤35ms, p99 ≤50ms, 50ms 초과 <1% | 추론: 10분 장면 반복의 후반 3분에도 충족 |
| CPU 작업 | 입력+규칙+NPC+render 제출 p95 ≤10ms, 60fps 목표에서는 ≤6ms | 추론: RAF 간격과 CPU 실행 시간을 별도 측정 |
| 터치 반응 | pointerdown부터 첫 시각 반응 p95 ≤100ms | 추론: 입력 불편을 평균 fps로 숨기지 않음 |
| geometry | 화면 표시 ≤50,000삼각형, 그림자 포함 제출 ≤100,000 | 추론: 4캐릭터·12나무·48가구 최대 상태 |
| draw calls | 메인 ≤80, 그림자·외곽선·도감 합계 프레임당 ≤140 | 추론: 장면별 renderer.info 계측, 모든 pass 합산 |
| 렌더 해상도 | 기본 DPR min(deviceDPR,1.5), 최대 150만 픽셀; 축소 단계 1.25→1.0→0.85 | 추론: CSS UI 해상도와 canvas 내부 해상도 분리 |
| 반복 진입 | 20회 뒤 살아 있는 게임 RAF·입력·게임 timer·renderer 0; 메모리 단조 증가 없음 | 추론: 같은 부모 문서에서 누수의 영향이 커짐 |

반복 수관/줄기/가구 부품은 geometry·material별 InstancedMesh로 묶는다. 색은 instance color, 가구 이동 시 해당 instance matrix만 갱신한다. 8×8단위 공간 묶음으로 나눠 보이지 않는 묶음을 제외하고, r128 instancing의 경계/culling 동작은 구현 시 실제로 확인한다. 캐릭터는 4개뿐이므로 관절 가독성을 우선하고 움직이지 않는 머리·눈·귀 묶음은 사전 결합한다. 작은 파츠마다 다른 material을 생성하지 않는다. 정적 지형·길은 vertex color로 합치며 “폴리곤이 적으니 드로우콜도 적다”로 계산하지 않는다.

### 구체적인 측정 절차

1. 실제 대상 Android·iPhone 각각에서 기기명, SoC, RAM, OS, Android System WebView/WKWebView·앱 빌드, 화면 CSS 크기·DPR·배터리/충전 상태를 기록한다. 사용자의 기기 목록은 **확인 못 함**이다. 최소 2대 확보 전 모바일 합격을 선언하지 않는다. 데스크톱 에뮬레이션은 UI 검사만 보조한다.
2. production mobile export로 설치/OTA 시험한다. 로컬 에셋은 offline 상태에서도 로드되는지 확인하고 저장 네트워크 실패와 엔진 부팅 실패를 분리한다. 최초 shader compile을 포함한 진입부터 조작 가능까지 시간은 별도 기록한다. warm-up 30초를 steady-state 지표에서 제외하되 최초 진입 지연을 감추지 않는다.
3. seed=4821, 기본 상태와 **48가구+3주민+플레이어+12채집점** 최대 상태 두 fixture를 사용한다. 집→나무 사이→연못 3점→꾸미기→도감 3탭→닫기 루트를 3분씩 3회 반복하고, 최악 장면을 총 10분 유지한다. 같은 카메라 경로·품질·밝기로 2D 기준과 3D를 비교한다.
4. RAF timestamp와 실제 render 호출 timestamp를 모두 기록한다. 30fps cap에서 건너뛴 RAF를 렌더 프레임으로 세지 않는다. performance.now로 규칙/NPC/제출 구간 CPU 시간을 나눈다. renderer.info의 calls/triangles를 shadow·main·scissor pass 전체에 대해 누적하고 프레임 끝에 reset한다. 평균·p50·p95·p99·50ms 초과 비율을 기록한다.
5. Android 원격 DevTools Performance, iOS Safari Web Inspector 타임라인으로 main-thread stall·GC·GPU 병목 징후를 확인한다. GPU timer query 확장이 있으면 비동기 결과와 disjoint 여부를 검사해 측정하고 없으면 **GPU 시간 확인 못 함**으로 남긴다. render 함수 반환 시간을 GPU 완료 시간으로 부르지 않는다.
6. 진입/이탈 20회, 화면 회전 10회, 백그라운드 30초 후 복귀, 가구 전환, GET/PUT 503·timeout·늦은 ACK, WebGL context 강제 loss/restore를 실행한다. 입력 고착·세대 간 응답·RAF/timer/리스너·renderer.info.memory의 살아 있는 자원과 JS heap의 안정화 추세를 기록한다. OS GPU 메모리를 못 보면 확인 못 함으로 적는다.
7. 산출물은 구현 단계에서 기기별 스크린샷, 10초 걷기 영상, 프레임 CSV/JSON·타임라인·HTTP PUT 기록·라이프사이클 계수로 남긴다. 이번 문서 작업에서 이 증거를 만들었다고 주장하지 않는다.

### 목표를 못 맞출 때 낮추는 순서

기본 순서는 **그림자 → 폴리곤/파츠 → 해상도**다. 그림자는 1024² 매 프레임에서 512²·15Hz로, 작은 가구 caster 제거, 마지막으로 지형의 실제 그림자를 유지할 수 없는 최저 모드에서 절차적 접지 타원으로 대체한다. 이 마지막 단계는 시각 가설을 약화하므로 다시 시각 게이트를 통과해야 한다. 그 다음 수관 12×8→8×6, 원경 구름 제거·작은 파츠 결합·잔물결 수 감소, 마지막에 DPR 1.25→1→0.85를 적용한다. 캐릭터 머리·귀 실루엣과 HTML 글자 해상도는 먼저 희생하지 않는다.

다만 프로파일이 fragment fill-rate 병목을 명확히 보이면 해상도 조정을 먼저 A/B 측정할 수 있다. 순서 변경의 측정 근거를 남긴다. 품질 자동 하향은 연속 5초 예산 초과 후 한 단계씩, 상향은 최소 60초 안정 이후에만 하여 화면이 출렁이지 않게 한다. 저장·논리 속도·콘텐츠를 품질 옵션에 결합하지 않는다.

### 수명과 실패 UI

렌더러·scene·camera·리스너·RAF·입력은 게임 인스턴스 하나가 소유한다. unmount는 입력 reset→RAF 취소→session.destroy→이벤트/observer 해제→geometry/material/생성 texture/render target dispose→renderer dispose→canvas 제거 순으로 정리한다. 공유 geometry/material은 인스턴스 소유 목록에서 한 번만 해제한다. React StrictMode 생성/해제/재생성에서도 하나만 살아야 한다.

숨김 시 RAF와 게임 진행시간은 정지하고 수확의 절대 시각은 보존한다. context loss 시 입력·진행 정지와 HTML 안내를 표시하고 메모리 session을 유지한다. restore는 검증된 상태에서 GPU 자원만 재생성하며 실패하면 `다시 열기`·`마당 나가기`를 준다. WebGL 부팅 실패·동봉 파일/버전 불일치·shader compile 오류를 빈 canvas로 남기지 않는다. 게임 시작 전 저장 GET 실패 역시 3D 초기값 장면을 플레이 가능한 것처럼 보여 주지 않는다.

## 9. 하루 단위 슬라이스 — 9개

아래 순서와 기간은 추론이며 각 완료 증거는 향후 구현 산출물이다. 첫 시각 게이트 실패 중에는 콘텐츠 연결을 진행하지 않는다.

| 일/슬라이스 | 하루 끝 결과 | 끝났다는 증거·게이트 | 근거 |
|---|---|---|---|
| 1. 매력의 가설 | 같은 부모 문서의 화면 전체에 지형·수관 12그루·반구/방향광·부드러운 그림자·캐릭터 1개. 읽기/쓰기 없는 fixture 장면 | 360×800·가로 800×360 동일 장면 스크린샷, 조명 on/off 비교, 대표 모바일 첫 프레임 기록. 사용자 시각 게이트: 둥근 형태·부드러운 접지·명확한 캐릭터·기존 2D보다 선호를 확인 | 추론: “동물의 숲처럼 보이는가”를 가장 먼저 판단 |
| 2. 앱 화면 진입·탈출 | (game) 라우트·공통 auth guard·가구 준비·registry·HUD safe-area·기본 뒤로/상태바 연결 | 기존 URL 및 직접 진입, 인증 실패·가구 없음, Android 뒤로/iOS 버튼/가능한 스와이프, 가로 회전. header/tab/iframe 0개, out/play/app/index.html 존재, 이탈 뒤 금융 화면 원상 복원 | 추론: 화면 약속을 먼저 고정 |
| 3. 걷기·지도 연결 | 좌표 adapter·카메라·이동·나무 가림·3D 물/길/집·새 입력 | 기존 규칙 테스트 유지; 저장 좌표 왕복·벽/나무/물/모서리·최대 delta·패드 cancel·다중 터치. 같은 논리 경로를 2D/3D에서 비교하고 10초 영상으로 접지 확인 | 추론: 충돌과 표현 오차를 여기서 제거 |
| 4. 저장 이행 | direct storage·키별 HTTP 큐·기존 session/codec·로드 오류·나가기 저장 상태 | 실제 HTTP fixture로 초기 GET 503/timeout/손상 PUT=0; 신규/부분 초기화 meta 마지막, garden 보존, 늦은 ACK·가구 변경·재진입 큐·dirty 복귀 검사 | 추론: 데이터 손실 회귀를 콘텐츠 전에 차단 |
| 5. 주민 표현 | 모루·두리·소담 3D 파츠·걷기·말하기/표본/함께 앉기 연결 | 이름/색을 가린 실루엣 식별, 기존 Life 대사·경로·mask 결과와 동일, 대화 중 정지·초점 복귀·관계 PUT 한 키 확인 | 추론: 주민 콘텐츠 신규 작성 없음 |
| 6. 채집·낚시·도감 | 16종 기하·도구 포즈·3개 낚시점·도감 scissor·완료 화면 | 기존 16종 ID 전부 표시·획득 가능, 취소/재생성/99상한·장소 기록·단일 collection PUT·ACK 후 완료, 패널 뒤 입력 0·추가 WebGL context 0 | 추론: 기존 루프의 표현 교체 |
| 7. 꾸미기·연동 회귀 | 48슬롯 가구·고스트·이동/보관·가림·최대 장면 인스턴싱 | 48개 포함 저장 왕복, 길 차단 거절·화분 시각 유지·옷 2종·기존 콘텐츠 회귀. 기본/최대 장면 draw call·triangle 수 1차 기록 | 추론: 세계 규모를 최대 상태에서 검증 |
| 8. 모바일 성능·수명 | 실제 2기기 10분 시험·품질 단계·20회 진입/이탈·context loss | §8 p95/p99·입력 지연·자원 0 기준, 백그라운드/회전/저장 실패/나가기 전부 충족. 품질 하향 장면도 사용자 시각 기준 유지 | 추론: 데스크톱 결과를 모바일 증거로 대체 금지 |
| 9. 배포 후보·롤백 검증 | production 웹/모바일 빌드·정적 asset 동봉·롤백 후보 확인 | 타입검사·관련 Vitest·실제 경로 E2E·정적 export; CDN 요청 0·이미지 에셋 0·Phaser 동봉 0; ZIP 실측 비교; 같은 v2 저장으로 2D 복귀 검증 | 추론: ZIP 절감·기존 경로·저장 호환을 마지막에 확정 |

새 단위 테스트는 구현과 함께 happy/edge/error를 포함하고 배포 규칙 원본에 실행한다. 문서-only인 이번에는 제품 테스트·빌드·시각 시제품을 실행하지 않는다. 향후 출하 체크는 web `typecheck`, 해당 Vitest 테스트, miniapps rules/dom 타입 검사 설정, 웹 build와 build:mobile을 포함한다. Phaser 전용 타입 참조는 Three 고정 버전과 맞는 선언으로 교체하고 any·기대한 코드 문자열만 검사하는 테스트로 우회하지 않는다.

## 10. 실패 조건과 되돌림

**3D는 매력을 보장하는 결론이 아니라 검증해야 할 표현 가설이다.** 원작 에셋·모델·텍스처·스크린샷 일부를 게임에 가져오지 않는다. 참고하는 것은 둥근 실루엣·큰 색 면·부드러운 조명뿐이다. 원작 스튜디오 키 아트와 동급이라는 약속도 하지 않는다.

| 실패 신호 | 판정 방법 | 조치 | 근거 |
|---|---|---|---|
| 첫날 도형 3D가 더 싸구려로 보임 | 사용자에게 같은 크기 2D/3D와 조명 비교를 제시. 둥근 형태/그림자 접지/캐릭터 가독성 각 5점 중 ≥4, 2D 대비 3D 선호를 시각 승인 기준으로 사용 | 조명·팔레트·비율만 최대 1일 보정 후 재판정. 다시 불합격이면 3D 진행 중단, 사용자에게 표현 가설 실패 보고 | 추론: 주관 판정을 프레임 수로 대신하지 않음 |
| 모바일 지속 성능 미달 | §8 실제 두 기기에서 최저 허용 품질 후에도 p95>35ms 또는 >50ms 프레임 ≥1%, 10분 후 악화 | 최대 1일 원인별 최적화 후 재측정. 그림자를 버려야만 성능이 나오며 시각 게이트도 실패하면 3D 기각 | 추론: 초기 빈 장면 60fps로 출하하지 않음 |
| 입력·카메라 불편 | 걷기 3분 중 목표 방향 오인, 캐릭터 가림 지속, 100ms 초과 반응, 패드 고착 재현 | 방위각 고정/추종/패드 조정. 해결 전 출하 보류 | 추론: 그래픽 개선만으로 조작 회귀 수용 안 함 |
| 저장/호환 손상 | GET 실패에 PUT 발생, 기존 5키 변경 손실, meta 선쓰기, 가구 경계 누출 | 즉시 출하 중단, 어댑터/수명 원인 수정. schema 변화·데이터 초기화로 해결하지 않음 | 기존 저장 계약 |
| 반복 진입 누수·부팅 실패 | 20회 뒤 RAF/timer/입력 잔존·메모리 단조 증가, 대상 WebView WebGL 생성 실패 | 라이프사이클 수정 후 재검증. 지원 기기에서 지속되면 이전 배포 유지 | 추론: iframe 탈착의 자동 정리에 기대지 않음 |
| 예상 OTA 절감 없음 | 동일 배포 방식 ZIP이 1,570,734B보다 큼 | 중복 Phaser·새 Three 중복 청크·public 잔존을 점검. 최종 비용 근거를 갱신하고 출하 판단 전 보고 | 추론: 원본 파일 감소를 OTA 감소로 대체하지 않음 |

시각 평가는 실제 사용자의 판단이며 작성자의 자체 점수만으로 승인됐다고 쓰지 않는다. 사용자를 만나지 못했으면 **시각 승인 확인 못 함**, 실기기가 없으면 **모바일 성능 확인 못 함**으로 두고 후속 출하를 막는다.

롤백은 두 경로를 구분한다. 개발 중 가설 실패 시 새 전체 화면 셸은 살리고, 마지막 정상 RPG 2D의 순수 규칙·codec·session과 Phaser 표현을 전체 화면에 연결하는 복귀 후보를 택한다. 전체 화면 2D도 연결 작업과 검증이 필요하며 즉시 준비됐다고 가정하지 않는다. 출시 후 장애의 즉시 대응은 이전 정상 OTA/웹 배포물로 되돌리는 것으로, 일시적으로 예전 카드 화면으로 돌아갈 수 있음을 명시한다. 그 배포물 ID·해시·실제 롤백 실행 가능 여부는 이번에 **확인 못 함**이며 슬라이스 9의 필수 확인 항목이다.

어느 경우도 garden·rpg 5키를 지우거나 역마이그레이션하지 않는다. v2/mapVersion 1을 그대로 쓰므로 2D가 같은 저장을 읽을 수 있다는 것이 복귀 설계의 근거이고, 실제 왕복 fixture로 확인해야 한다. 이미 저장한 3D 위치도 논리 px/정수 범위가 같아야 한다. 새 OTA에 두 엔진을 상시 동봉하는 자동 fallback은 하지 않는다.

## 11. 유지하는 원칙과 자체 검토

[원 설계 §3·§4·§7](design-tycoon-game-2026-09.md)의 목적은 이번에도 유효하다. 앱에서 잠깐 쉬고, 오래 비워도 잃지 않고, 가계부 숫자의 압박을 게임으로 옮기지 않는 것이다. v0의 열매 구매·생산 최적화 루프는 이미 RPG에서 무료 꾸미기·관찰로 대체됐으므로 복원하지 않는다. 화폐 없음, 지출 미연동, 알림 없음, 주민 떠남·관계 감쇠·시듦·썩음·로그인 스트릭 없음은 유지한다. 기존 열매 3시간·다른 채집점 60초·낚시 장소 규칙을 시각 변경을 이유로 다시 밸런싱하지 않는다. 놓친 시간의 손실·보상 소멸·표본 소비를 추가하지 않는다.

표현상 잎 흔들림·구름·물결·주민 산책은 시간 압박이 아니다. 날짜 변주도 기존 Life.today 범위만 유지하며 한정 표본·오늘만 가능한 보상을 만들지 않는다. 화면 저장 실패 및 동시 저장 덮어쓰기의 내구성 한계는 “게임상 감쇠 없음”과 구분해 기존 안내를 보존한다. 원 설계 §7의 “raw만 보면 됨”은 후속 v0 설계에서 정정됐으므로 DB jsonb 경계 확인을 생략하지 않는다.

독자 질문으로 자체 점검했다: 기존 URL은 어디로 가는가(§2), 같은 origin이면 무엇을 제거하는가(§2·3), GET 실패가 신규로 흐를 수 있는가(§3), 기존 저장 좌표를 어떻게 읽는가(§5), 큰 머리 3D가 왜 느리지 않은가가 입증됐는가(아직 아니며 §8), 첫날 무엇을 보고 중단하는가(§9·10), 실패하면 무엇으로 돌아가는가(§10). 문서에서 결정을 찾을 수 있으며 **실제 독립 독자 에이전트 검증·시각 승인·실기기 측정은 수행하지 않았다**.

반복 방지 기록: 행/열 저장만 보고 규칙이 좌표 독립이라고 단정하지 않는다; iframe 제거와 저장 큐 제거를 혼동하지 않는다; Phaser 엔진 파일 안에 섞인 게임 진행·모달 수명을 빠뜨리지 않는다; raw/gzip/ZIP을 분리한다; 2D에서의 문서 탈착 누수 결과를 같은 문서 3D의 합격 기준으로 재사용하지 않는다. 이 기록의 Memory 등록은 도구 부재로 확인 못 함이다.
