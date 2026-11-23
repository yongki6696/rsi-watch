#!/usr/bin/env bash
# 오더허브 자동 업데이트 - 서버에서 5분마다 실행 (systemd 타이머: orderhub-update.timer)
# GitHub 에 새 버전이 올라와 있으면 받아서 다시 빌드한다.
#  - 빌드에 실패하거나 새 버전이 정상 시작되지 않으면 이전 버전으로 되돌린다.
#  - 실패한 버전은 1시간 동안 다시 시도하지 않는다.
# 사용법: sudo bash scripts/auto-update.sh [--force]   (--force: 새 버전이 없어도 지금 코드로 다시 빌드)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

LOG="${ORDERHUB_UPDATE_LOG:-/var/log/orderhub-update.log}"
STATE_DIR="${ORDERHUB_UPDATE_STATE:-/var/lib/orderhub-update}"
HEALTH_WAIT="${ORDERHUB_HEALTH_WAIT:-90}"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

mkdir -p "$STATE_DIR"
exec 9>"$STATE_DIR/lock"
if [ "$FORCE" = 1 ]; then
  flock 9 # 다른 확인 작업이 끝날 때까지 기다렸다가 반드시 실행
else
  flock -n 9 || exit 0 # 이미 실행 중이면 이번 확인은 건너뜀
fi

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" | tee -a "$LOG"; }

BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
  log "현재 브랜치를 알 수 없어 건너뜀"
  exit 0
fi
BEFORE="$(git rev-parse HEAD)"

REMOTE="$BEFORE"
if git fetch -q origin "$BRANCH" >>"$LOG" 2>&1; then
  REMOTE="$(git rev-parse FETCH_HEAD)"
elif [ "$FORCE" = 0 ]; then
  exit 0 # 인터넷/GitHub 일시 오류 - 다음에 다시
fi

if [ "$REMOTE" != "$BEFORE" ]; then
  if [ "$FORCE" = 0 ] && [ -f "$STATE_DIR/failed" ]; then
    read -r failed_sha failed_at <"$STATE_DIR/failed" || true
    if [ "${failed_sha:-}" = "$REMOTE" ] && [ $(($(date +%s) - ${failed_at:-0})) -lt 3600 ]; then exit 0; fi
  fi
  if ! git merge-base --is-ancestor "$BEFORE" "$REMOTE"; then
    log "서버의 코드가 GitHub 과 달라서(직접 수정됨) 자동 업데이트를 건너뜀"
    exit 0
  fi
  if ! git merge -q --ff-only "$REMOTE" >>"$LOG" 2>&1; then
    log "새 버전 받기 실패 (서버에서 직접 고친 파일이 있는지 확인)"
    echo "$REMOTE $(date +%s)" >"$STATE_DIR/failed"
    exit 1
  fi
  log "새 버전 받음: ${BEFORE:0:7} → ${REMOTE:0:7}"
elif [ "$FORCE" = 0 ]; then
  exit 0 # 새 버전 없음
fi

# 새로 띄운 오더허브가 정상 응답하는지 확인
healthy() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_WAIT" ]; do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; then
      return 0
    fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

rollback() {
  echo "$(git rev-parse HEAD) $(date +%s)" >"$STATE_DIR/failed"
  if [ "$(git rev-parse HEAD)" != "$BEFORE" ]; then
    git reset -q --hard "$BEFORE"
    docker compose up -d --build >>"$LOG" 2>&1 || true
    log "이전 버전(${BEFORE:0:7})으로 되돌렸습니다"
  fi
}

log "빌드 시작 ($(git rev-parse --short HEAD))"
if ! docker compose up -d --build >>"$LOG" 2>&1; then
  log "빌드 실패 → 이전 버전이 계속 실행됩니다"
  rollback
  exit 1
fi
if ! healthy; then
  log "새 버전이 정상적으로 시작되지 않음"
  rollback
  exit 1
fi
rm -f "$STATE_DIR/failed"
docker image prune -f >/dev/null 2>&1 || true
log "업데이트 완료 ($(git rev-parse --short HEAD))"
