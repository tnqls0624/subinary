# 뒷마당 RPG 슬라이스 1 구현 보고

2026-09-06. 구현과 자동 기술 게이트를 확인했으며, 실제 두 사용자 중 한 명의 무설명 사용성 관찰은 **확인 못 함**이다. 따라서 슬라이스 1 전체 승인이나 다음 콘텐츠 착수를 선언하지 않는다.

## 구현 범위

- `rpg-rules.js`: 32×24타일, 1024×768 세계의 임시 지도·통행 사각형·고정 시작 fixture·8방향 정규화. Phaser/DOM/저장 참조 없음.
- `rpg-input.js`: 반경 40px 패드, dead zone 8px, 96px/s, 방향키/WASD. pointer 소유권과 up/cancel/capture 상실/blur/숨김 시 즉시 속도 0.
- `rpg-engine.js`: 고정 Phaser UMD의 Boot/World 씬, 코드 생성 지도·나무·옷 2색의 방향별 정지 1+걷기 4포즈, 8fps, 발 14×10px Arcade 충돌체. 카메라 dead zone 64×48px, 40ms 시간상수(약 120ms에 95% 추종), 세계 bounds clamp. 생성 텍스처는 최초 1회, 앱 별도 RAF 없음.
- 실제 `/play/app/?key=backyard` 진입 HTML을 연결했다. v0 rules/codec/session/renderer/input/app/style 파일은 보존했고 RPG는 저장 bridge를 호출하지 않는다. 새로 열면 집 앞 fixture로 돌아온다.
- 높이는 임시 `min(470px, 100svh - 250px)`만 적용했다. 250px은 기존 호스트 상단 153 + 탭 81 + 여백 16의 실측 합이다. 실측 사각형을 동적으로 재는 완성 반응형·회전·safe-area 대응은 슬라이스 2로 남겼다.
- NPC·채집·낚시·도감·저장 이전·실제 저장·운영 스택 변경 없음.

## 검증

모든 명령 출력은 `docs/evidence/rpg-s1/` 파일로 받았다.

| 게이트 | 결과·근거 |
|---|---|
| 패키지 실제 빌드 | `pnpm exec turbo run build --filter='./packages/*' --force --concurrency=2`: 9/9 성공, 캐시 0; `packages-build.log` |
| 웹 타입 | `pnpm --filter @family/web typecheck` 성공; `web-types.log` |
| 순수/DOM JS 타입 | 각 tsconfig `tsc --noEmit` 성공; `rules-types.log`, `dom-types.log` |
| 관련 테스트 | 새 이동 4건 + 기존 규칙·codec·session·client·host: 6파일 131건 성공; `tests.log` |
| 모바일 export | `pnpm --filter @family/web build:mobile` 성공, 실제 `/play/app/` 포함; `mobile-build.log` |
| UMD 동일성 | 검증 원본·public·out SHA-256 모두 `66348b1b5141e49b7d5ebbe688cddcb502eab1cb00f21c538686a5b2c5abe4de` |
| 실행 환경 | macOS, Playwright Chromium 149.0.7827.55, 실제 export 부모 호스트, `sandbox="allow-scripts"`. 인증/API는 격리 메모리 fixture, 운영 API 호출 없음 |

브라우저 최종 측정은 `export-results.json`과 `browser.log`에 기록한다. `node scripts/verify-backyard/rpg-export.mjs`로 다시 실행할 수 있다. 초반 검증 하네스는 Phaser 4의 native Set을 구버전 entries 배열로 읽어 실패했고, 버전 고정 공식 소스/선언의 `values()`로 수정했다. 집이 수평 방향으로 사라진 것을 수직 경계만으로 판정하던 하네스 assertion도 실제 사각형에 맞췄다. 제품 오류로 숨기거나 기존 결과를 신규 통과로 인용하지 않았다.

## 최종 브라우저 실측

