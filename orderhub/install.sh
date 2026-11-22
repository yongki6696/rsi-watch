#!/usr/bin/env bash
# 오더허브 설치 스크립트 (Ubuntu 서버용: 오라클 클라우드 무료 서버, AWS 라이트세일, 국내 VPS 등)
# 사용법:  cd orderhub && sudo bash install.sh
set -euo pipefail

cd "$(dirname "$0")"

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m! %s\033[0m\n' "$*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "관리자 권한이 필요합니다. 'sudo bash install.sh' 로 다시 실행해주세요."
  exit 1
fi

# 1) Docker 설치
if ! command -v docker >/dev/null 2>&1; then
  say "Docker 설치 중… (1~2분)"
  curl -fsSL https://get.docker.com | sh
fi
if ! docker compose version >/dev/null 2>&1; then
  say "docker compose 플러그인 설치 중…"
  apt-get update -y && apt-get install -y docker-compose-plugin
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# 2) 도메인 설정
PUBLIC_IP="$(curl -fsS https://api.ipify.org || true)"
if [ ! -f .env ]; then
  cp .env.example .env
fi
CURRENT_DOMAIN="$(grep -E '^DOMAIN=' .env | cut -d= -f2- || true)"
if [ -z "${CURRENT_DOMAIN}" ]; then
  echo
  echo "이 서버의 공인 IP: ${PUBLIC_IP:-확인 실패}"
  echo "도메인이 이 IP를 가리키도록 먼저 설정해두세요. (무료: duckdns.org 에서 이름 만들고 IP 입력)"
  read -r -p "접속할 도메인을 입력하세요 (예: myshop.duckdns.org): " DOMAIN_INPUT
  DOMAIN_INPUT="$(echo "${DOMAIN_INPUT}" | sed -E 's#^https?://##; s#/.*$##')"
  if [ -z "${DOMAIN_INPUT}" ]; then
    echo "도메인이 필요합니다. 다시 실행해주세요."
    exit 1
  fi
  sed -i "s#^DOMAIN=.*#DOMAIN=${DOMAIN_INPUT}#" .env
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://${DOMAIN_INPUT}#" .env
  CURRENT_DOMAIN="${DOMAIN_INPUT}"
fi

# 3) 방화벽 80/443 열기 (오라클 클라우드 우분투는 iptables 가 기본으로 막고 있음)
say "방화벽에서 80, 443 포트 허용"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
fi
if command -v iptables >/dev/null 2>&1; then
  for p in 80 443; do
    iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport "$p" -j ACCEPT
  done
  if command -v netfilter-persistent >/dev/null 2>&1; then netfilter-persistent save >/dev/null 2>&1 || true; fi
fi

# 4) 실행
say "오더허브 빌드 및 실행 (처음엔 2~3분 걸립니다)"
docker compose up -d --build

sleep 5
docker compose ps

cat <<EOF

✅ 설치 완료!

  접속 주소 : https://${CURRENT_DOMAIN}
  서버 IP   : ${PUBLIC_IP:-확인 실패}   ← 스마트스토어/쿠팡/11번가 API 설정에 이 IP를 등록하세요

  · 처음 접속하면 관리자 비밀번호를 정합니다.
  · HTTPS 인증서 발급에 1~2분 걸릴 수 있습니다. 접속이 안 되면 잠시 후 다시 시도하세요.
  · AWS 라이트세일이라면 인스턴스 > 네트워킹 > IPv4 방화벽에 HTTPS(443) 규칙이 있어야 합니다.
  · 오라클 클라우드라면 콘솔 > 네트워킹 > VCN > 보안 목록에서 80, 443 포트(수신)도 열어야 합니다.

  로그 보기   : cd $(pwd) && docker compose logs -f app
  업데이트    : git pull && docker compose up -d --build
EOF
