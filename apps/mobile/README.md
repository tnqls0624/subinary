# @family/mobile — Capacitor 네이티브 셸 (iOS/Android)

`apps/web`의 **정적 export 산출물(`apps/web/out`)** 을 네이티브 앱에 번들해 App Store /
Play Store에 올리는 Capacitor 프로젝트입니다.

- **로드 방식**: 정적 번들(오프라인 셸). `server.url` 미사용 → 앱은 즉시 실행되고
  데이터만 원격 API(`NEXT_PUBLIC_API_URL`)로 호출합니다.
- **인증**: 네이티브 WebView는 cross-site HttpOnly refresh 쿠키를 못 쓰므로, refresh
  토큰을 응답 바디로 받아 `@capacitor/preferences`(보안 저장)에 보관하고
  `X-Refresh-Token` 헤더로 재전송합니다. access token은 웹과 동일하게 `Bearer` 헤더.
  (웹은 기존 쿠키 흐름 그대로 — `X-Client-Platform` 헤더 유무로 서버가 분기)
- **CORS**: 네이티브 fetch는 WebView origin(`capacitor://localhost`(iOS) /
  `http://localhost`(Android))에서 나가므로 API CORS allowlist에 이 origin들을 추가해
  두었습니다(`apps/api/src/main.ts`).

---

## 사전 요구사항

| 대상 | 필요 도구 |
|------|-----------|
| iOS | macOS + **Xcode**, **CocoaPods**(`sudo gem install cocoapods` 또는 `brew install cocoapods`) |
| Android | **Android Studio** + Android SDK, **JDK 17** |
| 공통 | Node 22, pnpm 9 (이 저장소는 호스트 pnpm 부재 → Docker로 deps 추가하는 규약) |

> 네이티브 프로젝트 생성(`cap add`)과 Xcode/Gradle 빌드는 **개발자 머신에서 직접**
> 실행합니다(서명 인증서·시뮬레이터·SDK가 로컬에 있어야 하므로 CI/Docker 부적합).

---

## 최초 1회 셋업

```bash
# 1) 의존성 설치 — 저장소 규약상 호스트에 pnpm이 없으면 Docker로.
#    (JS deps: @capacitor/core·cli·ios·android·plugins. 이미 package.json에 선언됨)
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim \
  sh -c "corepack enable && pnpm install"

# 2) 웹 정적 셸 1회 빌드(apps/web/out 생성) — 아래 sync가 자동 수행하지만 확인용.
docker run --rm -v "$PWD":/app -w /app node:22-bookworm-slim \
  sh -c "corepack enable && pnpm --filter @family/web build:mobile"

# 3) 네이티브 프로젝트 생성 (개발자 머신에서, apps/mobile 안에서 실행)
cd apps/mobile
pnpm exec cap add ios
pnpm exec cap add android
```

`cap add`가 `apps/mobile/ios`, `apps/mobile/android`를 생성하고 `webDir`(`../web/out`)를
복사합니다. Capacitor 관례상 이 두 폴더는 커밋합니다(네이티브 설정·아이콘이 여기 살아있음).

---

## 개발 루프

```bash
# web 정적 셸 재빌드 + 네이티브로 동기화(플러그인 pod/gradle 반영)
pnpm --filter @family/mobile sync

# IDE 열기 → 시뮬레이터/기기 실행은 Xcode/Android Studio에서
pnpm --filter @family/mobile open:ios       # = cap open ios
pnpm --filter @family/mobile open:android    # = cap open android
```

`apps/web/src/**`만 고쳤다면 `sync` 대신 웹 재빌드 후 `cap copy`로 빠르게 자산만 교체:
```bash
pnpm --filter @family/mobile copy
```

### API 서버 주소 (빌드 시 주입)

정적 export는 `NEXT_PUBLIC_API_URL`을 **빌드 시점에 인라인**합니다. 타깃별로:

```bash
# 실기기/시뮬레이터에서 로컬 API로 테스트 → 맥의 LAN IP (localhost는 기기에서 자기 자신)
NEXT_PUBLIC_API_URL=http://192.168.0.10:3001 pnpm --filter @family/web build:mobile

# 프로덕션
NEXT_PUBLIC_API_URL=https://api.your-domain.com pnpm --filter @family/web build:mobile
```

> **iOS ATS**: HTTP(비 TLS) API로 붙는 개발 빌드는 iOS가 차단합니다. 개발 중에는
> `https`를 쓰거나 `ios/App/App/Info.plist`에 `NSAppTransportSecurity` 예외를 임시로
> 추가하세요(프로덕션은 반드시 `https`).

---

## 딥링크(초대 링크) — 선택/권장

초대는 `https://<도메인>/join?token=...` 링크로 공유됩니다. 네이티브에서 이 링크로 앱이
열리게 하려면 Universal Links(iOS) / App Links(Android)를 설정하세요. 앱이 열리면
`lib/native.ts`의 `initNative()` → `appUrlOpen` 리스너가 경로를 추출해
`/join?token=...` 화면으로 클라이언트 라우팅합니다. (설정 없이도 앱 내 '초대 받기'에
링크/토큰을 붙여넣어 수락 가능)

---

## ⚠️ web 개발 컨테이너 재빌드 필요

`apps/web`가 이제 `@capacitor/*`를 import합니다(`lib/native.ts`). compose는 소스만
바인드마운트하고 node_modules는 이미지에 구워져 있으므로, **web dev 이미지를 재빌드**해야
`next dev`가 새 의존성을 찾습니다:

```bash
docker compose build web && docker compose up -d --force-recreate web
```
