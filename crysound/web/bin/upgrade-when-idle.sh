#!/bin/sh
# 等某人的空间空闲（最近 N 分钟没有会话写入）后再用当前镜像重建，最多等 6 小时。
# 用法：upgrade-when-idle.sh <代号> [空闲分钟数=10]
SLUG=$1; IDLE=${2:-10}
BIN=$(cd "$(dirname "$0")" && pwd); cd "${PARTNER_DATA:-/srv/xiaoman/zhaohua-partner}"
for i in $(seq 1 72); do
  busy=$(sudo find "users/$SLUG/.dsh/sessions" "users/$SLUG/.dsh/storages" -type f -newermt "-$IDLE minutes" 2>/dev/null | wc -l)
  if [ "$busy" -eq 0 ]; then "$BIN/partner-user" upgrade "$SLUG"; exit 0; fi
  sleep 300
done
echo "$SLUG 6 小时内一直在用，未升级"
