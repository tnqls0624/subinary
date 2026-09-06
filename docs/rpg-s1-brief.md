# 구현 지시서 — 슬라이스 1: 걷는 느낌의 수직 슬라이스 (2026-09-06)

> **이번 작업은 구현이다.** 이 슬라이스 하나가 재설계 전체의 가설을 검증한다.

## 왜 이것이 첫날인가

v0는 배포 직전까지 완성됐지만 **만들려던 게임이 아니었다.** 다 만들고 나서 알았다.
이번엔 그러지 않기 위해 **"캐릭터로 돌아다니는 느낌이 실제로 나는가"만 첫날에 확인**한다.

이 게이트가 실패하면 콘텐츠(주민·채집·낚시·도감)를 만들지 않는다. 조작·카메라를 먼저 고친다.

## 먼저 읽을 것

1. `docs/redesign-backyard-rpg.md` — **재설계 설계서. 이것이 계약이다.**
   특히 §2(세계와 카메라) · §3(캐릭터와 이동) · §9(엔진) · §11의 1일 행.
2. `docs/verify-sandbox-engine-2026-09.md` — sandbox 실측. **무엇이 되고 무엇이 막히는지.**
   Phaser UMD가 `<script src>`로 뜨는 것은 확인됐고, 외부 PNG·JSON은 CORS로 막힌다.
3. `docs/impl-backyard-v0.md` §5 — 기존 모듈 경계와 저장소 관례. 무엇을 재사용할지 판단하는 근거.

**근거를 확인하려면 문서를 열어라.** "무엇을 하라"만 보고 "왜"를 모른 채 결정하지 마라.

## 이번에 만드는 것 — 슬라이스 1만

설계서 §11의 1일 행이다. **2일차 이후(반응형 높이 완성·지형·NPC·채집·낚시·도감)는 손대지 않는다.**

- Phaser 4.2.1 UMD 동봉 (`scripts/verify-sandbox-engine/vendor/phaser.min.js`와 해시 일치 확인)
- 32×24타일 **임시** 지도 (지형 완성은 3일차다. 걷기 확인에 필요한 최소만)
- 도형 캐릭터 + 8방향 걷기
- 가상 패드 (설계서 §3: 반경 40px, dead zone 8px, 96 월드px/s)
- 카메라 추종 (dead zone 64×48px, 세계 끝 clamp)
- 나무·물 충돌
- **실제 호스트에서 실행** — `/play/app/?key=backyard`
- 저장은 fixture로 대체 (실제 저장은 4·5일차다)

## 반드시 지킬 것

### 자산은 전부 코드 생성 또는 동봉 script
외부 PNG·JSON을 fetch하면 **CORS로 막힌다**(sandbox 실측). `<script src>`는 된다.
지도 데이터도 일반 JS로 동봉한다. 타일맵 JSON을 로드하지 않는다.

### 규칙과 표현을 가른다
기존 구현이 `rules.js`(순수)와 `renderer.js`(표현)를 분리한 이유가 있다 —
엔진을 바꿔도 규칙이 살아남는다. 이번에 엔진이 바뀌는 것이 그 설계가 옳았다는 증거다.
**엔진 어댑터만 Phaser 타입을 본다.** 순수 규칙에 Sprite·Camera·Scene을 넣지 않는다.

### `packages/shared`에 DOM 타입을 두지 않는다
이 저장소가 실제로 당한 함정이다 — `typecheck`는 통과하고 `build:packages`가 터진다.

### 높이는 이번에 완성하지 않는다
설계서 §2가 반응형 공식을 정했지만 그건 2일차다. 이번엔 걷기 확인에 필요한 만큼만
쓰고, **520을 일괄로 박아넣지 마라**(작은 폰에서 하단 탭 뒤로 들어간다 — 설계서 §2 실측).

## 완료 게이트 — 설계서 §11의 1일 행 그대로

```
pnpm --filter @family/web build:mobile
```

그 뒤 실제 `/play/app/?key=backyard`에서 **60초 걷기**:

| 확인 | 기준 |
|---|---|
| 세계가 화면보다 크다 | 시작 집이 화면 밖으로 사라지고, **보이지 않던 연못이 등장** |
| 카메라 경계 | 월드 경계 밖 노출 **0** |
| 대각선 정규화 | 직선/대각 3초 이동거리 차이 **≤5%** |
| 입력 수명 | `pointercancel` 후 추가 이동 **≤1px** |
| 사용성 | 설명 없이 30초 내 연못 방향으로 이동 가능한가 |

**그리고 "캐릭터로 돌아다닌다"는 느낌이 나는지를 직접 기록하라.**
이건 테스트로 판정할 수 없다. 화면을 보고 관찰한 것을 적어라.
느낌이 안 나면 **그렇게 보고하라.** 게이트를 통과했다고 쓰지 마라.

기존 게이트도 깨지지 않아야 한다:
```
pnpm build:packages
pnpm --filter @family/web typecheck
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
```

## 보고

`worker_done` 본문에 **게이트 결과와 "돌아다니는 느낌"에 대한 관찰**을 담는다.
보고서는 `docs/rpg-s1-report.md`에 쓴다.

## 지켜야 할 것

- **슬라이스 2 이후를 미리 만들지 않는다.**
- 기존 v0 파일(`rules.js`·`codec.js` 등)을 지우지 마라. 설계서 §10이 파일별 판정을 했고
  이번 슬라이스는 삭제 대상이 아니다. 병행 존재해도 된다.
- 확인 못 한 것은 **"확인 못 함"**이라고 쓴다.
- `build:packages`가 `FULL TURBO`(캐시)면 검증이 아니다.
  `pnpm exec turbo run build --filter="./packages/*" --force --concurrency=2`로 확인한다.
- 출력은 파일로 받는다 — `| tail`은 vitest를 EPIPE로 죽여 없던 실패를 만든다.
- **운영 스택(`docker-compose.prod.yml`)에 쓰지 않는다.** 이번 슬라이스는 저장이 fixture라
  DB가 필요 없다. 필요해지면 `docs/impl-backyard-verify-env.md`의 격리 DB 관례를 쓴다.
