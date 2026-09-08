# 구현 지시서 — 3D 슬라이스 5·6·7: 콘텐츠를 3D로 옮긴다 (2026-09-08)

> **이번 작업은 구현이다.** 게임 내용은 이미 만들어져 돌고 있다. **표현만 3D로 옮긴다.**

## 이번 작업의 성격 — 새로 설계하지 마라

주민 3명·대사 56개·채집 8종·낚시 8종·도감 16칸은 **이미 구현돼 배포까지 됐다.**
규칙(`rpg-rules.js` 28KB)·저장(5키)·세션이 전부 살아 있고 테스트 240개가 고정하고 있다.

**이번에 하는 일은 그 규칙이 이미 계산하는 것을 3D로 그리는 것뿐이다.**
게임 밸런스·대사·종 목록·재생성 시각을 다시 정하지 마라.

## 먼저 읽을 것

1. `docs/redesign-backyard-3d.md` — **설계서. 계약이다.**
   특히 **§6(캐릭터·주민·도감 표현)** · **§5의 기하·재질 시작값 표** · §7(조작·근접) ·
   §9의 5·6·7일 행 · §10(실패 조건).
2. `apps/web/public/miniapps/backyard/rpg-rules.js` — **주민·채집·낚시·대사의 단일 출처.**
   `residents`·`nodes`·`fishGroups`·`species`·`talk`·`walk`·`gather`·`catchFish`·`cast`를
   **그대로 호출한다.** 값을 복제하거나 새로 정하지 마라.
3. `apps/web/public/miniapps/backyard/rpg3d-scene.js` · `rpg3d-controller.js` —
   직전 슬라이스가 만든 3D 표현. 여기에 기하를 추가한다.
4. `apps/web/src/components/miniapp/backyard-game.tsx` — 세션·저장 연결부.
   `playable.writer.commit(key, value)`가 저장 경로다.

**근거가 필요하면 문서를 열어라.** "무엇을 하라"만 보고 "왜"를 모른 채 결정하지 마라.

## 지금까지의 상태

| 커밋 | 내용 |
|---|---|
| `cee9bfa` | 슬라이스 1 — fixture 장면. **사용자가 시각 승인함** |
| `bbb41e6` | 슬라이스 2·3 — `(game)` 전체 화면 라우트 + 걷기·카메라·충돌 |
| `0e43bb1` | 슬라이스 4 — 직접 저장 어댑터, 5키 계약 보존 |

테스트 240 통과 + 1 스킵(17 files). Three r128 동봉. Phaser도 아직 남아 있다(롤백 후보).

**알아둘 것 세 가지:**
- 저장 어댑터는 `{state:…}` 봉투가 아니라 **값 자체**를 준다. 세션이 `=== null`로 신규를
  판정하기 때문이다(`backyard-storage.ts` 주석 참조).
- `controller.create`가 방향을 받지 않아 **방향 복원이 안 된다.** 알려진 한계다.
  이번에 넓혀도 되지만 저장 형식은 바꾸지 마라.
- 호스트 수명 시험이 `it.skip`으로 슬라이스 8에 이관돼 있다. 되살리지 마라.

## 이번에 만드는 것 — 슬라이스 5·6·7

### 슬라이스 5 — 주민 3명

설계서 §6의 실루엣 표대로. **색을 지워도 구분되어야 한다.**

| 주민 | 실루엣 |
|---|---|
| 모루 곰 `r0` | 키 1.4, 폭 넓은 몸 0.65, 둥근 귀 2개·둥근 주둥이, 짧고 묵직한 발 |
| 두리 새 `r1` | 키 1.2, 물방울형 몸, 양옆 넓은 날개, 짧은 원뿔 부리·가는 발 |
| 소담 토끼 `r2` | 몸 키 1.25 + 긴 귀 0.45, 폭 좁은 몸·길쭉한 발 |

- 배회는 `life.walk`·`life.walkers`를 호출한다. **NPC 위치·위상은 저장하지 않는다.**
- 대화는 `life.talk`의 결과를 그대로 띄운다. 대사를 새로 쓰지 마라.
- 걷기는 본 없이 관절 부모 회전. **실제 이동거리로 위상을 진행**해 제자리에서 발만
  달리지 않게 한다(§6).
- 대화 중 이동 입력 0, 초점 가두기, 닫은 뒤 원래 버튼 복귀.

### 슬라이스 6 — 채집·낚시·도감