- 연속 산책 경로 61.603초 실행. 시작 시 연못은 화면 밖, 약 7초 뒤 집은 화면 밖이고 연못이 보인다.
- 프레임별 카메라 세계 경계 위반 0건. 네 방향 경계까지 걷는 경로 포함.
- 직선 3초 288.000px, 대각선 3초 289.600px, 차이 0.5556% (기준 5% 이하).
- pointercancel 추가 이동 0.000px, blur 추가 이동 0.000px.
- 물 서쪽에서 발 x=633, 나무 남쪽에서 발 y=286에 멈춤. 물 모서리 대각 충돌 뒤 순수 통행 판정 성공.
- 정상 JavaScript/CORS 콘솔 오류 0건, 게임 state API 요청 0건. 엔진 요청 차단 오류는 별도 `expectedBootFailureErrors`에 분리.
- 부모 320×568 / 360×780 / 430×900에서 iframe 높이 318 / 470 / 470px. 모두 하단 탭 예상 윗변보다 16px 이상 위에 위치. 전체 반응형 완료를 의미하지 않음.

## 화면을 보고 관찰한 느낌

`start.png`에서 캐릭터가 집 앞 길에 서 있고, 입력 후 캐릭터가 중앙의 작은 영역에서 움직이다 배경이 뒤따른다. 약 7초의 오른쪽→위→오른쪽 경로 뒤 `pond.png`에는 집 대신 화면 밖에 있던 물과 나무가 보인다. 발 위치를 중심으로 걸음을 옮기고 장소가 바뀌므로 **캐릭터로 돌아다니는 기본 감각은 보인다**. 기존 칸 선택 화면과 달리 화면 밖에 이어진 장소를 발견하는 전환이 명확하다.

다만 물은 사각형이고 길과 나무가 드문 임시 지도다. 풍경의 완성도나 오래 산책하고 싶은 재미까지 확인한 것은 아니다. 캡처와 자동 입력을 관찰한 에이전트의 판단이며, 사람의 실제 손가락 조작감·무설명 사용성·재미 반응을 대신하지 않는다.

## 남은 게이트와 결정 기록

- 실제 두 사용자 중 한 명이 설명 없이 30초 내 연못 방향으로 이동하는 시험 및 직접 반응: **확인 못 함**. 이에 대한 증거 없이 전체 게이트 통과라고 쓰지 않는다.
- Capacitor 실기기·safe-area·실터치·부모 PullToRefresh·멀티터치 완성·장시간 성능은 이번 실측 아님.
- Memory/context7/sequential-thinking MCP는 도구 목록에 없어 로드·ADR·학습 외부 기록을 하지 못했다. 결정은 여기 기록했다. Task Master 등록 태스크가 아닌 Orca 구현 지시서 작업이다.
- 엔진 API 근거: [공식 카메라 문서](https://docs.phaser.io/phaser/concepts/cameras), [Arcade 문서](https://docs.phaser.io/phaser/concepts/physics/arcade), [고정 4.2.1 World 소스](https://cdn.jsdelivr.net/npm/phaser@4.2.1/src/physics/arcade/World.js). 정확한 버전 선언은 `apps/web/types/phaser/`에 보존했고 라이선스는 동봉했다.
- 반복 방지: 엔진 버전의 실제 컬렉션 API를 확인할 것, viewport 검증은 부모 크기를 바꿀 것, 캐시 없는 DTS 빌드와 실제 export를 함께 확인할 것, 사용자 관찰을 자동 테스트 성공으로 대체하지 말 것.

코디네이터도 start/pond 캡처를 직접 확인해 화면 밖 장소의 발견과 캐릭터 방향 차이를 확인했다고 회신했다. 이는 에이전트의 시각 검토이며 사용자 조작감 관찰은 아니다. 사용자 관찰은 제공할 수 없으므로 미확인으로 남기고, 기술 구현 완료를 succeeded로 보고하라는 지시를 받았다. 슬라이스 2·3은 별도 지시서 대상이다.
