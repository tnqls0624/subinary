#!/bin/sh
# =============================================================================
# money-cutover.sh — ADR-0027 롤아웃 5단계 전환 (shadow → v2)
# -----------------------------------------------------------------------------
# 쓰기 펜스를 건 채로 api·worker를 **동시에** v2로 올리고 다시 연다.
#
# ## 왜 스크립트인가
#
# 이 절차의 위험은 실패가 아니라 **중단**이다. 펜스만 걸린 채 사람이 멈추면 가족이
# 앱에서 아무것도 저장하지 못한다. 그래서 어떤 경로로 끝나든(성공·실패·Ctrl-C)
# 펜스와 승격 정지를 반드시 되돌린다(trap EXIT).
#
# 펜스 자체에도 TTL(기본 900초)이 있어 스크립트가 통째로 죽어도 자동 만료된다.
# 이 스크립트의 trap은 그 15분을 기다리지 않게 하는 장치이지, 유일한 안전장치가 아니다.
#
# ## 되돌리기
#
#   .env.production 에서 MONEY_CONTRACT_MODE 줄을 지우고 이 스크립트를 다시 실행한다
#   (기본값이 shadow다). 데이터는 되돌릴 것이 없다 — 전환은 기존 행을 바꾸지 않는다.
#
# 실행:  sh scripts/ops/money-cutover.sh
# =============================================================================
set -eu

PROJECT="${MONEY_CUTOVER_PROJECT:-family-memory-ai}"
COMPOSE="docker compose --env-file .env --env-file .env.production -f docker-compose.prod.yml"
FENCE="node scripts/money-fence.mjs"
FENCE_ARGS="--project $PROJECT --i-know"

released=0
release() {
  [ "$released" = "1" ] && return 0
  released=1
  echo ""
  echo "[cutover] 펜스와 승격 정지를 해제합니다 (어떤 경로로 끝나든 반드시 실행)"
  $FENCE resume $FENCE_ARGS || echo "[cutover] ⚠ resume 실패 — 수동 확인 필요"
  $FENCE off $FENCE_ARGS || echo "[cutover] ⚠ fence off 실패 — 수동 확인 필요"
}
trap release EXIT INT TERM

echo "[cutover] 0. 전환 전 상태"
$FENCE status $FENCE_ARGS

if ! grep -q '^MONEY_CONTRACT_MODE=v2' .env.production; then
  echo ""
  echo "[cutover] ✗ .env.production 에 MONEY_CONTRACT_MODE=v2 가 없습니다."
  echo "         먼저 아래 한 줄을 추가한 뒤 다시 실행하십시오:"
  echo ""
  echo "           printf '\\nMONEY_CONTRACT_MODE=v2\\n' >> .env.production"
  echo ""
  exit 2
fi

echo ""
echo "[cutover] 1. 쓰기 펜스 ON — API의 금액 쓰기 4경로가 503을 돌려줍니다"
$FENCE on $FENCE_ARGS

echo ""
echo "[cutover] 2. 승격 소비 정지 — worker가 큐에서 금액을 쓰지 않게 합니다"
$FENCE pause $FENCE_ARGS

echo ""
echo "[cutover] 3. api·worker 재기동 (MONEY_CONTRACT_MODE=v2)"
# 두 서비스를 한 명령으로 올린다. 순차로 올리면 한쪽만 v2인 구간이 생기는데,
# 그 구간에 쓰기가 흐르면 두 계약의 거래가 섞여 사후에 구분할 수 없다.
# 펜스가 그 구간을 막고 있지만, 명령까지 한 번으로 두어 창을 최소화한다.
$COMPOSE up -d --no-build api worker

echo ""
echo "[cutover] 4. 두 서비스가 모두 v2를 게시할 때까지 대기 (모드 TTL 60초)"
i=0
while [ "$i" -lt 30 ]; do
  out=$($FENCE status $FENCE_ARGS 2>&1 || true)
  api_v2=$(echo "$out" | grep -c 'API 모드 *v2' || true)
  wrk_v2=$(echo "$out" | grep -c 'worker 모드 *v2' || true)
  if [ "$api_v2" = "1" ] && [ "$wrk_v2" = "1" ]; then
    echo "[cutover] ✓ api·worker 모두 v2"
    break
  fi
  i=$((i + 1))
  sleep 2
done

echo ""
echo "[cutover] 5. 전환 후 상태"
$FENCE status $FENCE_ARGS

release
trap - EXIT INT TERM

echo ""
echo "[cutover] 6. 최종 상태"
$FENCE status $FENCE_ARGS

echo ""
echo "[cutover] 완료. 이어서 무회귀를 확인하십시오:"
echo "  node scripts/replay-money-contract.mjs"
