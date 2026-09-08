# 구현 보고 — 3D 슬라이스 5·6·7: 콘텐츠를 3D로 옮겼다 (2026-09-08)

> 지시서: [`rpg3d-s567-brief.md`](rpg3d-s567-brief.md) · 설계서: [`redesign-backyard-3d.md`](redesign-backyard-3d.md)
> 증거: `docs/evidence/rpg3d-s567/`

## 한 줄 요약

주민 3명·채집 8종·낚시 8종·도감 16칸·꾸미기 48슬롯을 **3D 표현으로 옮겼다.**
게임 규칙·대사·종 목록·재생성 시각은 한 줄도 새로 정하지 않았고, 전부
`rpg-rules.js`(`BackyardRpgRules`·`BackyardRpgLife`)를 호출한다.

## 무엇을 만들었나

| 파일 | 성격 | 역할 |
|---|---|---|
| `apps/web/public/miniapps/backyard/rpg3d-models.js` | 신규 | 주민 3명·16종 표본·가구·도구 기하. 파츠를 정점 색을 구운 **하나의 geometry로 합쳐** 드로우콜을 고정한다 |
| `apps/web/public/miniapps/backyard/rpg3d-world.js` | 신규 | 걷는 동안의 **콘텐츠 진행**. Three·DOM·저장을 소유하지 않고 규칙만 호출한다 |
| `apps/web/public/miniapps/backyard/rpg3d-scene.js` | 확장 | 주민·표본·가구(InstancedMesh)·도구·고스트·물결·울타리·**도감 scissor 렌더** |
| `apps/web/public/miniapps/backyard/rpg3d-controller.js` | 확장 | 저장된 방향 복원(저장 형식 불변) |
| `apps/web/src/components/miniapp/backyard-game.tsx` | 확장 | HUD·행동 버튼·대화/도감/완료/도움말 패널·꾸미기 편집기 |
| `apps/web/src/components/miniapp/backyard-game.module.css` | 확장 | 패드 112px·행동 64px·safe-area·도감 투명 패널 |
| `apps/web/src/lib/game-backyard-rpg3d-world.test.ts` | 신규 | 콘텐츠 진행 단위 테스트 19개 |
| `scripts/verify-backyard/rpg3d-s567.mjs` | 신규 | 실제 정적 export 라우트 E2E + 증거 생성 |

### 왜 진행을 별 모듈로 뽑았나

2D 엔진(`rpg-engine.js`)의 `update`/`act`는 Phaser 객체와 HTML 요소에 직접 붙어 있다.
그 안의 게임 진행을 3D로 옮기려면 한 번은 분리해야 한다. `rpg3d-world.js`가 분리한 것은
**표현이 아니라 진행**이고, 그래서 vitest에서 실제 배포 JS를 그대로 실행해 검사할 수 있다.
값은 전부 규칙에서 온다 — 새 밸런스·새 대사·새 종은 없다.

## 슬라이스 5 — 주민 3명

설계서 §6 실루엣 표를 기하로 옮겼다. **색을 지워도 형태로 구분된다.**

| 주민 | 설계 실루엣 | 실측(외곽선 hull 포함, 단위) |
|---|---|---|
| 모루 곰 `r0` | 키 1.4·폭 넓은 몸 0.65·둥근 귀 2개·둥근 주둥이·짧고 묵직한 발 | 키 **1.404** · 몸통 폭 0.65(총폭 0.90) |
| 두리 새 `r1` | 키 1.2·물방울형 몸·양옆 넓은 날개·짧은 원뿔 부리·가는 발 | 키 **1.229** · 날개 총폭 **1.072** |
| 소담 토끼 `r2` | 몸 키 1.25 + 긴 귀 0.45·폭 좁은 몸·길쭉한 발 | 총 키 **1.594** · 폭 0.63 |

- 배회·휴식·길막은 `life.walk`/`life.walkers`를 그대로 호출한다. **NPC 위치·위상은 저장하지 않는다.**
- 걷기는 본 없이 관절 부모 회전이고, 위상은 **실제 누적 이동거리**로만 진행한다.
  이번 프레임에 거리가 늘지 않으면(쉬는 중·길막) 발도 멈춘다.
- 대화는 `life.talk` 결과 문장을 그대로 띄운다. 제목의 친밀도도 규칙이 센 값이다.
- 대화 중 이동 입력 0 · 네이티브 `<dialog showModal>`로 초점 가두기 · 닫으면 행동 버튼 복귀.

