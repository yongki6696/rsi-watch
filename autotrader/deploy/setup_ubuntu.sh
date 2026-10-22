#!/usr/bin/env bash
# 우분투 클라우드 서버에 봇을 설치하고, 서버가 재부팅돼도 자동으로 켜지는 서비스로 등록한다.
#
#   모의매매로 설치:  curl -fsSL <이 파일의 raw 주소> | bash
#   실거래로 설치:    curl -fsSL <이 파일의 raw 주소> | bash -s -- --live
#   (다시 실행하면 최신 코드로 업데이트하고 서비스를 재시작한다)
set -euo pipefail

REPO="https://github.com/yongki6696/rsi-watch.git"
BRANCH="claude/gracious-hopper-8bhohq"
TEMPLATE="${BOT_CONFIG:-config.bithumb.yaml}"   # 처음 설치할 때 config.yaml 로 복사할 설정
DIR="$HOME/rsi-watch"
APP="$DIR/autotrader"
SERVICE="btc-bot"

LIVE_FLAG=""
if [ "${1:-}" = "--live" ]; then
  LIVE_FLAG="--live"
fi

echo "== 1/4 필요한 프로그램 설치"
sudo apt-get update -y -q
sudo apt-get install -y -q python3 python3-venv git

echo "== 2/4 코드 받기 ($BRANCH)"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" fetch -q origin "$BRANCH"
  git -C "$DIR" checkout -q "$BRANCH"
  git -C "$DIR" reset -q --hard "origin/$BRANCH"
else
  git clone -q -b "$BRANCH" "$REPO" "$DIR"
fi

echo "== 3/4 파이썬 패키지 설치"
python3 -m venv "$APP/.venv"
"$APP/.venv/bin/pip" install -q --upgrade pip
"$APP/.venv/bin/pip" install -q -r "$APP/requirements.txt"
if [ ! -f "$APP/.env" ]; then
  cp "$APP/.env.example" "$APP/.env"
  chmod 600 "$APP/.env"
fi
# 내 설정은 config.yaml (git 이 관리하지 않아 업데이트해도 그대로 유지됨)
if [ ! -f "$APP/config.yaml" ]; then
  cp "$APP/$TEMPLATE" "$APP/config.yaml"
fi

echo "== 4/4 서비스 등록 ($SERVICE)"
sudo tee "/etc/systemd/system/$SERVICE.service" > /dev/null <<UNIT
[Unit]
Description=BTC trend bot + channel signal alerts
After=network-online.target
Wants=network-online.target

[Service]
User=$USER
WorkingDirectory=$APP
ExecStart=$APP/.venv/bin/python -m bot run -c config.yaml $LIVE_FLAG
Restart=always
RestartSec=30
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
UNIT
sudo systemctl daemon-reload
sudo systemctl enable -q "$SERVICE"

if grep -q "^EXCHANGE_API_KEY=.\+" "$APP/.env" || [ -z "$LIVE_FLAG" ]; then
  sudo systemctl restart "$SERVICE"
  echo
  echo "봇을 시작했습니다 (${LIVE_FLAG:-모의매매})."
else
  echo
  echo "실거래는 API 키가 필요합니다. 아래 순서대로 키를 넣고 시작하세요."
fi
cat <<EOF

다음에 할 일
  - 키·텔레그램 넣기:   nano $APP/.env      (저장: Ctrl+O, Enter / 나가기: Ctrl+X)
  - 설정 바꾸기:        nano $APP/config.yaml
  - 넣은 뒤 재시작:     sudo systemctl restart $SERVICE
  - 로그 보기:          journalctl -u $SERVICE -f      (나가기: Ctrl+C)
  - 멈추기 / 시작:      sudo systemctl stop $SERVICE / sudo systemctl start $SERVICE
  - 이 서버의 IP:       $(curl -s -m 5 ifconfig.me || echo '확인 실패') → 빗썸 API 허용 IP 에 등록
EOF
if [ -n "$LIVE_FLAG" ] && ! grep -q "^  enabled: true" "$APP/config.yaml"; then
  echo
  echo "⚠️ 실거래하려면 $APP/config.yaml 의 live: enabled: false 를 true 로 바꾼 뒤 재시작해야 합니다."
fi
