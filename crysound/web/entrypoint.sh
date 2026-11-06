#!/bin/sh
# 模型一律经 magpie：钥匙从只读挂载的文件进环境，DeepSeek 内置路由也改指 magpie，用量记在这把钥匙上。
# dsh 网页版不接受 0.0.0.0，绑定容器自己的地址，再由 Docker 或网关在内部网络访问。
set -u
# 使用字面令牌：dsh 子进程会过滤含 TOKEN 的环境变量。
node /opt/partner/market-npmrc.mjs /data/.npmrc || echo "警告：市场 npm 配置失败，本次市场安装可能不可用；继续启动" >&2
MAGPIE_API_KEY=$(cat /etc/partner/magpie.key) && export MAGPIE_API_KEY
export DEEPSEEK_API_KEY="$MAGPIE_API_KEY" DEEPSEEK_BASE_URL=http://magpie:3425/v1
mkdir -p /data/work && cd /data/work
# 公司统一插件，版本固定，所有人一致，清单与桌面版共用（plugins.json）；已是该版本就跳过。
node -e 'for (const p of require(process.argv[1]).plugins) console.log(p.name, p.spec, p.want)' /opt/partner/plugins.json |
while read NAME SPEC WANT; do
  grep -qF "\"$NAME\": \"$WANT\"" "$DSH_HOME/profiles/web/package.json" 2>/dev/null \
    || dsh plugin --profile web add "$SPEC" </dev/null >/dev/null 2>&1 || echo "插件 $NAME 安装失败，本次不带它启动"
done
# 第三方插件的本地修补（SlideStudio 兼容），清单和原因见 plugin-patches.mjs。
node /opt/partner/plugin-patches.mjs "$DSH_HOME/profiles/web/node_modules" || echo "警告：插件修补失败，继续启动" >&2
# 语音模型用镜像里的共用一份，不再每人下载。
mkdir -p "$DSH_HOME/speech-to-text/sensevoice" && ln -sfn /opt/sensevoice/models "$DSH_HOME/speech-to-text/sensevoice/models"
# 默认开通的实验插件：只在每人第一次启动时打开一次，之后本人关掉就保持关闭。
DEFAULTS_MARK="$DSH_HOME/.zp-default-plugins-v1"
[ -f "$DEFAULTS_MARK" ] || node -e '
const fs=require("fs"),[p,list]=process.argv.slice(1),m=JSON.parse(fs.readFileSync(p,"utf8")),b=((m.dsh??={}).profile??={}).bundles??=[];
for (const n of require(list).defaultBundles) if(!b.includes(n)) b.push(n);
fs.writeFileSync(p,JSON.stringify(m,null,2)+"\n")' "$DSH_HOME/profiles/web/package.json" /opt/partner/plugins.json && touch "$DEFAULTS_MARK"
# 公司默认配置（经 magpie 的模型、默认模型、预览说明已读）只在每人第一次启动时写进本人配置；本人已有同名项就不动。
# 不用启动参数覆盖：被覆盖的项在设置页里存不了，本人就加不了自定义模型。
SEED_MARK="$DSH_HOME/.zp-seed-v1"
[ -f "$SEED_MARK" ] || node -e '
const fs=require("fs"),[seed,dst]=process.argv.slice(1);
const head="# Your patch layer for this dsh profile, applied after every bundle layer:\n# a top-level YAML array of loader patch entries (id-targeted config\n# overrides, disables, and insert lists; `!!js` expressions allowed).\n";
let mine=(fs.existsSync(dst)?fs.readFileSync(dst,"utf8"):head).replace(/^\[\]\s*$/m,"");
for (const e of fs.readFileSync(seed,"utf8").split(/^(?=- id: )/m).filter(e=>e.startsWith("- id: "))) {
  const id=e.match(/^- id: (\S+)/)[1];
  if (!new RegExp("^- id: [\"\x27]?"+id+"[\"\x27]?\\s*$","m").test(mine)) mine=mine.replace(/\n*$/,"\n")+e.replace(/\n*$/,"\n");
}
fs.writeFileSync(dst,mine,{mode:0o600})' /opt/partner/partner.patch.yml "$DSH_HOME/profiles/web/cordis.patch.yml" && touch "$SEED_MARK"
mkdir -p "$DSH_HOME/skills"
cp -R /opt/partner/skills/publish-zhaohua-market "$DSH_HOME/skills/" || echo "警告：市场发布技能复制失败，继续启动" >&2
node /opt/partner/market-profile.mjs "$DSH_HOME/profiles/web/cordis.patch.yml" "$DSH_HOME/profiles/web/package.json" http://zhaohua-partner-gateway:3090/_zp/market/index.json || echo "警告：市场 profile 配置失败，继续启动" >&2
# 公司默认值变了时，把已开通用户仍是旧默认值的条目升到新值（用户改过的不动）。
node /opt/partner/profile-upgrades.mjs "$DSH_HOME/profiles/web/cordis.patch.yml" || echo "警告：默认配置升级失败，继续启动" >&2
exec dsh --profile web --no-open --host "$(hostname -i | cut -d' ' -f1)" --port 3080 \
  --public-url "https://${PUBLIC_HOST}/" --trusted-host "${PUBLIC_HOST}" --trusted-host 127.0.0.1:3080
