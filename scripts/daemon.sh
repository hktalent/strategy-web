#!/usr/bin/env bash
# 常驻守护：把 npm run watch 放到后台跑，并保证只跑一个实例
#
#   ./scripts/daemon.sh start     启动（幂等，已在跑就提示）
#   ./scripts/daemon.sh stop      优雅停止（先 drain 队列里的变化再退出）
#   ./scripts/daemon.sh restart
#   ./scripts/daemon.sh status    运行状态 + 最近日志 + 批次统计
#   ./scripts/daemon.sh logs      实时跟踪日志
#
# 日志：logs/watch.log（>20MB 自动滚动为 watch.log.1）
# 想开机自启 / 崩溃自动拉起：./scripts/install-launchd.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT/run"
LOG_DIR="$ROOT/logs"
PID_FILE="$RUN_DIR/watch.pid"
LOCK_FILE="$RUN_DIR/watch.lock"
LOG_FILE="$LOG_DIR/watch.log"
ERR_FILE="$LOG_DIR/watch.err.log"
MAX_LOG_BYTES=$((20 * 1024 * 1024))
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

mkdir -p "$RUN_DIR" "$LOG_DIR"

stamp() { date '+%Y-%m-%d %H:%M:%S'; }

current_pid() {
  # 优先 pid 文件，其次兜底扫进程（兼容老版本直接 npm run watch 起的进程）
  if [[ -f "$PID_FILE" ]]; then
    local p; p="$(cat "$PID_FILE" 2>/dev/null | tr -d '[:space:]')"
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then echo "$p"; return 0; fi
  fi
  local legacy; legacy="$(pgrep -f "node .*scripts/watch\.js" 2>/dev/null | head -1 || true)"
  [[ -n "$legacy" ]] && echo "$legacy"
}

rotate_log() {
  if [[ -f "$LOG_FILE" ]]; then
    local size; size=$(wc -c < "$LOG_FILE" | tr -d '[:space:]')
    if [[ "${size:-0}" -gt "$MAX_LOG_BYTES" ]]; then
      mv "$LOG_FILE" "$LOG_FILE.1"
      echo "[$(stamp)] 日志已滚动" >> "$LOG_FILE"
    fi
  fi
}

start() {
  local pid; pid="$(current_pid)"
  if [[ -n "$pid" ]]; then
    echo "watch 已在运行 (pid=$pid)，无需重复启动"
    return 0
  fi
  if [[ -z "$NODE_BIN" ]]; then echo "找不到 node，请先安装 Node.js"; exit 1; fi
  rotate_log
  rm -f "$LOCK_FILE" "$PID_FILE"
  cd "$ROOT" || exit 1
  echo "[$(stamp)] daemon start" >> "$LOG_FILE"
  nohup "$NODE_BIN" scripts/watch.js >> "$LOG_FILE" 2>> "$ERR_FILE" &
  local newpid=$!
  disown "$newpid" 2>/dev/null || true
  echo "$newpid" > "$PID_FILE"
  sleep 2
  if kill -0 "$newpid" 2>/dev/null; then
    echo "watch 已启动 (pid=$newpid)"
    echo "日志：$LOG_FILE"
  else
    echo "启动失败，请看：$ERR_FILE"
    tail -20 "$ERR_FILE" 2>/dev/null
    exit 1
  fi
}

stop() {
  local pid; pid="$(current_pid)"
  if [[ -z "$pid" ]]; then
    echo "watch 未在运行"
    rm -f "$LOCK_FILE" "$PID_FILE"
    return 0
  fi
  echo "正在优雅停止 pid=$pid ..."
  kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 60); do
    kill -0 "$pid" 2>/dev/null || { echo "已停止"; rm -f "$LOCK_FILE" "$PID_FILE"; return 0; }
    sleep 0.25
  done
  echo "15 秒内未退出，强制结束"
  kill -9 "$pid" 2>/dev/null
  rm -f "$LOCK_FILE" "$PID_FILE"
}

status() {
  local pid; pid="$(current_pid)"
  if [[ -n "$pid" ]]; then
    echo "状态：运行中 (pid=$pid)"
    ps -o pid,ppid,etime,%cpu,%mem,rss,command -p "$pid" 2>/dev/null
  else
    echo "状态：未运行"
  fi
  echo
  if [[ -f "$ROOT/data/.watch-state.json" ]]; then
    node -e '
      const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));
      const m=s.stats||{};
      console.log(`累计批次 ${m.batches||0} | 新增 ${m.added||0} | 更新 ${m.updated||0} | 跳过 ${m.skipped||0}`);
      console.log(`上次写入 ${m.lastFlushAt||"-"} (${m.lastFlushMs||0}ms) | 总量 ${m.totalStrategies||"-"}`);
    ' "$ROOT/data/.watch-state.json" 2>/dev/null
  fi
  echo
  echo "最近日志："
  tail -8 "$LOG_FILE" 2>/dev/null || echo "(暂无)"
}

case "${1:-}" in
  start)   start ;;
  stop)    stop ;;
  restart) stop; start ;;
  status)  status ;;
  logs)    exec tail -f "$LOG_FILE" ;;
  *) echo "用法：$0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
