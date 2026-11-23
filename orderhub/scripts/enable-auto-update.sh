#!/usr/bin/env bash
# 오더허브 자동 업데이트 켜기 (한 번만 실행)
# - 5분마다 GitHub 에 새 버전이 있는지 확인해서 자동으로 적용합니다 (systemd 타이머)
# - 지금 코드로 바로 다시 빌드합니다 (백그라운드 - 이 창을 닫아도 계속 진행)
# 끄기: sudo systemctl disable --now orderhub-update.timer
set -euo pipefail
cd "$(dirname "$0")/.."
APP_DIR="$(pwd)"
UNIT_DIR="${ORDERHUB_SYSTEMD_DIR:-/etc/systemd/system}"

if [ "$(id -u)" -ne 0 ] && [ -z "${ORDERHUB_SYSTEMD_DIR:-}" ]; then
  echo "관리자 권한이 필요합니다. 'sudo bash scripts/enable-auto-update.sh' 로 실행해주세요."
  exit 1
fi
chmod +x "$APP_DIR/scripts/auto-update.sh"

cat >"$UNIT_DIR/orderhub-update.service" <<EOF
[Unit]
Description=OrderHub auto update (git pull + docker compose build)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
Environment=HOME=/root
ExecStart=/usr/bin/env bash $APP_DIR/scripts/auto-update.sh
TimeoutStartSec=30min
EOF

cat >"$UNIT_DIR/orderhub-update.timer" <<EOF
[Unit]
Description=Check for OrderHub updates every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable --now orderhub-update.timer >/dev/null 2>&1 || systemctl enable --now orderhub-update.timer
if [ "${ORDERHUB_NO_REBUILD:-0}" = "1" ]; then
  echo "✅ 자동 업데이트를 켰습니다. 새 버전이 올라오면 5분 안에 서버에 자동으로 적용됩니다."
  exit 0
fi
# 지금 바로 새 버전으로 다시 빌드 (SSH 연결이 끊겨도 계속 진행되도록 별도 서비스로 실행)
systemd-run --unit="orderhub-rebuild-$(date +%s)" --collect --property=Environment=HOME=/root \
  /usr/bin/env bash "$APP_DIR/scripts/auto-update.sh" --force >/dev/null

cat <<EOF

✅ 자동 업데이트를 켰습니다.
   지금 새 버전을 설치하고 있어요 (2~3분). 이 창은 닫아도 됩니다.
   앞으로는 새 버전이 올라오면 5분 안에 서버에 자동으로 적용됩니다.

   진행 상황 보기 : tail -f /var/log/orderhub-update.log
   자동 업데이트 끄기: sudo systemctl disable --now orderhub-update.timer
EOF
