#!/bin/sh
# =============================================================================
# write-google-services.sh — CI/로컬에서 google-services.json 생성
# -----------------------------------------------------------------------------
# Firebase Android 설정 파일은 저장소에 커밋하지 않는다. 빌드 직전에 시크릿에서
# 풀어 쓴다.
#
# 입력 (둘 중 하나):
#   GOOGLE_SERVICES_JSON     — 파일 내용의 base64 (권장, GitHub Actions secret)
#   GOOGLE_SERVICES_JSON_PATH — 이미 디코드된 원본 파일 경로
#
# 출력:
#   apps/mobile/android/app/google-services.json
#
# 예:
#   # GitHub Actions
#   echo "${{ secrets.GOOGLE_SERVICES_JSON }}" | \
#     GOOGLE_SERVICES_JSON="$(cat)" sh apps/mobile/scripts/write-google-services.sh
#
#   # 로컬(파일에서)
#   export GOOGLE_SERVICES_JSON="$(base64 < ~/secrets/google-services.json | tr -d '\n')"
#   sh apps/mobile/scripts/write-google-services.sh
#
# 종료 코드: 0 = 기록됨 · 1 = 입력 없음/디코드 실패
# =============================================================================
set -eu

script_dir="$(cd "$(dirname "$0")" && pwd)"
mobile_root="$(cd "$script_dir/.." && pwd)"
out_file="$mobile_root/android/app/google-services.json"

if [ -n "${GOOGLE_SERVICES_JSON_PATH:-}" ]; then
  if [ ! -f "$GOOGLE_SERVICES_JSON_PATH" ]; then
    echo "write-google-services: GOOGLE_SERVICES_JSON_PATH 파일이 없습니다: $GOOGLE_SERVICES_JSON_PATH" >&2
    exit 1
  fi
  cp "$GOOGLE_SERVICES_JSON_PATH" "$out_file"
elif [ -n "${GOOGLE_SERVICES_JSON:-}" ]; then
  # base64 -d (GNU) / base64 -D (BSD) 모두 시도
  if printf '%s' "$GOOGLE_SERVICES_JSON" | base64 -d >"$out_file" 2>/dev/null; then
    :
  elif printf '%s' "$GOOGLE_SERVICES_JSON" | base64 -D >"$out_file" 2>/dev/null; then
    :
  else
    echo "write-google-services: GOOGLE_SERVICES_JSON base64 디코드에 실패했습니다" >&2
    rm -f "$out_file"
    exit 1
  fi
else
  echo "write-google-services: GOOGLE_SERVICES_JSON 또는 GOOGLE_SERVICES_JSON_PATH 가 필요합니다" >&2
  echo "  자리표시: cp android/app/google-services.json.example android/app/google-services.json" >&2
  exit 1
fi

# 최소한의 JSON 형태만 확인(값은 출력하지 않음)
if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$out_file" 2>/dev/null; then
  echo "write-google-services: 생성 파일이 유효한 JSON이 아닙니다" >&2
  rm -f "$out_file"
  exit 1
fi

chmod 600 "$out_file"
echo "write-google-services: wrote $out_file"
