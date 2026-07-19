# @family/mobile — Capacitor 네이티브 셸 (iOS/Android)

`apps/web`의 **정적 export 산출물(`apps/web/out`)** 을 네이티브 앱에 번들해 App Store /
Play Store에 올리는 Capacitor 프로젝트입니다.

- **로드 방식**: 정적 번들(오프라인 셸). `server.url` 미사용 → 앱은 즉시 실행되고
  데이터만 원격 API(`NEXT_PUBLIC_API_URL`)로 호출합니다.
- **인증**: 네이티브 WebView는 cross-site HttpOnly refresh 쿠키를 못 쓰므로, refresh
  토큰을 응답 바디로 받아 `@aparajita/capacitor-secure-storage`에 보관하고
  `X-Refresh-Token` 헤더로 재전송합니다. access token은 웹과 동일하게 `Bearer` 헤더.
  iOS는 동기화가 꺼진 기기 전용 Keychain, Android는 Keystore의 AES-GCM 키로 암호화된
  SharedPreferences를 사용합니다. 기존 Preferences 토큰은 첫 실행 때 검증 후 1회 이전합니다.
  (웹은 기존 쿠키 흐름 그대로 — 서버는 플랫폼 헤더와 허용된 WebView origin을 함께 검증)
- **CORS**: 네이티브 fetch는 WebView origin(`capacitor://localhost`(iOS) /
  `http://localhost`(Android))에서 나가므로 API CORS allowlist에 이 origin들을 추가해
  두었습니다(`apps/api/src/main.ts`).
- **백업 보호**: Android는 기존·보안 저장소 Preferences 파일을 클라우드·기기 간 백업에서
  제외합니다. iOS Keychain 항목은 `whenUnlockedThisDeviceOnly`로 저장합니다.
  iOS는 Preferences 사용 사유(`CA92.1`)를 `PrivacyInfo.xcprivacy`에 선언합니다.

---

## 사전 요구사항

| 대상 | 필요 도구 |
|------|-----------|
| iOS | macOS + **Xcode** (플러그인은 Swift Package Manager로 연결) |
| Android | **Android Studio** + Android SDK, **JDK 21** |
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

---

## Release 빌드와 서명

스토어용 빌드 전에 Android `versionCode`/`versionName`과 iOS
`CURRENT_PROJECT_VERSION`/`MARKETING_VERSION`을 함께 올립니다. 현재 두 플랫폼의 앱 식별자는
`ai.familymemory.app`입니다.

### Android — 서명된 AAB

키스토어 파일은 저장소 밖에 보관하고 비밀번호는 셸 세션 또는 CI 비밀 저장소에서만
주입합니다. `*.jks`와 `*.keystore`는 Git에서 제외됩니다.

```bash
export ANDROID_KEYSTORE_PATH=/absolute/path/family-memory-release.jks
export ANDROID_KEYSTORE_PASSWORD='<secret>'
export ANDROID_KEY_ALIAS='family-memory'
export ANDROID_KEY_PASSWORD='<secret>'

cd apps/mobile/android
./gradlew :app:bundleRelease
jarsigner -verify -verbose -certs app/build/outputs/bundle/release/app-release.aab
```

네 환경변수 중 하나라도 없으면 Release 작업은 즉시 실패합니다. 서명 없이 Release 컴파일만
검증할 때만 아래 플래그를 명시합니다. 이 산출물은 Play Console에 업로드하면 안 됩니다.

```bash
./gradlew :app:bundleRelease -PallowUnsignedRelease=true
```

### iOS — Archive

Xcode 계정에 `Apple Distribution` 인증서와 `ai.familymemory.app`용 App Store provisioning
profile이 준비돼 있어야 합니다. Xcode의 `Product > Archive`를 사용하거나 다음 명령으로
archive를 만듭니다.

```bash
xcodebuild \
  -project apps/mobile/ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath build/FamilyMemory.xcarchive \
  archive
```

인증서가 없는 머신에서 컴파일 경로만 확인할 때는 임시 경로에
`CODE_SIGNING_ALLOWED=NO`로 archive하고 결과를 배포하지 않습니다.

> Keychain 동작이나 Preferences → Keychain 마이그레이션을 검증할 때는
> `CODE_SIGNING_ALLOWED=NO`를 사용하면 안 됩니다. iOS 시뮬레이터의 기본 ad-hoc 서명
> 또는 실기기 Development 서명을 유지해야 Keychain 쓰기까지 검증할 수 있습니다.

