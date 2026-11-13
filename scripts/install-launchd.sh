#!/usr/bin/env bash
# 用 launchd 把 watch 变成"始终后台运行"的系统级常驻服务：
#   · 开机/登录自动启动（RunAtLoad）
#   · 崩溃自动拉起（KeepAlive，正常退出不会被反复拉起，避免与手动启动打架）
#   · 日志落在 logs/watch.log / logs/watch.err.log
#
#   ./scripts/install-launchd.sh            安装并启动
#   ./scripts/install-launchd.sh status     查看 launchd 状态
#   ./scripts/install-launchd.sh uninstall  卸载（不影响 data 目录）
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.strategy-web.watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
# 优先用系统级 node（Homebrew /usr/local/bin），避免依赖某个沙箱运行时
pick_node() {
  if [[ -n "${NODE_BIN:-}" ]]; then echo "$NODE_BIN"; return; fi
  local c
  for c in /usr/local/bin/node /opt/homebrew/bin/node /usr/bin/node; do
    [[ -x "$c" ]] && { echo "$c"; return; }
  done
  command -v node || true
}
NODE_BIN="$(pick_node)"
LOG_DIR="$ROOT/logs"
UID_NUM="$(id -u)"

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

install_plist() {
  if [[ -z "$NODE_BIN" ]]; then echo "找不到 node"; exit 1; fi
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/scripts/watch.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$LOG_DIR/watch.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/watch.err.log</string>
</dict>
</plist>
EOF
  chmod 644 "$PLIST"
  if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
    echo "plist 校验失败："
    plutil -lint "$PLIST"
    exit 1
  fi
  echo "已写入 $PLIST"
}

unload_old() {
  launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
}

case "${1:-install}" in
  install)
    # 避免和手动/守护进程起的实例打架：先停掉 daemon.sh 那个
    [[ -x "$ROOT/scripts/daemon.sh" ]] && "$ROOT/scripts/daemon.sh" stop >/dev/null 2>&1
    install_plist
    unload_old
    if launchctl bootstrap "gui/$UID_NUM" "$PLIST" 2>/dev/null; then
      echo "launchd 已加载"
    else
      launchctl load -w "$PLIST" && echo "launchd 已加载 (legacy)"
    fi
    launchctl kickstart -k "gui/$UID_NUM/$LABEL" 2>/dev/null || true
    sleep 2
    echo
    launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -E "state|pid|last exit" | head -5
    echo "日志：tail -f $LOG_DIR/watch.log"
    ;;
  uninstall)
    unload_old
    rm -f "$PLIST"
    echo "已卸载 launchd 服务（data/ 数据未改动）"
    ;;
  status)
    launchctl print "gui/$UID_NUM/$LABEL" 2>/dev/null | grep -E "state|pid|last exit|path" | head -8 || echo "未安装"
    ;;
  *)
    echo "用法：$0 {install|uninstall|status}"; exit 1 ;;
esac
