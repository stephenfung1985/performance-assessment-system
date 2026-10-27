#!/bin/bash
#============================================================
# 钻井经营考核系统 · macOS 启动器
# 双击本文件即可后台启动服务并自动打开浏览器。
# 停止请双击「停止经营考核系统.command」。
# （Windows 下请用 启动经营考核系统.vbs）
#============================================================
set -u

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$BASE_DIR/server"
LOG_DIR="$BASE_DIR/logs"

# ---- 读取端口（默认 4000，以 server/.env 中 PORT 为准）----
PORT=4000
if [ -f "$DIR/.env" ]; then
  ENV_PORT="$(grep -E '^PORT=' "$DIR/.env" | tail -1 | cut -d= -f2 | tr -d ' \r')"
  [ -n "${ENV_PORT:-}" ] && PORT="$ENV_PORT"
fi

# ---- 0. 检查 Node.js ----
if ! command -v node >/dev/null 2>&1; then
  osascript -e 'display alert "经营考核系统" message "未找到 Node.js，请先安装 Node.js 18 或更高版本。\n\n下载地址：https://nodejs.org/zh-cn/download" as critical' >/dev/null 2>&1
  echo "未找到 Node.js，请先安装：https://nodejs.org/zh-cn/download"
  exit 1
fi

# ---- 1. 已在运行？直接打开浏览器 ----
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "服务已在端口 $PORT 上运行，正在打开浏览器..."
  open "http://localhost:$PORT"
  exit 0
fi

# ---- 2. 后台启动服务（日志 -> logs/server.log）----
mkdir -p "$LOG_DIR"
cd "$DIR" || exit 1
if [ ! -d node_modules ]; then
  echo "首次运行，正在安装依赖（npm install）..."
  npm install >>"$LOG_DIR/server.log" 2>&1 || {
    echo "依赖安装失败，详情见 logs/server.log"
    exit 1
  }
fi
# 装了开机自启（安装开机自启.command）就交给 launchd 启动，这样崩溃后仍会自动拉起；没装才直接后台运行
LABEL="com.kaohe.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
if [ -f "$PLIST" ]; then
  echo "通过开机自启服务（launchd）启动..."
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl kickstart "$DOMAIN/$LABEL"          # 已加载：没在跑就拉起
  else
    launchctl bootstrap "$DOMAIN" "$PLIST"        # 被「停止」卸载过：重新加载，RunAtLoad 会立即启动
  fi
else
  nohup node server.js >>"$LOG_DIR/server.log" 2>&1 &
fi

# ---- 3. 等待就绪（最多 15 秒），然后打开浏览器 ----
OK=0
for _ in $(seq 1 15); do
  sleep 1
  if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then
    OK=1
    break
  fi
done

open "http://localhost:$PORT"
if [ "$OK" -ne 1 ]; then
  echo "服务已启动，但健康检查超时，请查看 logs/server.log。"
  osascript -e 'display alert "经营考核系统" message "服务已启动，但健康检查超时。\n请打开 logs/server.log 查看详情。"' >/dev/null 2>&1
fi
exit 0
