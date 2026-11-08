#!/bin/sh
# 운영 앱 이미지(family-memory-ai/prod:<git-sha>) 보존 정리 — 배포 검증이 끝난 뒤 bootstrap 이 부른다.
#
# 배포마다 커밋 태그가 하나씩 붙는데 지우는 곳이 없어, 19개(고유 약 1.7GB씩, 합계 약 33GB)가
# 쌓여 이미지 빌드 디스크 기준(40GB)에 배포가 막혔다(2026-11-09, 같은 일이 2026-09 에도 두 번).
# 최신 이미지 N개(기본 5)와 컨테이너가 쓰는 이미지, :local, 이번 배포 태그만 남긴다.
#
# 태그를 지워도 같은 레이어를 빌드 캐시가 잡고 있어 호스트 공간이 돌아오지 않았다(그날 실측:
# 이미지 33.6GB → 8.3GB 인데 호스트 여유 35GB → 35GB, 이어서 캐시를 정리하자 47GB). 그래서
# 태그 정리 뒤에 docs/production-deploy.md §5.1 의 캐시 정리(10GB 는 남김)를 한다.
# docker system prune·volume prune·rmi -f 는 쓰지 않는다 — 운영 데이터와 쓰는 이미지를 지킬 수 없다.
#
# 사용: prune-app-images.sh [이번 배포 태그]
#   INFRA_KEEP_APP_IMAGES=5     남길 이미지 수(1 이상). 태그가 아니라 서로 다른 이미지 ID 로 센다.
#   INFRA_PRUNE_DRY_RUN=true    지우지 않고 무엇을 지울지만 출력(true/false 만 받는다)
set -u

repository=family-memory-ai/prod
keep="${INFRA_KEEP_APP_IMAGES:-5}"
current_tag="${1:-}"
dry_run="${INFRA_PRUNE_DRY_RUN:-false}"

case "$keep" in
  '' | *[!0-9]*)
    echo "[prune] INFRA_KEEP_APP_IMAGES 는 1 이상의 정수여야 한다(받은 값: '$keep')" >&2
    exit 64
    ;;
esac
if [ "$keep" -lt 1 ]; then
  echo "[prune] INFRA_KEEP_APP_IMAGES 는 1 이상이어야 한다 — 0 이면 지금 도는 이미지의 롤백 후보가 사라진다" >&2
  exit 64
fi
# 미리보기를 켜려고 1·TRUE 처럼 쓴 값이 조용히 실제 삭제로 넘어가지 않게 한다.
case "$dry_run" in
  true | false) ;;
  *)
    echo "[prune] INFRA_PRUNE_DRY_RUN 은 true/false 만 받는다(받은 값: '$dry_run')" >&2
    exit 64
    ;;
esac

# 컨테이너가 쓰는 이미지 ID(정지한 것 포함). 목록을 못 읽으면 무엇이 쓰이는지 모르니 아무것도 지우지 않는다.
if ! containers="$(docker ps -aq)"; then
  echo "[prune] docker ps 실패 — 쓰는 이미지를 알 수 없어 정리를 건너뛴다" >&2
  exit 1
fi
in_use=""
for container in $containers; do
  # 그사이 지워진 컨테이너는 건너뛴다.
  image_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null)" || continue
  in_use="$in_use
$image_id"
done

local_id="$(docker image inspect --format '{{.Id}}' "$repository:local" 2>/dev/null)" || local_id=""

if ! listing="$(docker image ls --no-trunc "$repository" --format '{{.CreatedAt}}|{{.Tag}}|{{.ID}}')"; then
  echo "[prune] docker image ls 실패 — 정리를 건너뛴다" >&2
  exit 1
fi

# 만든 시각 내림차순(같은 Mac 에서 만든 이미지라 시간대가 같아 글자 순 정렬이 곧 시간 순이다).
sorted="$(printf '%s\n' "$listing" | sort -r)"

rank=0
ranked_ids=""
kept=0
removed=0
failed=0
while IFS='|' read -r _created tag image_id; do
  # 커밋 태그(12자리 sha, 허용된 dirty 빌드는 -dirty)만 다룬다. :local 과 손으로 붙인 태그는 건드리지 않는다.
  printf '%s\n' "$tag" | grep -Eq '^[0-9a-f]{12}(-dirty)?$' || continue

  # 순위는 서로 다른 이미지 ID 로 센다. 이미지에 안 들어가는 파일만 바뀐 커밋은 같은 이미지에
  # 태그만 하나 더 붙으므로, 태그로 세면 남는 버전이 N개보다 적어진다.
  if ! printf '%s\n' "$ranked_ids" | grep -Fxq -- "$image_id"; then
    rank=$((rank + 1))
    ranked_ids="$ranked_ids
$image_id"
  fi

  reason=""
  if [ "$rank" -le "$keep" ]; then
    reason="최신 ${keep}개"
  elif [ -n "$current_tag" ] && [ "$tag" = "$current_tag" ]; then
    reason="이번 배포"
  elif [ -n "$local_id" ] && [ "$image_id" = "$local_id" ]; then
    reason=":local 과 같은 이미지"
  elif [ -n "$image_id" ] && printf '%s\n' "$in_use" | grep -Fxq -- "$image_id"; then
    reason="컨테이너가 쓰는 중"
  fi

  if [ -n "$reason" ]; then
    kept=$((kept + 1))
    echo "[prune] 남김 $repository:$tag ($reason)"
    continue
  fi

  if [ "$dry_run" = true ]; then
    removed=$((removed + 1))
    echo "[prune] 지울 예정 $repository:$tag"
    continue
  fi

  # -f 없이 지운다: 혹시 쓰는 이미지면 Docker 가 거부한다.
  if docker rmi "$repository:$tag" >/dev/null; then
    removed=$((removed + 1))
    echo "[prune] 지움 $repository:$tag"
  else
    failed=$((failed + 1))
    echo "[prune] WARNING: $repository:$tag 를 지우지 못했다" >&2
  fi
done <<EOF
$sorted
EOF

if [ "$dry_run" = true ]; then
  echo "[prune] dry run — 지운 것 없음(남김 ${kept}, 지울 예정 ${removed})"
  exit 0
fi

# 태그를 먼저 지워야 캐시가 그 레이어를 놓는다(순서를 바꾸면 그날처럼 0B). 10GB 는 다음 빌드를 위해 남긴다.
if ! docker builder prune --all --force --reserved-space 10GB >/dev/null; then
  echo "[prune] WARNING: 빌드 캐시 정리 실패" >&2
  failed=$((failed + 1))
fi

echo "[infra] app_images_kept=${kept} app_images_removed=${removed} prune_failures=${failed}"
[ "$failed" -eq 0 ]
