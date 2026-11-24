#!/usr/bin/env bash
# 오더허브 11번가 국내 중계 서버 설치 - 한국 리전의 Ubuntu 서버(예: AWS 라이트세일 서울)에서 실행
# 11번가는 해외 IP 접속을 막기 때문에, 해외(예: 오라클 일본)에 있는 오더허브 서버의 11번가 접속만 이 서버를 거쳐 나가게 합니다.
#  - 오더허브 서버 IP 에서 온 요청만 받고 (그 외에는 거부)
#  - api.11st.co.kr 로만 연결해줍니다 (다른 사이트는 거부)
#  - 중계만 하므로 주문 정보나 API 키를 저장하지 않습니다 (11번가와의 통신은 처음부터 끝까지 암호화된 채로 지나감)
# 사용법 (서버 시작 스크립트 또는 SSH 에서):
#   curl -fsSL https://raw.githubusercontent.com/yongki6696/rsi-watch/claude/wonderful-lamport-2cedpj/orderhub/relay/install-relay.sh | sudo ORDERHUB_IP=오더허브서버IP bash
set -euo pipefail

ORDERHUB_IP="${ORDERHUB_IP:-${1:-}}"
PORT="${RELAY_PORT:-80}"
CONF="${RELAY_CONF:-/etc/tinyproxy/tinyproxy.conf}"
ALLOW_FILE="$(dirname "$CONF")/orderhub-allow"

if ! echo "$ORDERHUB_IP" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'; then
  echo "오더허브 서버 IP를 지정해주세요. 예) curl ... | sudo ORDERHUB_IP=64.110.103.233 bash"
  exit 1
fi
if [ "$(id -u)" -ne 0 ]; then
  echo "관리자 권한이 필요합니다. 'sudo' 를 붙여 실행해주세요."
  exit 1
fi

echo "▶ 중계 프로그램(tinyproxy) 설치 중…"
export DEBIAN_FRONTEND=noninteractive
if ! command -v tinyproxy >/dev/null 2>&1; then
  apt-get -o DPkg::Lock::Timeout=600 update -y >/dev/null
  apt-get -o DPkg::Lock::Timeout=600 install -y tinyproxy >/dev/null
fi

echo "▶ 설정: 오더허브(${ORDERHUB_IP}) → 11번가만 중계, 포트 ${PORT}"
[ -f "$CONF.orig" ] || cp "$CONF" "$CONF.orig"
# 기본 설정에서 우리가 정하는 항목은 지우고 아래에 다시 적음 (여러 번 실행해도 같은 결과)
sed -E -i '/^[[:space:]]*(Port|Listen|Allow|Deny|ConnectPort|Filter|FilterDefaultDeny|FilterURLs|FilterExtended|FilterType|FilterCaseSensitive|DisableViaHeader|MaxClients|BasicAuth|Timeout|ViaProxyName|LogLevel|XTinyproxy)[[:space:]]/d; /^# --- 오더허브/d' "$CONF"
cat >>"$CONF" <<EOF
# --- 오더허브 11번가 중계 설정 (install-relay.sh) ---
Port ${PORT}
Timeout 120
LogLevel Warning
MaxClients 50
Allow ${ORDERHUB_IP}
ConnectPort 443
ConnectPort 80
Filter "${ALLOW_FILE}"
FilterDefaultDeny Yes
DisableViaHeader Yes
EOF
printf '%s\n' '^api\.11st\.co\.kr$' >"$ALLOW_FILE"

# 방화벽: 오더허브 서버에서 오는 연결만 허용 (ufw 를 쓰는 서버, iptables 로 막힌 서버 대비)
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
  ufw allow from "$ORDERHUB_IP" to any port "$PORT" proto tcp >/dev/null
fi
if command -v iptables >/dev/null 2>&1; then
  iptables -C INPUT -p tcp -s "$ORDERHUB_IP" --dport "$PORT" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp -s "$ORDERHUB_IP" --dport "$PORT" -j ACCEPT 2>/dev/null || true
fi

systemctl enable tinyproxy >/dev/null 2>&1 || true
systemctl restart tinyproxy

PUBLIC_IP="$(curl -fsS --max-time 10 https://api.ipify.org 2>/dev/null || true)"
cat <<EOF

✅ 11번가 국내 중계 서버 준비 완료

  이 서버 IP: ${PUBLIC_IP:-확인 실패} (고정 IP를 붙였다면 그 IP를 쓰세요)

  ① 11번가 OPEN API CENTER → API 관리 → IP 직접 입력 세 칸 끝에 ;이 서버 IP 추가 → [수정하기]
  ② 오더허브 → 스토어 → 11번가 → [키 변경] → '국내 중계 서버' 칸에 이 서버 IP 입력 → 저장 → [연결 테스트]

  이 서버는 오더허브 서버(${ORDERHUB_IP})의 11번가 접속만 중계합니다.
EOF
