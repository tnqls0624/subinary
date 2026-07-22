#!/bin/sh
# HolmesGPT 조사 래퍼. 호스트에서 실행한다(컨테이너 아님).
#   sh infrastructure/holmesgpt/investigate.sh "payment-api 컨테이너가 왜 재시작됐는지 조사해줘"
#
# GEMINI_API_KEY를 .env에서 읽어 주입하고(값은 출력하지 않음), config-as-code 설정으로 holmes ask를 호출한다.
# 향후 operational_alerts webhook 수신부에서 이 스크립트를 호출하면 경보 → 자동 읽기 전용 조사가 된다.
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cd "$repo_root"

# uv tool 설치 위치를 PATH에 보장(webhook 등 비대화 컨텍스트 대비).
export PATH="$HOME/.local/bin:$PATH"
command -v holmes >/dev/null 2>&1 || { echo "holmes 미설치: uv tool install holmesgpt" >&2; exit 127; }

# 환경에 없으면 .env에서 GEMINI_API_KEY만 추출한다(값 미출력).
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f .env ]; then
  GEMINI_API_KEY=$(grep -E '^GEMINI_API_KEY=' .env | head -1 | cut -d= -f2-)
  export GEMINI_API_KEY
fi
[ -n "${GEMINI_API_KEY:-}" ] || { echo "GEMINI_API_KEY 미설정(.env 또는 환경변수)" >&2; exit 64; }

[ "$#" -ge 1 ] || { echo "usage: investigate.sh \"<조사 질문>\"" >&2; exit 64; }

exec holmes ask "$@" --config "$script_dir/config.yaml"
