#!/usr/bin/env bash
# 오더허브 - 오라클 클라우드 무료 서버 자동 설치
# 오라클 콘솔의 Cloud Shell 에 아래 한 줄을 붙여넣어 실행합니다:
#   bash <(curl -fsSL https://raw.githubusercontent.com/yongki6696/rsi-watch/refs/heads/claude/wonderful-lamport-2cedpj/orderhub/oracle-setup.sh)
#
# 하는 일: 네트워크(VCN·서브넷·인터넷게이트웨이) 만들기 → 22/80/443 포트 열기 →
#          Always Free 서버(VM.Standard.E2.1.Micro, Ubuntu 22.04) 만들기 → 오더허브 자동 설치 →
#          DuckDNS 주소 연결 → 접속될 때까지 기다렸다가 주소 안내
# 다시 실행해도 이미 만든 것은 그대로 다시 사용합니다.
set -euo pipefail

BRANCH="claude/wonderful-lamport-2cedpj"
REPO="https://github.com/yongki6696/rsi-watch.git"
SHAPE="VM.Standard.E2.1.Micro"
NAME="orderhub"

say() { printf '\n\033[1;34m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
die() {
  printf '\n\033[1;31m✖ %s\033[0m\n' "$*"
  exit 1
}

ERRF="$(mktemp)"
trap 'rm -f "$ERRF"' EXIT

# oci 명령 실행: 결과(stdout)만 돌려주고, 실패하면 오류를 보여주고 멈춤
oq() {
  if ! "$@" 2>"$ERRF"; then
    printf '\n\033[1;31m오라클 명령 실패:\033[0m %s\n' "$(grep -v '^Action completed' "$ERRF" | tail -n 8)" >&2
    return 1
  fi
}

command -v oci >/dev/null 2>&1 || die "오라클 콘솔의 Cloud Shell 안에서 실행해주세요."

cat <<'EOF'

  ┌──────────────────────────────────────────────┐
  │   오더허브 - 오라클 무료 서버 자동 설치        │
  └──────────────────────────────────────────────┘
  준비물: DuckDNS 에서 만든 주소 이름 (예: myshop)
         DuckDNS 화면 위쪽의 token (자동으로 IP를 연결하려면)
EOF

# ---------- 1. 입력 ----------
read -r -p $'\nDuckDNS 주소 이름 (예: myshop 또는 myshop.duckdns.org): ' SUB
SUB="$(echo "$SUB" | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]' | sed -E 's#^https?://##; s#/.*$##; s#\.duckdns\.org$##')"
[[ "$SUB" =~ ^[a-z0-9-]+$ ]] || die "주소 이름은 영문 소문자·숫자·- 만 쓸 수 있습니다: '$SUB'"
DOMAIN="${SUB}.duckdns.org"

read -r -s -p $'DuckDNS token (화면 위쪽 token 값, 건너뛰려면 그냥 Enter): ' DUCK_TOKEN
echo
DUCK_TOKEN="$(echo "$DUCK_TOKEN" | tr -d '[:space:]')"

C="${OCI_TENANCY:-}"
if [ -z "$C" ]; then
  C="$(awk -F'=' '/^[[:space:]]*tenancy[[:space:]]*=/{gsub(/[[:space:]]/,"",$2); print $2; exit}' "${OCI_CLI_CONFIG_FILE:-$HOME/.oci/config}" /etc/oci/config 2>/dev/null || true)"
fi
if [[ "$C" != ocid1.tenancy.* ]]; then
  read -r -p '테넌시 OCID 를 붙여넣어 주세요 (오른쪽 위 프로필 → Tenancy → OCID 복사): ' C
  [[ "$C" == ocid1.tenancy.* ]] || die "테넌시 OCID 형식이 아닙니다."
fi

echo
echo "  접속 주소   : https://${DOMAIN}"
echo "  지역(리전)  : ${OCI_REGION:-Cloud Shell 기본 리전}"
echo "  서버        : ${SHAPE} (Always Free) / Ubuntu 22.04"
read -r -p $'\n이대로 만들까요? [Y/n] ' YES
[[ -z "$YES" || "$YES" =~ ^[Yy] ]] || die "취소했습니다."

# ---------- 2. 접속 키 ----------
say "접속 키 준비"
if [ ! -f "$HOME/.ssh/orderhub" ]; then
  mkdir -p "$HOME/.ssh"
  ssh-keygen -q -t rsa -b 4096 -N "" -f "$HOME/.ssh/orderhub"
fi
ok "~/.ssh/orderhub"

# ---------- 3. 네트워크 ----------
say "네트워크 만들기 (1~2분)"
AD="$(oq oci iam availability-domain list -c "$C" --query 'data[0].name' --raw-output)"
[ -n "$AD" ] || die "가용성 도메인을 찾지 못했습니다. 계정 준비가 끝났는지 확인해주세요."

VCN="$(oq oci network vcn list -c "$C" --display-name "${NAME}-vcn" --lifecycle-state AVAILABLE --query 'data[0].id' --raw-output)"
if [ -z "$VCN" ]; then
  VCN="$(oq oci network vcn create -c "$C" --cidr-blocks '["10.0.0.0/16"]' --display-name "${NAME}-vcn" --dns-label "$NAME" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
fi
ok "가상 네트워크"

IGW="$(oq oci network internet-gateway list -c "$C" --vcn-id "$VCN" --query 'data[0].id' --raw-output)"
if [ -z "$IGW" ]; then
  IGW="$(oq oci network internet-gateway create -c "$C" --vcn-id "$VCN" --is-enabled true --display-name "${NAME}-igw" \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
fi
ok "인터넷 게이트웨이"

RT="$(oq oci network vcn get --vcn-id "$VCN" --query 'data."default-route-table-id"' --raw-output)"
oq oci network route-table update --rt-id "$RT" --force --wait-for-state AVAILABLE \
  --route-rules "[{\"destination\":\"0.0.0.0/0\",\"destinationType\":\"CIDR_BLOCK\",\"networkEntityId\":\"${IGW}\"}]" >/dev/null
ok "인터넷 연결 경로"

SL="$(oq oci network vcn get --vcn-id "$VCN" --query 'data."default-security-list-id"' --raw-output)"
oq oci network security-list update --security-list-id "$SL" --force \
  --ingress-security-rules '[
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":22,"max":22}}},
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":80,"max":80}}},
    {"source":"0.0.0.0/0","protocol":"6","isStateless":false,"tcpOptions":{"destinationPortRange":{"min":443,"max":443}}},
    {"source":"0.0.0.0/0","protocol":"1","isStateless":false,"icmpOptions":{"type":3,"code":4}},
    {"source":"10.0.0.0/16","protocol":"1","isStateless":false,"icmpOptions":{"type":3}}]' \
  --egress-security-rules '[{"destination":"0.0.0.0/0","protocol":"all","isStateless":false}]' >/dev/null
