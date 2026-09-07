# 뒷마당 RPG 슬라이스 9·10·11 마무리 보고

2026-09-08. 도감·오늘 변주·완료와 저장·배포 검증의 기존 결과를 정리하고, 빠졌던 RPG 20회 수명 검증을 추가했다. 구현 기준은 코디네이터가 게이트 재실행 후 기록한 `d133b27`이다. 새 게임 기능과 운영 스택 변경은 없다. 실기기 출하 검증은 미완료이며 [슬라이스 12 점검표](rpg-s12-checklist.md)를 사람이 수행해야 한다.

## 구현 내용

- `index.html`·`rpg-engine.js`에 HTML 도감 16종을 연결했다. 바닥·열매 4종 / 벌레 4종 / 물고기 8종 세 탭이며, 미발견은 실루엣과 장소 힌트를 보여준다. 발견 항목은 표본 수량, 최초 날짜, 획득 장소, 관찰문을 표시한다.
- 신규 collection 표본은 `종:수량:최초시각:획득장소`를 저장한다. 재획득 시 최초 시각·장소를 유지한다. 과거 3토큰 저장에는 장소를 추정해 넣지 않고 “장소 미기록”으로 표시한다. DTO v2와 5키를 유지한다.
- 오늘 변주는 저장 최대 시각과 seed를 사용한다. 세 변주에서 벌레 자리·주민 시작 경로와 설명을 바꾸고, 날짜 역행을 막는다. 기존 발견·수량·관계의 날짜 감쇠는 없다. 주민 친밀 경험과 대화는 기존 연결을 유지한다.
- 도감·완료창은 배경 inert, 이동 일시정지, Tab 순환, Escape/닫기 및 호출 초점 복귀를 구현한다. 16번째 획득 ACK 이후 `completed:true`를 collection에 저장하고 그 ACK 뒤 완료창을 한 번 연다. 도감이 열려 있으면 완료 표시를 미루며, 닫은 뒤 계속 산책할 수 있다. 이미 완료된 저장으로 재진입하면 다시 알리지 않는다.

근거: [도감 규칙 테스트](../apps/web/src/lib/game-backyard-rpg-album.test.ts), [배포 어댑터](../apps/web/public/miniapps/backyard/rpg-engine.js), [기존 221개 테스트 출력](evidence/rpg-s91011/tests.txt). 제공된 `rpg-s91011` 증거 폴더에는 도감 브라우저 캡처·초점 검사 결과 파일이 없다. 도감 데이터/표시 16종 일치·Tab 배경 진입 0의 **별도 실제 iframe 검증 결과는 확인 못 함**이며 소스 구현·규칙 테스트 통과와 구분한다. 이번 수명 시험에서 도감 탭을 열고 닫은 것은 수명 경로 자극이며 도감 전체 사용성 검수가 아니다.

## 격리 API·DB

[기존 API·DB 출력](evidence/rpg-s91011/api-db.txt)의 `RPG_RESULT`를 인용한다. DB `family_memory_verify_20260907140612_ff3c1b5a`를 생성·migration·검증 후 폐기했다. 이번 작업에서 다시 만들지 않았다. 일회용 인증 사용자를 주입한 실제 컨트롤러·파이프·서비스·PostgreSQL 시험이다.

| 키 | canonical raw JSON UTF-8 | 실제 pg_column_size(jsonb) | API/DB 상한 |
|---|---:|---:|---:|
| rpg_meta | 76B | 109B | 8192B |
| rpg_world | 662B | 742B | 8192B |
| rpg_collection | 2150B | 532B | 8192B |
| rpg_residents | 101B | 131B | 8192B |
| rpg_player | 84B | 160B | 8192B |

raw와 jsonb는 다른 측정이다. **collection만 2150→532B로 jsonb가 더 작고 나머지 네 키는 더 크다.** raw 합계는 3073B이며 각 키의 상한은 합계가 아닌 개별 값으로 판단한다. 이전 s678의 collection 2005B와 달라진 최대 fixture를 그대로 구분한다.

5키 HTTP PUT→GET 일치, 실패 키 413, 나머지 키 보존이 기록됐다. v1 이전은 world→collection→residents→player→meta 순서이고 기존 garden은 바꾸지 않았다. raw 8192B는 서비스 검사를 통과하더라도 DB jsonb CHECK가 거절할 수 있고, raw 8193B는 서비스에서 413으로 거절했다.

### 동시 편집 손실 — 해결하지 않음

같은 출력의 `conflicts` 배열은 **B ACK→A의 늦은 ACK** 순서에서 손실을 재현한다.

- collection: B가 저장 완료한 `s4` 발견, 수량 1, 최초 시각 10000, `node-8:10060` 재생성 기록이 사라지고 A의 `s0:1:10000:node-0` 및 `node-0:20800` 기록만 남았다. 다른 키 `rpg_world`는 보존됐다.
- world: B의 화분 배치 `0:p:8:20`이 사라지고 A의 `0:p:3:15`, `1:w:6:18`, `2:c:7:20`가 남았다.

