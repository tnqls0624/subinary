#!/bin/sh
# =============================================================================
# deploy-ota-bundle.sh — 웹 번들만 앱에 배포 (네이티브 재빌드 없이)
# -----------------------------------------------------------------------------
# ## 무엇을 푸는가
#
# 앱은 `webDir`에 구운 정적 번들로 돌아간다. 웹만 바뀐 릴리스마다 Xcode/Gradle을 열어
# 재빌드·재설치하는 것이 실제 병목이었다. 이 스크립트는 그 번들만 갈아끼운다.
#
# `server.url`로 원격을 직접 로드하는 방법도 있지만 채택하지 않았다 — WebView origin이
# 바뀌어 네이티브 인증 판정(`isTrustedNativeClient`)이 무너진다. 자세한 이유는
# `apps/mobile/capacitor.config.ts` 머리주석에 있다.
#
# ## 무엇이 바뀌면 이걸로 부족한가
#
# **네이티브 코드가 바뀌면 여전히 재빌드다.** 플러그인 추가/제거, 권한(Info.plist ·
# AndroidManifest), 아이콘·스플래시, Capacitor 버전 업. 웹 자산(`apps/web/src`)만 바뀐
# 경우에만 이 경로를 쓴다.
#
# ## 절차
#
#   1. `BUILD_TARGET=mobile`로 정적 export (`apps/web/out`)
#   2. out/ 을 zip으로 묶고 SHA256을 잰다
#   3. 운영 볼륨(ota-bundles)에 zip과 manifest.json을 넣는다
#   4. api가 `/v1/ota/manifest`로 그 사실을 확인해 준다
#
# 앱은 다음 실행에서 이걸 받아 적용한다(`autoUpdate: atBackground`). 새 번들이 부팅에
# 실패하면 10초 뒤 이전 번들로 **자동 롤백**된다(`appReadyTimeout` + `notifyAppReady`).
#
# ## 사용
#
#   sh scripts/ops/deploy-ota-bundle.sh                # 버전 자동(타임스탬프)
#   sh scripts/ops/deploy-ota-bundle.sh 1.4.0          # 버전 지정
#
# 종료 코드: 0 = 배포됨 · 1 = 실패
# =============================================================================
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
repository_root="$(cd "$script_dir/../.." && pwd)"
cd "$repository_root"

# 번들 버전. 플러그인은 설치된 버전과 **문자열 비교**만 하므로 단조 증가하면 충분하다.
# 기본값을 타임스탬프로 두는 이유: 사람이 매번 번호를 정하면 빠뜨리고, 같은 버전을 두 번
# 올리면 앱이 갱신을 건너뛴다(조용히 아무 일도 안 일어난다).
version="${1:-$(date '+%Y.%m.%d-%H%M%S')}"
api_container="${OTA_API_CONTAINER:-family-memory-ai-api-1}"
bundle_name="web-${version}.zip"
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT

echo "[ota] 버전: $version"

# --- 1. 정적 export -----------------------------------------------------------
# API URL은 빌드 시 번들에 인라인된다. 기본값(프로덕션)을 덮어쓰지 않도록 명시한다 —
# 셸에 개발용 값이 남아 있으면 앱이 localhost를 보고 조용히 죽는다.
: "${NEXT_PUBLIC_API_URL:=https://app.subinary.cloud}"
export NEXT_PUBLIC_API_URL
echo "[ota] 정적 export (API=$NEXT_PUBLIC_API_URL)"
pnpm --filter @family/web build:mobile >"$work_dir/build.log" 2>&1 || {
  echo "[ota] ✗ 빌드 실패 — 마지막 20줄:" >&2
  tail -20 "$work_dir/build.log" >&2
  exit 1
}

out_dir="$repository_root/apps/web/out"
[ -d "$out_dir" ] || { echo "[ota] ✗ out/ 이 없습니다" >&2; exit 1; }
[ -f "$out_dir/index.html" ] || { echo "[ota] ✗ out/index.html 이 없습니다 — export가 비었습니다" >&2; exit 1; }