ok "포트 22·80·443 열기"

SUBNET="$(oq oci network subnet list -c "$C" --vcn-id "$VCN" --display-name "${NAME}-subnet" --query 'data[0].id' --raw-output)"
if [ -z "$SUBNET" ]; then
  SUBNET="$(oq oci network subnet create -c "$C" --vcn-id "$VCN" --cidr-block 10.0.0.0/24 --display-name "${NAME}-subnet" \
    --dns-label web --route-table-id "$RT" --security-list-ids "[\"${SL}\"]" --prohibit-public-ip-on-vnic false \
    --wait-for-state AVAILABLE --query 'data.id' --raw-output)"
fi
ok "공개 서브넷"

# ---------- 4. 서버 ----------
say "무료 서버 만들기 (2~5분)"
INST="$(oq oci compute instance list -c "$C" --display-name "$NAME" --lifecycle-state RUNNING --query 'data[0].id' --raw-output)"
if [ -z "$INST" ]; then
  STOPPED="$(oq oci compute instance list -c "$C" --display-name "$NAME" --lifecycle-state STOPPED --query 'data[0].id' --raw-output)"
  if [ -n "$STOPPED" ]; then
    oq oci compute instance action --instance-id "$STOPPED" --action START --wait-for-state RUNNING >/dev/null
    INST="$STOPPED"
    ok "멈춰 있던 서버를 다시 켰습니다"
  fi
fi
if [ -z "$INST" ]; then
  IMG=""
  for ver in "22.04" "24.04"; do
    IMG="$(oq oci compute image list -c "$C" --operating-system "Canonical Ubuntu" --operating-system-version "$ver" \
      --shape "$SHAPE" --sort-by TIMECREATED --sort-order DESC --limit 1 --query 'data[0].id' --raw-output)"
    [ -n "$IMG" ] && break
  done
  [ -n "$IMG" ] || die "Ubuntu 이미지를 찾지 못했습니다."

  UD="$(mktemp)"
  cat >"$UD" <<EOF