### API 서버 주소 / 공개 웹 도메인 (빌드 시 주입)

정적 export는 `NEXT_PUBLIC_API_URL`(API 호출 대상)과 `NEXT_PUBLIC_WEB_URL`(초대 링크 등
공유용 절대 URL의 베이스)을 **빌드 시점에 인라인**합니다. 앱의 WebView origin은
`capacitor://localhost`(iOS) / `https://localhost`(Android)라서 `NEXT_PUBLIC_WEB_URL`이
없으면 앱에서 만든 초대 링크가 `localhost`로 생성됩니다. 타깃별로:

```bash
# 실기기/시뮬레이터에서 로컬 API로 테스트 → 맥의 LAN IP (localhost는 기기에서 자기 자신)
NEXT_PUBLIC_API_URL=http://192.168.0.10:3001 \
NEXT_PUBLIC_WEB_URL=http://192.168.0.10:3000 \
  pnpm --filter @family/web build:mobile

# 프로덕션
NEXT_PUBLIC_API_URL=https://api.your-domain.com \
NEXT_PUBLIC_WEB_URL=https://app.your-domain.com \
  pnpm --filter @family/web build:mobile
```

> **iOS ATS**: HTTP(비 TLS) API로 붙는 개발 빌드는 iOS가 차단합니다. 개발 중에는
> `https`를 쓰거나 `ios/App/App/Info.plist`에 `NSAppTransportSecurity` 예외를 임시로
> 추가하세요(프로덕션은 반드시 `https`).

---

## 딥링크(초대 링크)

앱이 열리면 `apps/web/src/lib/native.ts`의 `initNative()` → `appUrlOpen` 리스너가 토큰을
추출해 `/join?token=...` 화면으로 클라이언트 라우팅합니다. 두 경로를 지원하도록 구성돼
있습니다:

1. **커스텀 스킴 `familymemory://join?token=...`** — 도메인 검증 불필요, **바로 동작**.
   - iOS: `ios/App/App/Info.plist`의 `CFBundleURLTypes`
   - Android: `AndroidManifest.xml`의 `<data android:scheme="familymemory"/>` intent-filter

2. **HTTPS App/Universal Links `https://<도메인>/join?token=...`** — placeholder 도메인
   `app.subinary.cloud`로 스캐폴딩됨. **실제 동작하려면 도메인 소유 검증 필요**:
   - Android: `AndroidManifest.xml`의 host를 실제 도메인으로 교체 + 서버에
     `/.well-known/assetlinks.json` 배포(SHA256 서명 지문 포함).
   - iOS: `ios/App/App/App.entitlements`의 도메인 교체 + Xcode에서 Associated Domains
     capability 활성화(이때 entitlements가 프로젝트에 연결됨) + Apple Developer App ID 권한
     + 서버에 `/.well-known/apple-app-site-association` 배포.

> 딥링크 설정이 없어도 앱 내 '초대 받기'에 링크/토큰을 붙여넣어 수락할 수 있습니다.

---

## 앱 아이콘 / 스플래시

브랜드(primary `#35c5f0` + 흰색 credit-card 글리프)로 생성돼 있습니다. 소스 이미지는
`apps/mobile/assets/*.png`(`scripts/gen-source-assets.cjs`로 생성), 플랫폼별 산출물은
`@capacitor/assets`로 확장했습니다. 브랜드를 바꾸려면:

```bash
# 소스 재생성(색/글리프 수정은 scripts/gen-source-assets.cjs) → 플랫폼 아이콘/스플래시 확장
cd apps/mobile
node scripts/gen-source-assets.cjs        # assets/*.png 갱신 (sharp 필요)
pnpm exec capacitor-assets generate --ios --android
```

> `--ios --android`로 한정: pwa 타깃은 `www/manifest.json`을 요구해 이 프로젝트에선 실패한다.
> 직접 만든 로고 이미지가 있으면 `assets/icon-only.png`(1024) · `assets/icon-foreground.png` ·
> `assets/icon-background.png` · `assets/splash.png`(2732) · `assets/splash-dark.png`로 교체 후
> generate만 다시 실행하면 된다.

---

## ⚠️ web 개발 컨테이너 재빌드 필요

`apps/web`가 이제 `@capacitor/*`를 import합니다(`lib/native.ts`). compose는 소스만
바인드마운트하고 node_modules는 이미지에 구워져 있으므로, **web dev 이미지를 재빌드**해야
`next dev`가 새 의존성을 찾습니다:

```bash
docker compose build web && docker compose up -d --force-recreate web
```