## 슬라이스 6 — 채집·낚시·도감

- 16종 기하는 `drawSpecies`의 구분(폭·날개·줄무늬·점·수염)을 작은 기하 조합으로 옮겼다.
  16종의 (폭·높이·깊이·삼각형 수) 지문이 **전부 서로 다르다**.
- 낚시는 `life.cast`·`tickFishing`·`pull`을 그대로 쓴다. **입질에 시간 제한이 없다** —
  실제 화면에서 20초를 흘린 뒤에도 `끌어올리기`가 유지되는 것을 확인했다.
- 도감은 **같은 renderer의 scissor 영역**으로 표본을 그린다. 카드마다 WebGL context를
  만들지 않는다(실측 추가 context **0**). 도감 패널 자체는 투명하고, renderer가 캔버스를
  종이색으로 지운 뒤 카드 창 자리에만 표본을 그린다. 텍스트·초점·스크롤은 HTML이 맡는다.
- 도감이 열리면 세계 렌더와 진행이 멈추고, 스크롤·탭 전환·회전 때만 다시 그린다.
- 획득 하나가 `rpg_collection` PUT 하나다(16번 모두 실측).

## 슬라이스 7 — 꾸미기

- 48슬롯·고스트·이동/보관은 `rules.preview`·`rules.placementReason`을 호출한다.
  **색뿐 아니라 거절 이유 문구를 함께 표시**한다.
- 최대 48개는 종류당 `InstancedMesh` 하나로 제출한다 — 개수가 늘어도 드로우콜이 늘지 않는다.
- 고스트 표시의 배치 판정은 6프레임마다 갱신한다(통행 BFS 비용). **확정은 누르는 순간
  `act`가 규칙으로 다시 판정하므로 권위는 표시에 없다.**

## draw call · triangle 수 — 1차 기록

macOS 데스크톱 Chromium(430×900, DPR 2), 같은 진입 지점(240,592) 기준이다.
**실기기 수치가 아니다.**

| 장면 | draw call | triangle |
|---|---|---|
| 기본(고정 가구 3개) | **73** | **51,620** |
| 최대(가구 48개) | **64** | **76,132** |
| 도감 카드 4칸(scissor) | 4 | — |

가구 48개가 늘었는데 draw call이 줄어든 것은 오차가 아니다. 가구는 **종류당
InstancedMesh 하나**(pot·well·chair + 열매 = 4콜)라서 개수와 무관하고, 이 위치에서는
프러스텀 밖의 채집점·주민 메시가 빠진다. 삼각형은 48개분 24,512개가 그대로 늘었다.
드로우콜 상한은 개수가 아니라 **파츠 종류 수**가 정한다.

## 통과한 게이트

```
pnpm --filter @family/web exec vitest run src/lib/game-backyard src/lib/backyard-storage src/lib/miniapp
  → 18 files · 259 passed | 1 skipped   (기준선 17 files · 240 passed | 1 skipped)
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2  → 9/9 성공 (FULL TURBO 아님)
pnpm --filter @family/web typecheck                                        → 통과
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit → 통과
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit   → 통과
pnpm --filter @family/web build:mobile                                     → 통과(정적 export)
node scripts/verify-backyard/rpg3d-s567.mjs                                → 통과(검사 16건, 콘솔·페이지 오류 0)
```

실제 라우트 E2E가 확인한 16건 (`docs/evidence/rpg3d-s567/results.json`):