#!/bin/bash
cd /opt
git clone -b ${BRANCH} ${REPO}
cd rsi-watch/orderhub
DOMAIN=${DOMAIN} bash install.sh > /var/log/orderhub-install.log 2>&1
EOF
  if ! INST="$(oq oci compute instance launch -c "$C" --availability-domain "$AD" --shape "$SHAPE" --image-id "$IMG" \
    --subnet-id "$SUBNET" --assign-public-ip true --display-name "$NAME" \
    --ssh-authorized-keys-file "$HOME/.ssh/orderhub.pub" --user-data-file "$UD" \
    --wait-for-state RUNNING --max-wait-seconds 1200 --query 'data.id' --raw-output)"; then
    rm -f "$UD"
    if grep -qi "capacity" "$ERRF"; then
      die "지금 오라클에 무료 서버 자리가 부족합니다(Out of capacity). 10~30분 뒤에 같은 한 줄을 다시 실행해주세요. 이미 만든 네트워크는 그대로 다시 씁니다."
    fi
    if grep -qi "limit" "$ERRF"; then
      die "무료 서버 한도에 걸렸습니다. 콘솔 → 컴퓨트 → 인스턴스에서 안 쓰는 무료 서버가 있는지 확인해주세요."
    fi
    die "서버를 만들지 못했습니다. 위 오류 문구를 그대로 알려주세요."
  fi
  rm -f "$UD"
fi
ok "서버 실행 중"

IP="$(oq oci compute instance list-vnics --instance-id "$INST" --query 'data[0]."public-ip"' --raw-output)"
[ -n "$IP" ] || die "서버의 공용 IP 를 찾지 못했습니다."
ok "서버 공용 IP: $IP"

# ---------- 5. DuckDNS ----------
say "주소 연결 (DuckDNS)"
if [ -n "$DUCK_TOKEN" ]; then
  R="$(curl -fsS -m 15 "https://www.duckdns.org/update?domains=${SUB}&token=${DUCK_TOKEN}&ip=${IP}" || true)"
  if [ "$R" = "OK" ]; then
    ok "${DOMAIN} → ${IP} 연결 완료"
  else
    echo "  ⚠ DuckDNS 자동 연결 실패. duckdns.org 에서 '${SUB}' 의 current ip 칸에 ${IP} 를 직접 넣고 [update ip] 를 눌러주세요."
  fi
else
  echo "  👉 duckdns.org 에서 '${SUB}' 의 current ip 칸에 ${IP} 를 넣고 [update ip] 를 눌러주세요."
fi

# ---------- 6. 설치 완료 기다리기 ----------
say "오더허브 설치를 기다리는 중 (보통 10~15분, 최대 30분)"
echo "  서버가 혼자 설치 중입니다. 이 창을 닫아도 설치는 계속됩니다."
for i in $(seq 1 60); do
  if curl -fsS -m 8 "https://${DOMAIN}/healthz" >/dev/null 2>&1; then
    cat <<EOF

  ✅ 완료! 오더허브가 켜졌습니다.

  📱 아이폰 Safari 에서 열기 : https://${DOMAIN}
     → 비밀번호 정하기 → 공유 버튼 → [홈 화면에 추가] → 홈 화면 앱에서 [알림] → [이 기기에서 알림 받기]

  📌 마켓 API 설정에 추가할 서버 IP : ${IP}
     (스마트스토어·쿠팡 등 각 마켓 API 설정에 '추가'. 샵모아 IP 는 지우지 마세요)

EOF
    exit 0
  fi
  printf '  … %d분 경과\r' "$((i / 2))"
  sleep 30
done

cat <<EOF

  ⏳ 30분이 지나도 아직 접속이 안 됩니다. 아래 명령으로 서버 설치 기록을 확인해서 마지막 줄을 알려주세요:

  ssh -i ~/.ssh/orderhub ubuntu@${IP} "sudo tail -n 30 /var/log/orderhub-install.log"

  (DuckDNS 의 IP 가 ${IP} 로 되어 있는지도 확인해주세요)
EOF
