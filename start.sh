#!/usr/bin/env bash
# 一键启动：watch 常驻后台 + Web 服务前台运行
#   ./start.sh          # watch 用 daemon.sh 常驻，服务占用当前终端
#   ./start.sh --launchd# watch 交给 launchd（开机自启 / 崩溃自拉起）
set -uo pipefail
cd "$(dirname "$0")" || exit 1

if [[ "${1:-}" == "--launchd" ]]; then
  bash scripts/install-launchd.sh install
else
  bash scripts/daemon.sh start
fi

exec npm start
