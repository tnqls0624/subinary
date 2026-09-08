# 구현 지시서 — 3D 슬라이스 2·3: 전체 화면 진입과 걷기 (2026-09-08)

> **이번 작업은 구현이다.** 시각 게이트가 통과했으므로 화면 약속을 고정하고 걷게 만든다.

## 시각 게이트는 통과했다

설계서 §10이 후속 슬라이스를 막아 두었던 게이트다. 사용자가 비교 증거 두 장을 보고
**"좋다 이어서 진행해"**로 판정했다. 기록은 `docs/rpg3d-s1-report.md` 마지막 절에 있다.

**그 판정에서 나온 사실 하나를 기억하라** — 조명 on/off 비교가 설계 근거를 확인시켰다.
기하가 같은데 그림자와 명암을 빼면 다시 납작해진다. 그래서 **성능 때문에 품질을 낮출 때
그림자를 가장 마지막에 버린다.**

## 먼저 읽을 것

1. `docs/redesign-backyard-3d.md` — **설계서. 계약이다.**
   특히 **§2(ADR-3D-01 라우트·전체 화면 경계·나가기/뒤로/저장)** ·
   **§5(좌표·충돌·카메라)** · **§7(조작과 HUD)** · §9의 2·3일 행 · §10(실패 조건).
2. `docs/rpg3d-s1-report.md` — 직전 슬라이스. fixture 장면의 실제 API와 파일 구성.
3. `apps/web/public/miniapps/backyard/rpg-rules.js` — **지도·통행·근접의 단일 출처.**
   `canStand`·`target`·`velocity`·`navigation`을 그대로 호출한다.

**근거가 필요하면 문서를 열어라.** "무엇을 하라"만 보고 "왜"를 모른 채 결정하지 마라.

## 지금까지의 상태

| 커밋 | 내용 |
|---|---|
| `bee676d` | 3D 재설계 설계서 |
| `cee9bfa` | 슬라이스 1 — fixture 장면(지형·나무 12·조명·캐릭터 1) |
| `122c1ab` | 시각 게이트 통과 기록 |

테스트 228개(16 files) 통과. Three r128 동봉(해시 `9274bbce…`).
**Phaser와 Three가 아직 둘 다 실려 있다** — 2D를 걷어내는 것은 이번이 아니다.

## 이번에 만드는 것 — 슬라이스 2와 3

### 슬라이스 2 — 앱 전체 화면 진입·탈출

설계서 §2대로. **새 `(game)` 라우트 그룹**을 만들고 `(app)/play/app/page.tsx`를
`(game)/play/app/page.tsx`로 **이동**한다(두 그룹에 같은 page를 동시에 두지 않는다).

- URL은 `/play/app?key=backyard`, 모바일 `/play/app/?key=backyard`, 출력
  `out/play/app/index.html` **그대로 유지**한다. 라우트 그룹은 URL에 안 들어간다.
- 게임에서 헤더·하단 탭·PullToRefresh·금융 ActivityProvider를 마운트하지 않는다.
- **인증/가구 준비 판정은 공통 경계로 추출**해 두 그룹이 함께 쓴다. 복제하지 마라.
- HUD만 safe-area 안쪽 12~16px. 세로 기본, **가로도 허용**. 방향 잠금·Fullscreen API 없음.
- **좌상단에 항상 44×44 이상 `마당 나가기`** — 하단 탭이 없으니 유일한 필수 탈출 경로다.
- 뒤로 소비 순서: 활성 패널 닫기 → 미확정 취소 → 마당 나가기.
  Android는 **기존 `native-bootstrap`의 콜백 한 곳**에서 처리한다. 게임이 `App backButton`을
  중복 등록하지 마라.
- 기존 `/miniapps/backyard/index.html`은 **얇은 호환 페이지**로 다시 쓴다 — 정규 경로 안내·이동만.
  그 안에 엔진이나 독립 저장 writer를 만들지 마라.
- UI의 기존 **"격리 실행" 문구를 제거**한다. 같은 문서 실행이므로 사실이 아니다.
  지출 미연동·공동 저장 사실만 도움말에 남긴다.

### 슬라이스 3 — 걷기·지도 연결

설계서 §5·§7대로.