- 16종 기하를 `life.species`의 색·폭·날개·줄무늬·점·수염 구분으로 만든다.
- 낚시 리듬은 `life.cast`·`tickFishing`·`pull`을 그대로 쓴다.
  **입질은 버튼을 누를 때까지 유지된다.** 시간 제한을 넣지 마라.
- 도감은 **동일 renderer의 scissor 영역**으로 카드 표본을 그린다.
  **카드마다 WebGL context를 만들지 마라**(§6). 텍스트·초점·스크롤은 HTML이 맡는다.
- 도감 열리면 세계 렌더 정지, 스크롤/탭/회전 때만 다시 그린다.
- 획득 하나가 `rpg_collection` PUT 하나다.

### 슬라이스 7 — 꾸미기

- 48슬롯·고스트 모델·이동/보관은 기존 `preview`·`placementReason`을 호출한다.
  **색뿐 아니라 거절 이유 문구를 함께 표시**한다.
- 최대 48개 장면의 draw call·triangle 수를 1차 기록한다.

## 반드시 지킬 것

### 잃는 것을 만들지 마라
주민 이탈·서운함·표본 소멸·입질 시간 제한·연속 접속 보상·방치 감쇠 **전부 없음.**
근거는 `docs/design-tycoon-game-2026-09.md` §4다. 시각을 3D로 바꾼 것이 이 원칙을
바꾸지 않는다. 설계서 §11이 다시 확인했다.

### 근접은 논리 평면에서
**Raycaster는 시각 가림만 담당하고 획득 권위를 갖지 않는다**(§7).
발 위치에서 기존 `rules.target()`을 호출한다. 수관이 커져도 멀리서 탭해 획득할 수 없어야 한다.

### 이미지 파일 0개 · r128 제약
`CapsuleGeometry` 없음(구+원기둥). `outputEncoding`/`NoToneMapping`이 r128 기준.
후처리(OutlinePass·SSAO·Bloom) 금지. 툰 그라디언트는 런타임 2×1 `DataTexture`.

### 성능을 낮출 때 그림자는 마지막이다
사용자 시각 승인에서 **조명 on/off 비교가 3D 선택의 근거를 확인시켰다.**
기하가 같은데 그림자를 빼면 다시 납작해진다. 낮추는 순서는
**그림자 해상도 → 폴리곤 → 렌더 해상도**이고 그림자 자체를 먼저 버리지 않는다.

## 완료 게이트 — 설계서 §9의 5·6·7일 행

슬라이스 5:
- **이름·색을 가린 실루엣으로 세 주민이 구분**되는 스크린샷
- 기존 `life` 대사·경로·mask 결과와 **동일**
- 대화 중 이동 0 · 초점 복귀 · 관계 PUT 한 키

슬라이스 6:
- **16종 전부 표시·획득 가능**
- 취소/재생성/99상한 · 장소 기록 · **단일 collection PUT** · ACK 후 완료
- 패널 뒤 입력 0 · **추가 WebGL context 0**

슬라이스 7:
- 48개 포함 저장 왕복 · 길 차단 거절 문구 · 화분 시각 유지 · 옷 2종
- **기본/최대 장면 draw call·triangle 수 기록**

기존 게이트도 깨지지 않아야 한다:
```
pnpm --filter @family/web exec vitest run <backyard·miniapp·backyard-storage 테스트 전부>
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web build:mobile
```

## 보고

`worker_done` 본문에 **통과한 게이트와 draw call·triangle 수**를 담는다.
보고서는 `docs/rpg3d-s567-report.md`에, 증거는 `docs/evidence/rpg3d-s567/`에.

## 지켜야 할 것

- **슬라이스 8·9를 미리 하지 않는다.** 실기기 성능·20회 수명·OTA 실측은 이번이 아니다.
- **2D 파일을 지우지 마라.** 롤백 후보다.
- **게임 내용을 다시 설계하지 마라.** 규칙·대사·종·밸런스는 이미 정해졌다.
- 확인 못 한 것은 **"확인 못 함"**이라고 쓴다. 실기기 판단을 에뮬레이터로 대신하지 마라.
  사람이 봐야 하는 것(주민이 귀여운가)을 스스로 통과 판정하지 마라.
- `build:packages`가 `FULL TURBO`면 검증이 아니다. `--force`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
- **운영 스택(`docker-compose.prod.yml`)에 쓰지 마라.**
