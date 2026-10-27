#!/bin/bash
#============================================================
# 钻井经营考核系统 · macOS 开机自启（launchd）
# 双击一次即可：以后登录本机就自动启动服务，进程意外退出 10 秒内自动拉起。
# 装好后照常用「启动 / 停止经营考核系统.command」，它们会改走 launchd。
# 取消请双击「取消开机自启.command」。
# 电脑断电重启后也能恢复，前提是系统设置里开了「断电后自动启动」和自动登录。
#============================================================
set -u

LABEL="com.kaohe.server"
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
DIR="$BASE_DIR/server"
LOG_DIR="$BASE_DIR/logs"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

# ---- 读取端口（默认 4000，以 server/.env 中 PORT 为准）----
PORT=4000
if [ -f "$DIR/.env" ]; then
  ENV_PORT="$(grep -E '^PORT=' "$DIR/.env" | tail -1 | cut -d= -f2 | tr -d ' \r')"
  [ -n "${ENV_PORT:-}" ] && PORT="$ENV_PORT"
fi

# ---- 0. 找 Node.js：用 Homebrew 的符号链接路径，升级 Node 后不用重装自启 ----
NODE="$(command -v node 2>/dev/null)"
for p in /opt/homebrew/bin/node /usr/local/bin/node; do [ -z "$NODE" ] && [ -x "$p" ] && NODE="$p"; done
if [ -z "$NODE" ]; then
  osascript -e 'display alert "经营考核系统" message "未找到 Node.js，请先安装 Node.js 18 或更高版本。" as critical' >/dev/null 2>&1
  echo "未找到 Node.js，请先安装：https://nodejs.org/zh-cn/download"
  exit 1
fi

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
if [ ! -d "$DIR/node_modules" ]; then
  echo "首次运行，正在安装依赖（npm install）..."
  (cd "$DIR" && PATH="$(dirname "$NODE"):$PATH" npm install >>"$LOG_DIR/server.log" 2>&1) || { echo "依赖安装失败，详情见 logs/server.log"; exit 1; }
fi

# ---- 1. 先停掉正在跑的服务（旧的自启实例、或手动启动的进程），把端口让出来 ----
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
if [ -n "$PIDS" ]; then
  echo "停止当前在端口 $PORT 上运行的服务..."
  echo "$PIDS" | xargs kill 2>/dev/null; sleep 2
  PIDS="$(lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null)"
  [ -n "$PIDS" ] && echo "$PIDS" | xargs kill -9 2>/dev/null
fi

# ---- 2. 旧日志归档 ----
# 同样因为隐私保护：终端里启动时生成的 server.log 带着「来源」标记，launchd 拉起的进程不能往里追加
# （Operation not permitted，服务会以退出码 1 反复起不来）。改名留档，让自启服务自己新建一份。
if [ -f "$LOG_DIR/server.log" ]; then
  ARCHIVE="$LOG_DIR/server-$(date +%Y%m%d-%H%M%S).log"
  mv "$LOG_DIR/server.log" "$ARCHIVE" && echo "原日志已归档为 logs/$(basename "$ARCHIVE")"
fi

# ---- 3. 写 LaunchAgent ----
# 项目放在「文稿」（~/Documents）里时，macOS 隐私保护不让 launchd 自己去打开这里的工作目录和日志文件
# （直接写 WorkingDirectory / StandardOutPath 会以退出码 78 起不来），所以交给 sh 去 cd 和重定向日志。
x() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }   # 转成 XML 文本
RUN="cd '$DIR' && exec '$NODE' server.js >> '$LOG_DIR/server.log' 2>&1"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>$(x "$RUN")</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$(x "$(dirname "$NODE")"):/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
</dict></plist>
EOF
if ! plutil -lint "$PLIST" >/dev/null; then echo "自启配置写入失败：$PLIST"; exit 1; fi

# ---- 4. 加载并等待就绪（最多 20 秒）----
launchctl bootstrap "$DOMAIN" "$PLIST" || { echo "加载自启失败，详情见 logs/server.log"; exit 1; }
for _ in $(seq 1 20); do
  sleep 1
  if curl -s -o /dev/null "http://localhost:$PORT/api/health"; then
    echo "已设置开机自启：登录本机后自动启动，进程意外退出会在 10 秒内自动拉起。"
    echo "服务已在 http://localhost:$PORT 运行。"
    exit 0
  fi
done
echo "自启已设置，但服务 20 秒内没有就绪，请查看 logs/server.log。"
exit 1
