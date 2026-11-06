#!/bin/sh
# 用当前镜像重建指定的人，等每人就绪，打印启动报错和本人配置里的条目。
# 用法：upgrade-and-check.sh <代号>...
BIN=$(cd "$(dirname "$0")" && pwd); cd "${PARTNER_DATA:-/srv/xiaoman/zhaohua-partner}"
"$BIN/partner-user" upgrade "$@"
for S in "$@"; do
  timeout 150 sh -c "until docker logs zhaohua-partner-$S 2>&1 | grep -q 'dsh web: listening'; do sleep 3; done" && echo "$S 已就绪" || echo "$S 未就绪"
  docker logs "zhaohua-partner-$S" 2>&1 | grep -i "error\|修补未命中\|安装失败" | head -5
  sudo grep -n "^- id:" "users/$S/.dsh/profiles/web/cordis.patch.yml"
done
