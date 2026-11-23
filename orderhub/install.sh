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

# 0) 서버가 막 켜졌을 때 우분투 자동 업데이트가 끝날 때까지 기다리기 (apt 잠금)
if command -v apt-get >/dev/null 2>&1; then
  echo 'DPkg::Lock::Timeout "600";' > /etc/apt/apt.conf.d/99orderhub-lock-timeout
  for i in $(seq 1 120); do
    if command -v fuser >/dev/null 2>&1 && fuser /var/lib/dpkg/lock-frontend /var/lib/dpkg/lock /var/lib/apt/lists/lock >/dev/null 2>&1; then
      [ "$i" = 1 ] && say "서버 자동 업데이트가 끝나길 기다리는 중…"
      sleep 5
    else
      break
    fi
  done
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
  # DOMAIN 환경변수로 주면 묻지 않고 진행 (서버 초기화 스크립트에서 자동 설치할 때)
  DOMAIN_INPUT="${DOMAIN:-}"
  if [ -z "${DOMAIN_INPUT}" ]; then
    echo
    echo "이 서버의 공인 IP: ${PUBLIC_IP:-확인 실패}"
    echo "도메인이 이 IP를 가리키도록 먼저 설정해두세요. (무료: duckdns.org 에서 이름 만들고 IP 입력)"
    read -r -p "접속할 도메인을 입력하세요 (예: myshop.duckdns.org): " DOMAIN_INPUT
  fi
  DOMAIN_INPUT="$(echo "${DOMAIN_INPUT}" | tr -d '[:space:]' | sed -E 's#^https?://##; s#/.*$##')"
  if ! echo "${DOMAIN_INPUT}" | grep -Eq '^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$'; then
    echo "도메인 형식이 올바르지 않습니다: '${DOMAIN_INPUT}' (예: myshop.duckdns.org)"
    exit 1
  fi
  sed -i "s#^DOMAIN=.*#DOMAIN=${DOMAIN_INPUT}#" .env
  sed -i "s#^PUBLIC_URL=.*#PUBLIC_URL=https://${DOMAIN_INPUT}#" .env
  CURRENT_DOMAIN="${DOMAIN_INPUT}"
fi

# 3) 메모리가 작은 무료 서버(1GB)에서 설치 중 멈추지 않도록 스왑 2GB 추가
TOTAL_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)"
if [ "${TOTAL_MB:-0}" -lt 1800 ] && [ -z "$(swapon --show 2>/dev/null)" ]; then
  say "메모리가 ${TOTAL_MB}MB 라서 스왑 2GB를 추가합니다"
  fallocate -l 2G /swapfile 2>/dev/null || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# 4) 방화벽 80/443 열기 (오라클 클라우드 우분투는 iptables 가 기본으로 막고 있음)
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

# 5) 실행
say "오더허브 빌드 및 실행 (처음엔 2~3분 걸립니다)"
docker compose up -d --build

sleep 5
docker compose ps

# 6) 자동 업데이트: GitHub 에 새 버전이 올라오면 5분 안에 자동 적용 (끄려면 AUTO_UPDATE=0 으로 설치)
AUTO_MSG="꺼짐 (켜기: sudo bash scripts/enable-auto-update.sh)"
if [ "${AUTO_UPDATE:-1}" != "0" ] && command -v systemctl >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  if ORDERHUB_NO_REBUILD=1 bash scripts/enable-auto-update.sh >/dev/null 2>&1; then
    AUTO_MSG="켜짐 (새 버전이 올라오면 5분 안에 자동 적용)"
  fi
fi

cat <<EOF

✅ 설치 완료!

  접속 주소 : https://${CURRENT_DOMAIN}
  서버 IP   : ${PUBLIC_IP:-확인 실패}   ← 연결할 마켓들의 API 설정에 이 IP를 추가하세요

  · 처음 접속하면 관리자 비밀번호를 정합니다.
  · HTTPS 인증서 발급에 1~2분 걸릴 수 있습니다. 접속이 안 되면 잠시 후 다시 시도하세요.
  · AWS 라이트세일이라면 인스턴스 > 네트워킹 > IPv4 방화벽에 HTTPS(443) 규칙이 있어야 합니다.
  · 오라클 클라우드라면 콘솔 > 네트워킹 > VCN > 보안 목록에서 80, 443 포트(수신)도 열어야 합니다.

  자동 업데이트: ${AUTO_MSG}
  로그 보기   : cd $(pwd) && docker compose logs -f app
  수동 업데이트: git pull && docker compose up -d --build
EOF
