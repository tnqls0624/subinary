# 뒷마당 슬라이스 3 구현 보고

2026-09-06. 계약: `docs/impl-backyard-s3-brief.md`와 `docs/impl-backyard-v0.md` §4.

미니앱 호스트 런타임과 진입 경로를 복원하고 backyard 하나를 등록했다. 슬라이스 1·2의 네 JS 및 테스트는 수정하지 않았고 renderer·input·HTML·CSS·게임 연결은 만들지 않았다. 커밋·배포는 수행하지 않았다.

## 구현 결과

- shared에는 권한·메서드·메시지·검증 순수 계약만 복원했다. 배열 params 거부와 현재 버전의 응답 판별을 추가했다. 기존 bridge 24개 테스트를 그대로 보존했고 추가 후 32개다. DOM·타이머·SDK는 shared에 없다.
- 배포 `public/miniapps/bridge.js`에 팩토리와 오류 코드를 두었다. `state.get`은 응답의 명시적 `state: null`만 null로 반환하고 누락·불량 응답·호스트 실패·timeout을 reject한다. `state.set`도 완료 ACK를 확인하며 실패를 전파한다.
- 부모 source·버전·응답 스키마를 검사하며 기본 제한은 8초다. 실제 브라우저에서는 문서 로딩 중 ready 리스너를 먼저 설치하고 ready를 기억한다. ready를 놓친 재시도는 host.info 요청으로 재확인한다. destroy는 리스너·대기·타이머를 해제한다.
- 원 SDK 구현은 복원하지 않았다. SDK의 기존 8개 테스트는 `miniapp-client.test.ts`로 이전해 node:vm에서 실제 배포 JS를 실행한다. 테스트용 클라이언트 복제는 없다.
- `src/lib/miniapp-host.ts`에 실제 컴포넌트가 사용하는 메시지 수신·세대 검사와 저장 핸들러를 분리했다. source 검사, iframe 로드 세대 변경, 창 교체, destroy 뒤 이전 비동기 응답 폐기를 검증했다. 내부 오류 상세는 자식에게 전달하지 않는다.
- 저장 가구·앱은 부모 컨텍스트에서 캡처한다. 동일 핸들러 세대·가구·앱·키의 PUT은 직렬 큐로 실행하며, 앞 PUT 실패 뒤에도 다음 PUT을 실행한다. 각 요청은 자기 requestId로 완료 응답을 받는다. 다른 가구·키는 독립적이다.
- `backyard`의 manifest는 이름 `뒷마당`, 설명 `함께 작은 마당을 꾸며요`, 높이 470, 권한 `[]`다. `/more` → `/play` → `/play/app?key=backyard`를 복원했다. 쿼리 라우트와 Suspense 경계를 유지하고 가구·인증 준비 전에는 iframe을 마운트하지 않으며 가구·앱 변경 시 React key로 재생성한다.

## 완료 게이트

최종 코드에 다음 명령을 순서대로 실행했고 모두 종료 코드 0이다.

```sh
pnpm --filter @family/shared test
# 16개 파일, 189개 통과(브릿지 32개 포함)
pnpm --filter @family/web exec vitest run src/lib/miniapp-client.test.ts src/lib/miniapp-host.test.ts
# 2개 파일, 37개 통과
pnpm build:packages
# 9개 작업 통과, shared DTS 포함
pnpm --filter @family/web typecheck
pnpm --filter @family/web build:mobile
```

추가 확인:

```sh
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-dom.json --noEmit
pnpm --filter @family/web exec tsc -p tsconfig.miniapps-rules.json --noEmit
node --check apps/web/public/miniapps/bridge.js
pnpm exec turbo run test --concurrency=1 --force
```

순차 전체 회귀는 19개 작업 통과, 웹 330개 통과이며 기존 게임 89개를 포함한다. API 테스트는 177개 통과·14개 건너뜀이다. 전체 회귀 후 저장 ACK requestId·순서 테스트 한 개와 host.info 권한 배열 원소 검사를 보강했고, 위 최종 필수 게이트 및 DOM 타입 검사를 다시 모두 통과했다(최종 호스트·클라이언트 37개). 타입 검사 과정에서 테스트용 Node 타이머 래퍼의 선언 불일치를 발견해 명시적 함수 타입으로 수정했다.

로그는 `/tmp/backyard-s3-{shared,web-tests,packages,types,mobile,dom,regression}.log`에 있다. stdout은 파일로 받았고 실행 중 tail 파이프로 연결하지 않았다.

## out 산출물

`apps/web/out/play/app/index.html`이 실제로 존재한다. 최종 모바일 빌드 후 아래 배포 파일이 public 원본과 바이트 일치함을 직접 비교했다.

| miniapps 상대 경로 | 바이트 | 결과 |
|---|---:|---|
| bridge.js | 7722 | 일치 |
| backyard/balance.js | 671 | 일치 |
| backyard/rules.js | 8695 | 일치 |
| backyard/codec.js | 7219 | 일치 |
| backyard/session.js | 9651 | 일치 |

## 검증 범위와 남은 일

실제 bridge.js 팩토리와 제품 호스트 런타임을 연결한 Node 단독 harness로 ready·GET·PUT 성공과 GET·PUT 실패 전파를 왕복 검증했다. 이는 제품 화면·실브라우저·WebView 완료 검증이 아니다. 게임 entry `backyard/index.html`은 아직 없고 지시대로 생성하지 않았다. 슬라이스 4 이후 화면·입력·실제 게임 연결, API·DB 왕복, iOS·Android 기기 검증이 남아 있다.

부모 큐는 같은 호스트의 보통 요청 역전을 줄인다. 서버에서 결과 불명 후 늦게 커밋하는 경우와 서로 다른 호스트·기기 간 저장은 revision/CAS 없이 보장하지 않으며 마지막 쓰기 우선 한계를 유지한다.

Memory·context7·sequential-thinking MCP는 현재 제공되지 않아 조회·ADR·학습 기록은 수행하지 못했다. 새 외부 라이브러리는 추가하지 않았다. 반복 방지 기록: 실제 배포 JS를 테스트하고, 읽기 실패를 null로 정규화하지 않으며, 비동기 응답의 창·세대를 캡처하고, shared DTS 및 모바일 export의 파일 일치를 별도 게이트로 확인한다.
