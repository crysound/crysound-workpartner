#!/bin/sh
set -u
CONFIG=/opt/partner-config
for file in plugins.json partner.patch.yml profile-upgrades.mjs plugin-patches.mjs market-profile.mjs market-npmrc.mjs skills/publish-zhaohua-market/SKILL.md; do
  if [ ! -r "$CONFIG/$file" ]; then
    echo "公司配置缺失或不可读：$CONFIG/$file；请检查服务器配置目录及只读挂载" >&2
    exit 1
  fi
done
# 模型一律经 magpie：钥匙从只读挂载的文件进环境，DeepSeek 内置路由也改指 magpie，用量记在这把钥匙上。
# dsh 网页版不接受 0.0.0.0，绑定容器自己的地址，再由 Docker 或网关在内部网络访问。
node "$CONFIG/market-npmrc.mjs" /data/.npmrc || echo "警告：市场 npm 配置失败，本次市场安装可能不可用；继续启动" >&2
MAGPIE_API_KEY=$(cat /etc/partner/magpie.key) && export MAGPIE_API_KEY
export DEEPSEEK_API_KEY="$MAGPIE_API_KEY" DEEPSEEK_BASE_URL="${MAGPIE_BASE_URL:?请设置 MAGPIE_BASE_URL}"
export CRYSOUND_LLM_BASE="$DEEPSEEK_BASE_URL"
mkdir -p /data/work && cd /data/work
# 公司统一插件，版本固定，所有人一致，清单与桌面版共用（plugins.json）；已是该版本就跳过。
node -e 'for (const p of require(process.argv[1]).plugins) console.log(p.name, p.spec, p.want)' "$CONFIG/plugins.json" |
while read NAME SPEC WANT; do
  grep -qF "\"$NAME\": \"$WANT\"" "$DSH_HOME/profiles/web/package.json" 2>/dev/null \
    || dsh plugin --profile web add "$SPEC" </dev/null >/dev/null 2>&1 || echo "插件 $NAME 安装失败，本次不带它启动"
done
# 第三方插件的本地修补（SlideStudio 兼容），清单和原因见 plugin-patches.mjs。
node "$CONFIG/plugin-patches.mjs" "$DSH_HOME/profiles/web/node_modules" || echo "警告：插件修补失败，继续启动" >&2
# 语音模型用镜像里的共用一份，不再每人下载。
mkdir -p "$DSH_HOME/speech-to-text/sensevoice" && ln -sfn /opt/sensevoice/models "$DSH_HOME/speech-to-text/sensevoice/models"
# 默认开通的实验插件：只在每人第一次启动时打开一次，之后本人关掉就保持关闭。
DEFAULTS_MARK="$DSH_HOME/.zp-default-plugins-v1"
[ -f "$DEFAULTS_MARK" ] || node -e '
const fs=require("fs"),[p,list]=process.argv.slice(1),m=JSON.parse(fs.readFileSync(p,"utf8")),b=((m.dsh??={}).profile??={}).bundles??=[];
for (const n of require(list).defaultBundles) if(!b.includes(n)) b.push(n);
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n")' "$DSH_HOME/profiles/web/package.json" "$CONFIG/plugins.json" && touch "$DEFAULTS_MARK"
# 首次写默认值；每次启动只刷新公司提供方，不锁定设置页或覆盖个人提供方。
SEED_MARK="$DSH_HOME/.zp-seed-v1"
if [ -f "$SEED_MARK" ]; then SEED_ARG=; else SEED_ARG=--seed; fi
node "$CONFIG/profile-upgrades.mjs" "$DSH_HOME/profiles/web/cordis.patch.yml" \
  "$CONFIG/partner.patch.yml" "$(readlink -f "$(command -v dsh)")" $SEED_ARG || { echo "公司模型配置刷新失败，停止启动" >&2; exit 1; }
touch "$SEED_MARK"
mkdir -p "$DSH_HOME/skills"
cp -R "$CONFIG/skills/publish-zhaohua-market" "$DSH_HOME/skills/" || echo "警告：市场发布技能复制失败，继续启动" >&2
node "$CONFIG/market-profile.mjs" "$DSH_HOME/profiles/web/cordis.patch.yml" "$DSH_HOME/profiles/web/package.json" "${CRYSOUND_MARKET_ORIGIN:-http://zhaohua-partner-gateway:3090}/_zp/market/index.json" || echo "警告：市场 profile 配置失败，继续启动" >&2
export CRYSOUND_COMPANY_SKILLS="$(cat /opt/partner/feishu-skills-path)"
node /opt/partner/feishu/container-setup.mjs || echo "警告：飞书命令或技能准备失败，请联系管理员" >&2
exec dsh --profile web --no-open --host "$(hostname -i | cut -d' ' -f1)" --port 3080 \
  --public-url "https://${PUBLIC_HOST}/" --trusted-host "${PUBLIC_HOST}" --trusted-host 127.0.0.1:3080