기존 마지막 쓰기 우선 정책을 유지한다. 같은 키의 무손실 동시 편집은 미해결이다. 현재 안내는 “동시에 바꾸면 마지막 저장이 남아요”이며, 제품 차원의 손실 정책 최종 수용 결정이 별도로 이루어졌다는 증거는 확인 못 함이다. ACK 전 앱 종료의 미저장 소실 가능성도 유지한다.

## 기존 회귀·배포 게이트

아래는 [마무리 지시서](rpg-closeout-brief.md)의 코디네이터 확인값과 앞 워커의 로그를 인용한다. 끝난 빌드·DB·OTA 측정은 재실행하지 않았다.

| 게이트 | 기존 결과 / 근거 |
|---|---|
| 관련 웹 테스트 | 14 files · 221 통과 — [tests.txt](evidence/rpg-s91011/tests.txt) |
| 전체 웹 테스트 | 32 files · 426 통과 — [all-web-tests.txt](evidence/rpg-s91011/all-web-tests.txt); 221과 다른 실행 범위 |
| @family/shared | 189 통과 — [shared-tests.txt](evidence/rpg-s91011/shared-tests.txt) |
| 패키지 build --force | 9/9, 캐시 0 — [packages-build.txt](evidence/rpg-s91011/packages-build.txt) |
| 웹 타입 검사 | 코디네이터 확인 통과; 전용 web-types 로그는 제공 폴더에 없음 |
| public rules / dom 타입 검사 | 통과 — [rules-types.txt](evidence/rpg-s91011/rules-types.txt), [dom-types.txt](evidence/rpg-s91011/dom-types.txt) |
| build:mobile | 통과 — [mobile-build.txt](evidence/rpg-s91011/mobile-build.txt) |
| export entry / public-miniapps 자산 | out entry와 public/miniapps 전량 바이트 일치 — 코디네이터 확인값 |
| OTA ZIP | 1,570,734B; v0 1,179,233B 대비 **+391,501B / +33.20%** — 코디네이터 확인값 |

OTA 증가 목표 +450KiB(460,800B)보다 **69,299B 여유**다. 이번에는 제품 자산을 수정하지 않아 기존 ZIP 수치를 유지한다. 별도 export 해시·ZIP 원시 결과 파일은 제공 폴더에 없으므로 위 두 항목의 출처를 코디네이터 확인으로 명시한다.

## 20회 RPG 수명 검증

두 종류의 실험을 분리했다. [실제 호스트 원시 결과](evidence/rpg-closeout/host-lifecycle.json)와 [동일 문서 원시 결과](evidence/rpg-closeout/same-document-lifecycle.json)는 Chromium 149.0.7827.55의 자동 측정이며 실기기 결과가 아니다.

| 경로 | 측정 | 판정 |
|---|---|---|
| 실제 `/play/`→`/play/app/?key=backyard`→뒤로, 20회 | 같은 부모 문서 유지, 서로 다른 게임 문서 20개, iframe 분리 20/20, 매 이탈 후 게임 프레임 0 | 현재 실제 진입·이탈 경로의 살아 있는 문서에 속한 Game/Scene·timer/listener·RAF 증가 0 |
| 로드 GET 503→“다시” | 실패 문서 Game 생성 0 → 다른 문서에서 Game 1 | 같은 문서 재생성 아님 |
| 부모 높이 900→300→900 | 문서 ID 동일, Game 생성 1 유지 | paused 복귀로 Game 추가 없음 |
| 앱 키 미등록값→backyard | 이전 iframe 분리, 문서 ID 변경 | 새 문서 |
| 검증 가구→다른 검증 가구 | 이전 iframe 분리, 문서 ID 변경, 새 문서 Game 생성 1 | 새 문서 |
| 같은 문서에서 엔진 IIFE 강제 실행→pagehide, 20회 | Game 생성/실제 runDestroy 20/20, Scene 생성/destroy 60/60(내부 systemScene 포함) | Game/Scene 증가 0 |
| 같은 문서의 종료 자원 | timer 0, RAF 0, pointer listener 0, interval 0, observer 0, 게임 canvas 0; 총 listener **40** | 강제 재생성 경로의 리스너 0 게이트는 실패: 회당 visibilitychange 1+wheel 1 |

실제 경로에서는 게임 문서가 실행 수명을 잃었는지 `Frame.isDetached()`와 남은 iframe/게임 frame 개수로 판정한다. 삭제된 문서의 이벤트 등록을 살아 있는 자원으로 합산하지 않는다. 브라우저 GC 완료·heap 바이트 0을 측정했다는 뜻은 아니다. 반면 같은 문서 실험은 DOM·계측기를 유지하고 제품 `pagehide`만 실행해 destroy 자체의 부족함을 드러낸다. 두 수치를 합쳐 “destroy가 리스너까지 모두 정리했다”고 해석하면 안 된다.