- 좌표 어댑터: `X=u/32−16, Z=v/32−12, Y=h(X,Z)`. 논리 px를 그대로 유지한다.
- **Phaser Arcade를 제거하되 물리 라이브러리를 추가하지 마라.** controller가 고정 1/60초
  이동을 계산하고 `canStand`로 축별 판정한다. 한 검사 이동은 **논리 4px 이하로 분할**해
  얇은 줄기·둑 통과를 막는다.
- 빠진 프레임 누적은 **100ms까지만**, 복귀 첫 프레임 delta는 **0**.
- 카메라: 원근 3인칭, **방위각 고정**(방향 전환마다 회전하지 않음), 하향 40°, FOV 45°,
  오프셋 (0,8,10), 추종 지연 ~150ms, 지도 끝 clamp.
- 나무 가림: 카메라를 돌리지 말고 **시선 통로의 수관만 축소/숨김**. 줄기·충돌은 그대로.
- 입력 기준은 **카메라 화면 방향**이되 방위각 고정이라 패드 위=북(−Z)이 항상 성립한다.
  기존 `velocity`의 8방향·정규화 규칙을 호출한다. 속도 96px/s=3단위/s 보존.
- 3D 물·길·집을 설계서 §5 표의 값으로 만든다.

## 반드시 지킬 것

### 근접 판정은 3D가 아니라 논리 평면에서
설계서 §7이 명시했다 — **Raycaster는 시각 가림만 담당하고 획득 권위를 갖지 않는다.**
발 위치의 논리 평면에서 기존 `target()`을 호출한다(40px=1.25단위, 전방 ±60°).
수관이 커져도 멀리서 탭해 획득할 수 없어야 한다.

### 지도 좌표를 복제하지 마라
`rpg-rules.js`가 단일 출처다. 복제하면 2D와 3D가 다른 지도가 된다.

### 저장은 이번이 아니다
슬라이스 4다. 이번엔 fixture로 두되 **좌표 왕복은 검증**한다 — 저장 형식
`(sx,sy)` = 논리`(2sx,2sy)`가 맞는지, 기존 초기 `(240,592)`가 3D `(−8.5,h,6.5)`로
복원되는지. 로드만으로 보정 위치를 자동 저장하지 마라.

### 이미지 파일 0개 · r128에 없는 API 금지
`CapsuleGeometry` 없음(구+원기둥). `outputEncoding`/`NoToneMapping`이 r128 기준.
후처리(OutlinePass·SSAO·Bloom) 금지.

## 완료 게이트 — 설계서 §9의 2·3일 행

슬라이스 2:
- 기존 URL·직접 진입·인증 실패·가구 없음 경로 확인
- **화면에 header/tab/iframe 0개**
- `out/play/app/index.html` 존재
- Android 뒤로 / iOS 버튼 / 가로 회전
- **이탈 뒤 금융 화면이 원상 복원**(body 스크롤 잠금 해제, 상태바 테마 복원)

슬라이스 3:
- 기존 규칙 테스트 유지
- **저장 좌표 왕복** · 벽/나무/물/모서리 충돌 · 최대 delta · 패드 cancel · 다중 터치
- **같은 논리 경로를 2D와 3D에서 비교**하고 접지 확인
- 먼 대상 획득 0

기존 게이트:
```
pnpm --filter @family/web exec vitest run <backyard·miniapp 테스트 전부>
pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web build:mobile
```

## 보고

`worker_done` 본문에 **통과한 게이트와 전체 화면 실측 경계(세로·가로)**를 담는다.
보고서는 `docs/rpg3d-s23-report.md`에, 증거는 `docs/evidence/rpg3d-s23/`에.

## 지켜야 할 것

- **슬라이스 4 이후를 미리 만들지 않는다.** 저장 이행·주민·채집·낚시·도감은 이번이 아니다.
- **2D 파일을 지우지 마라.** 걷어내는 것은 나중이고 롤백 후보로 남아 있어야 한다.
- 확인 못 한 것은 **"확인 못 함"**이라고 쓴다. 실기기 판단을 에뮬레이터로 대신하지 마라.
- `build:packages`가 `FULL TURBO`면 검증이 아니다. `--force`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
- **운영 스택(`docker-compose.prod.yml`)에 쓰지 마라.**
