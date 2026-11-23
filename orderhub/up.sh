#!/usr/bin/env bash
# 짧은 이름: 서버에서 'sudo bash up.sh' 로 자동 업데이트 켜기 + 지금 새 버전 설치
exec bash "$(dirname "$0")/scripts/enable-auto-update.sh" "$@"
