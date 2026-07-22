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

# .env → .env.production 순차 탐색(뒤 파일 우선, prod 관례와 정합). 값은 출력하지 않는다.
# dotenv처럼 CRLF·양끝 따옴표·'export ' 접두를 정규화한다(compose에선 되고 이 스크립트에선 깨지는 불일치 방지).
extract_env() {
  extract_key="$1"; extract_val=""; extract_found=""
  for extract_file in .env .env.production; do
    [ -f "$extract_file" ] || continue
    extract_line=$(grep -E "^(export[[:space:]]+)?${extract_key}=" "$extract_file" | tail -1) || true
    [ -n "$extract_line" ] || continue
    extract_raw=$(printf '%s' "${extract_line#*=}" | tr -d '\r')
    case "$extract_raw" in
      \"*\") extract_raw=${extract_raw#\"}; extract_raw=${extract_raw%\"} ;;
      \'*\') extract_raw=${extract_raw#\'}; extract_raw=${extract_raw%\'} ;;
    esac
    extract_val="$extract_raw"; extract_found=1
  done
  [ -n "$extract_found" ] || return 1
  printf '%s' "$extract_val"
}

if [ -z "${GEMINI_API_KEY:-}" ]; then
  GEMINI_API_KEY=$(extract_env GEMINI_API_KEY) || true
  export GEMINI_API_KEY
fi
[ -n "${GEMINI_API_KEY:-}" ] || { echo "GEMINI_API_KEY 미설정(.env/.env.production 또는 환경변수)" >&2; exit 64; }

[ "$#" -ge 1 ] || { echo "usage: investigate.sh \"<조사 질문>\" [holmes 옵션...]" >&2; exit 64; }

# 타임아웃으로 감싼다(멀티턴 LLM 루프가 지연/행에 걸려도 호출자가 무기한 블록되지 않게).
# macOS엔 timeout(1)이 없으므로 gtimeout(coreutils)→timeout→perl-alarm 순으로 폴백.
# perl alarm 타이머는 exec 후에도 유지되어 초과 시 holmes에 SIGALRM을 보낸다.
# 설정 선택: 자동 경로는 INVESTIGATE_CONFIG=config-automated.yaml(bash 비활성)을 주입한다. 기본은 수동용 config.yaml.
config_path="$script_dir/${INVESTIGATE_CONFIG:-config.yaml}"
[ -f "$config_path" ] || { echo "config 없음: $config_path" >&2; exit 64; }

timeout_seconds="${INVESTIGATE_TIMEOUT_SECONDS:-600}"
if command -v gtimeout >/dev/null 2>&1; then
  exec gtimeout "$timeout_seconds" holmes ask "$@" --config "$config_path"
elif command -v timeout >/dev/null 2>&1; then
  exec timeout "$timeout_seconds" holmes ask "$@" --config "$config_path"
else
  exec perl -e 'alarm shift; exec @ARGV or die "exec failed: $!"' \
    "$timeout_seconds" holmes ask "$@" --config "$config_path"
fi