# --- 2. zip + 체크섬 ----------------------------------------------------------
# zip 루트에 index.html이 오도록 out/ **안에서** 묶는다. 한 단계 감싸면 플러그인이
# 진입점을 못 찾아 흰 화면이 된다.
zip_path="$work_dir/$bundle_name"
( cd "$out_dir" && zip -qr "$zip_path" . )
checksum="$(shasum -a 256 "$zip_path" | awk '{print $1}')"
size_kb=$(( $(wc -c < "$zip_path") / 1024 ))
echo "[ota] 번들: $bundle_name (${size_kb}KB)"
echo "[ota] sha256: $checksum"

# --- 3. 운영 볼륨에 배치 -------------------------------------------------------
# api 컨테이너는 볼륨을 **읽기 전용**으로 잡는다. 그래서 쓰기는 같은 볼륨을 rw로 붙인
# 일회성 컨테이너로 한다 — 앱 프로세스가 번들을 갈아끼울 수 없게 유지하는 것이 요점이다.
#
# 볼륨 이름을 하드코딩하지 않고 **api가 실제로 마운트한 것**을 읽는다. compose는
# 프로젝트명을 접두하므로(`family-memory-ai_ota-bundles`) 이름을 적어 두면 빈 볼륨을
# 새로 만들어 거기 넣고, api는 다른 볼륨을 읽어 "없음"을 답한다 — 원인을 알기 어려운
# 실패다. 프로젝트명이 바뀌어도 이 방식은 따라간다.
volume_name="$(docker inspect "$api_container" \
  --format '{{range .Mounts}}{{if eq .Destination "/srv/ota"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
if [ -z "$volume_name" ]; then
  echo "[ota] ✗ api 컨테이너에 /srv/ota 마운트가 없습니다 — compose 배포가 먼저입니다." >&2
  exit 1
fi
echo "[ota] 운영 볼륨에 배치: $volume_name"
docker run --rm \
  -v "$volume_name":/srv/ota \
  -v "$work_dir":/staging:ro \
  --entrypoint sh \
  alpine:3 -c "
    set -e
    mkdir -p /srv/ota/bundles
    cp /staging/$bundle_name /srv/ota/bundles/$bundle_name
    # 매니페스트는 **마지막에** 쓴다. zip보다 먼저 쓰면 그 사이 앱이 확인했을 때
    # 아직 없는 파일을 가리키게 된다.
    cat > /srv/ota/manifest.json <<JSON
{
  \"version\": \"$version\",
  \"file\": \"$bundle_name\",
  \"checksum\": \"$checksum\"
}
JSON
    ls -1 /srv/ota/bundles | tail -5
  " >"$work_dir/place.log" 2>&1 || {
  echo "[ota] ✗ 볼륨 배치 실패:" >&2
  cat "$work_dir/place.log" >&2
  exit 1
}

# --- 4. 서버가 보는 값으로 확인 -------------------------------------------------
# 파일을 넣었다는 사실이 아니라 **api가 그것을 읽는다**는 사실을 확인한다. 볼륨 이름을
# 틀리거나 마운트가 빠지면 여기서 드러난다.
echo "[ota] api 확인"
served="$(docker exec "$api_container" node -e "
  fetch('http://localhost:3001/v1/ota/manifest')
    .then(r => r.json())
    .then(j => console.log(JSON.stringify(j)))
    .catch(e => { console.log(JSON.stringify({error: e.message})); });
" 2>/dev/null || echo '{"error":"exec failed"}')"

echo "[ota] 응답: $served"
case "$served" in
  *"\"version\":\"$version\""*)
    echo "[ota] ✓ 배포 완료 — 앱은 다음 실행에서 받아 적용합니다."
    echo "[ota]   새 번들이 부팅에 실패하면 10초 뒤 이전 번들로 자동 롤백됩니다."
    ;;
  *)
    echo "[ota] ✗ api가 이 버전을 보지 못합니다. 볼륨 마운트(ota-bundles)를 확인하세요." >&2
    exit 1
    ;;
esac