동일 문서 실험에서는 매 회 도감 3탭을 열고 닫고, 제품 session writer의 실패 저장으로 **재시도 timer 1개가 실제 대기 중**인지 확인한 뒤 종료했다. 포인터 capture는 종료 전 true→종료 후 false(20/20)이며 Game의 원본 `runDestroy` 이후 loop 정지, Scene 배열 0, canvas 분리, texture 목록 0도 확인했다. 중복 pagehide 후 잔존 수가 늘지 않는다. Phaser 객체를 가짜 destroy로 바꾼 시험이 아니다.

실제 호스트는 기존 정적 export를 제공하고 API만 메모리 fixture로 격리한다. 각 회차 저장 실패 재시도 대기를 만든 뒤 이탈하며, 정상 JS/CORS 오류는 0이고 의도한 GET 503은 별도 분류한다. 부모의 message 리스너도 매 회 기준선 0으로 돌아왔고 최종 증가 0이다. 호스트 세대 변경은 실제 가구 선택 UI와 Next 쿼리 변경으로 확인했다. 이 경로들에서 동일 문서 Game 재생성이 발생하지 않아 코디네이터 지시에 따라 **실제 경로 수명 게이트는 통과**, Phaser 원본 잔존은 알려진 한계로 남기고 벤더·제품 어댑터를 수정하지 않았다. 향후 같은 문서 Game 재시작 기능을 넣으면 이 결함을 먼저 감싸야 한다.

재현(저장소 루트, 기존 `apps/web/out` 필요):

```sh
pnpm --filter @family/web exec vitest run src/lib/game-backyard-rpg-lifecycle.test.ts
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
```

Playwright 모듈은 기존 검증 스크립트와 같이 `PLAYWRIGHT_MODULE` 또는 개인 gstack의 `node_modules/playwright/index.mjs`를 사용한다. 미설치 시 skip하지 않고 실패한다. [초기 잔존 실패](evidence/rpg-closeout/initial-lifecycle-failure.txt)와 [20회 0 게이트 실패](evidence/rpg-closeout/same-document-test.txt)도 보존했다. 원시 동일 문서 0 게이트만 재현하려면 `node scripts/verify-backyard/rpg-lifecycle.mjs`를 실행하며 **의도적으로 실패(+40)**한다. `--characterize`는 이 알려진 특성을 검사하는 모드로서 0 통과를 의미하지 않는다.

마감 결과: 신규 수명 2/2, 기존 전체 웹 32 files·426/426(기존 관련 221 포함), rules·dom 타입 검사 모두 통과했다. [수명 테스트](evidence/rpg-closeout/lifecycle-test.txt), [기존 웹 회귀](evidence/rpg-closeout/regression-tests.txt), [rules](evidence/rpg-closeout/rules-types.txt), [dom](evidence/rpg-closeout/dom-types.txt). 기존 테스트 회귀는 추가 시험 이후 깨짐이 없다는 완료 조건을 확인하기 위해 실행했으며 기존 빌드·배포 측정을 되풀이한 것이 아니다.

## 리뷰와 한계

- v0 `game-backyard-lifecycle.test.ts`는 RPG Phaser를 실행하지 않아 새 RPG 수명 시험을 분리했다. 기존 221개 테스트는 유지한다.
- 동일 문서에서 엔진 IIFE를 반복 실행하는 시험과 실제 React iframe 진입·이탈을 구분해야 한다. 프레임을 제거하면 별도 문서의 이벤트 등록도 함께 실행 수명을 잃으므로, 같은 문서를 재사용한 계측만으로 실제 사용 경로의 누적이라고 단정할 수 없다.
- Phaser 4.2.1은 문서 visibilitychange와 canvas wheel 등록을 destroy에서 모두 정리하지 않는다. [공식 VisibilityHandler](https://raw.githubusercontent.com/phaserjs/phaser/v4.2.1/src/core/VisibilityHandler.js)와 [MouseManager](https://raw.githubusercontent.com/phaserjs/phaser/v4.2.1/src/input/mouse/MouseManager.js), 동봉 파일에서 확인했다. 벤더 원본은 수정하지 않았다.
- 최초 계측은 Scene을 두 개로 가정해 실패했다. Phaser의 내부 systemScene까지 포함하면 Game당 3개다. 또한 Game의 isRunning이나 renderer 참조 존재를 종료 판정으로 쓰지 않고 실제 runDestroy 수행, loop 정지, Scene destroy 이벤트, canvas 분리, texture 목록 해제를 확인했다. destroy 후 참조 필드가 반드시 null이 되는 구현은 아니다.
- Memory·context7·sequential-thinking MCP가 제공 도구에 없어 과거 학습 로드·외부 ADR/반복 패턴 저장은 확인 못 함이다. 반복 패턴은 이 리뷰에 기록한다. aside-browser의 `aside guide`가 사용 가이드 대신 일반 대화 응답을 반환해 저장소의 기존 Playwright 실행 방식을 사용했다. 새 외부 라이브러리를 추가하지 않았다.
- 실기기 멀티터치·safe-area·글자 확대·백그라운드·강제 종료·60Hz 성능·두 사용자 반응은 **확인 못 함**이다. 준비한 [실기기 점검표](rpg-s12-checklist.md)에 판정 기준과 원시 측정/답변 기록란을 제공한다.