1. 신규 4키 ACK → `rpg_meta` 마지막, iframe 0 · canvas 1
2. 주민 3명 실루엣 치수 구분(곰 폭 0.90 · 새 폭 1.072 · 토끼 키 1.594), 16종 기하 지문 전부 상이
3. 이름·색을 가린 평면 단색 실루엣 판(`silhouette-board.png`)
4. 320·360·430 세로와 800×360 가로에서 같은 장면·HUD
5. 주민 3명 근접 스크린샷 + 무채색 실루엣 판
6. 주민 3명 × 10회 = 대화 30회 빈 슬롯 없음, 매 회 `rpg_residents` 한 키, 대화 중 이동 0 · 초점 복귀
7. 활성 채집점 12곳에서 채집 8종 전부 획득, 각 `rpg_collection` PUT 하나 · 장소 기록
8. **입질 20초 유지 — 시간 제한 없음**
9. 낚시 3곳에서 8종 획득, 취소 무손실 — 합계 16종 전부
10. 16번째 획득 ACK 뒤 완료 화면 한 번, `completed` 저장 확정
11. 도감 3탭 합계 16칸 scissor 렌더 · **추가 WebGL context 0** · canvas 1 · 패널 뒤 입력 0 · 초점 복귀
12. 길 차단 자리에서 거절 이유 문구 표시 + 저장 없음(`길·집 입구·발견 장소는 비워 두세요`)
13. 작업대 → 걷기 → 고스트 → 확정으로 `rpg_world` 한 키 왕복
14. 화분 시각 유지 — 익은 화분 16개에 열매 16개, 자라는 중이면 열매 0개·화분 16개 그대로
15. 48개 포함 저장 왕복 후 draw call·triangle 기록
16. 옷 0/1 두 종류 렌더

## 발견해서 고친 것 — 슬라이스 4가 남긴 문제 3개

세 개 모두 이번 콘텐츠 연결이 아니라 **직전 슬라이스의 실제 라우트 결함**이다.

1. **`BackyardRpgSession`을 로드하지 않았다.** `backyard-game.tsx`의 스크립트 목록에
   `rpg-codec.js`·`rpg-session.js`(그리고 garden 이주가 부르는 `balance/rules/codec`)가
   빠져 있었다. 실제 라우트에서 세션 생성이 참조 오류로 죽는다. 목록에 넣었다.
2. **저장마다 3D를 다시 만들었다.** 세션은 ACK마다 새 상태 객체를 알리는데 3D 생성 효과가
   그 객체를 의존성으로 썼다. 이제 **writer 신원**(세션 한 세대)에만 의존한다.
3. **저장 위치의 `t`에 RAF 타임스탬프를 넣었다.** 규칙이 이 값을 시계 역행 차단의
   하한으로 쓰고 2D는 `Date.now()`를 저장했다. 벽시계 초로 되돌렸다.

네 번째는 이번에 만들고 실제 라우트에서 잡은 것이다: 완료 표시가 `data` 신원 변화에만
반응해서, 저장 잠금이 풀린 뒤(ACK만 알리는 emit) 다시 확인하지 못했다.
**모든 emit에서** 세계를 맞추도록 고쳤다. 도감에서도 두 건을 잡았다 — 닫힌 `<dialog>`에
`display:flex`를 줘서 닫혀도 화면을 덮은 것과, `.game button`의 종이색 배경이 카드
표본 창을 덮어 표본이 하나도 보이지 않은 것이다(스크린샷으로 확인하지 않으면 검사
숫자만 통과한다).

## 확인 못 함 — 이번 범위 밖이거나 사람이 봐야 하는 것

- **시각 승인 확인 못 함.** "주민이 귀여운가 / 2D보다 나은가"는 사용자 판정이다.
  실루엣 판(`silhouette-board.png`)과 근접 스크린샷을 남겼고 스스로 통과 판정하지 않았다.
- **모바일 성능 확인 못 함.** 위 draw call·triangle 수는 macOS 데스크톱 Chromium 실측이며
  실기기 p95/p99가 아니다(슬라이스 8).
- **20회 반복 진입 수명·OTA 실측 확인 못 함**(슬라이스 8·9).
- 도감 스크롤 중 표본 재렌더는 `onScroll`마다 호출한다. 긴 목록의 스크롤 부하는
  실기기에서 다시 봐야 한다.

## 커밋 상태

**커밋하지 않았다.** 작업 트리에 그대로 있고 기준 커밋은 `0e43bb1`이다. 변경 파일은
위 표의 8개와 `docs/rpg3d-s567-report.md`·`docs/evidence/rpg3d-s567/`다.

## 남은 결정

1. 수관 가림이 발동하면 **줄기만 남는다**(설계서 §5의 "수관만 축소"). 스크린샷에서
   민둥 줄기가 눈에 띈다 — 축소 대신 반투명/부분 은폐로 바꿀지 사용자 판단이 필요하다.
2. 지도 북단 바깥은 울타리 + 안개 + 하늘이다. 이번에 울타리를 넣어 빈 배경을 막았지만
   여전히 화면 상단이 넓게 비는 구도가 남는다 — 카메라 하향각을 키울지 결정이 필요하다.
