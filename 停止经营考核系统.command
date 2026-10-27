#!/bin/bash
#============================================================
# 钻井经营考核系统 · macOS 停止脚本
# 双击本文件即可停止后台运行的服务。
# （Windows 下请用 停止经营考核系统.bat）
#============================================================
set -u

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$BASE_DIR/server"

# ---- 读取端口（默认 4000，以 server/.env 中 PORT 为准）----
PORT=4000
if [ -f "$DIR/.env" ]; then
  ENV_PORT="$(grep -E '^PORT=' "$DIR/.env" | tail -1 | cut -d= -f2 | tr -d ' \r')"
  [ -n "${ENV_PORT:-}" ] && PORT="$ENV_PORT"
fi

echo "正在停止端口 $PORT 上的经营考核系统服务..."
# 由开机自启（launchd）托管时，直接杀进程会被立刻拉起，要先把它从 launchd 卸下。
# 自启配置保留：下次登录本机、或双击「启动经营考核系统.command」时恢复。
LABEL="com.kaohe.server"
DOMAIN="gui/$(id -u)"
MANAGED=0
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
  MANAGED=1
  sleep 1
fi
FOUND=$MANAGED
PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PIDS" ]; then
  FOUND=1
  echo "$PIDS" | xargs kill 2>/dev/null
  sleep 2
  PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$PIDS" ] && echo "$PIDS" | xargs kill -9 2>/dev/null
fi
if [ -n "$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "停止失败：端口 $PORT 仍被占用，请在「活动监视器」里查看。"
elif [ "$FOUND" = 1 ]; then
  echo "已停止。数据已全部保存在本地 server/data 目录，不会丢失。"
  [ "$MANAGED" = 1 ] && echo "开机自启设置仍保留：下次登录本机，或双击「启动经营考核系统.command」时会恢复运行。"
else
  echo "没有发现运行中的服务（可能本来就没启动）。"
fi
sleep 3
exit 0
