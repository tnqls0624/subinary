# 뒷마당 3D 미리보기

그래픽·모션을 고치면서 **제품 스크립트 그대로** 화면을 찍는 도구다. 저장·API·운영 스택을 건드리지 않는다.
`apps/web/public/` 밖에 두는 이유: `public/`은 정적 export로 폰까지 나간다.

```sh
# 장면만 (빌드 불필요, 약 15초) — 6장면 × 폰/가로
node scripts/preview-backyard/shot.mjs /tmp/backyard-preview/v1

# 실제 라우트 (정적 export 필요) — 입장·말풍선·낚시·획득 카드·가로
pnpm --filter web build:mobile
node scripts/preview-backyard/route.mjs /tmp/backyard-preview/route
```

- `index.html`은 `rpg3d-scene.js`를 `hour` 쿼리로 시각을 고정해 띄운다. `window.__place(x,y,dir)`·`__pose(distance,moving)`·`__hour(h)`·`__advance(ms)`로 조작한다.
- `route.mjs`는 `**/v1/**`를 전부 가로채 메모리 fixture로 답한다. 운영 서버로는 요청이 나가지 않는다.
- Playwright는 `~/.agents/skills/gstack/node_modules/playwright`를 쓴다(`PLAYWRIGHT_MODULE`로 바꿀 수 있다).
- **빌드와 동시에 돌리지 말 것** — SwiftShader가 경합하면 스크린샷이 타임아웃된다.

데스크톱 Chromium 결과이며 실기기 증거가 아니다.
