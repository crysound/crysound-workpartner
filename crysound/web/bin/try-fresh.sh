#!/bin/sh
# 排查用：用当前镜像重新开通测试账号 zptest，等它就绪，打印启动日志尾部和本人配置里的条目。
BIN=$(cd "$(dirname "$0")" && pwd); [ -f "$BIN/../.env" ] && { set -a; . "$BIN/../.env"; set +a; }
cd "${PARTNER_DATA:?在 crysound/web/.env 设置 PARTNER_DATA}"
docker rm -f zhaohua-partner-zptest >/dev/null 2>&1
sudo rm -rf users/zptest
"$BIN/partner-user" add zptest 测试账号 on_zptest_0000000000000000000000 | tail -1
timeout 150 sh -c 'until docker logs zhaohua-partner-zptest 2>&1 | grep -q "dsh web: listening"; do sleep 3; done' || echo 未就绪
docker logs zhaohua-partner-zptest 2>&1 | tail -5
sudo grep -n "id:\|provider\|welcome" users/zptest/.dsh/profiles/web/cordis.patch.yml
