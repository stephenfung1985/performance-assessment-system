#!/bin/bash
#============================================================
# 钻井经营考核系统 · 取消 macOS 开机自启
# 停止由 launchd 托管的服务并删除自启配置。之后要用服务，双击「启动经营考核系统.command」手动启动。
#============================================================
set -u

LABEL="com.kaohe.server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

if [ ! -f "$PLIST" ] && ! launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  echo "本机没有设置开机自启，无需取消。"
  sleep 2; exit 0
fi
launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1
rm -f "$PLIST"
echo "已取消开机自启，服务已停止。数据保存在 server/data 目录，不受影响。"
echo "需要时双击「启动经营考核系统.command」手动启动。"
sleep 2
exit 0
