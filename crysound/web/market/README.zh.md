# 兆华市场第一期

[English](README.md) | 中文

公司市场使用 dsh 的实验组合包 `@deepseek-ai/dsh-experimental-plugin-market-bundle`，入口是插件页的“发现”标签，不修改 dshmarket。新旧用户启动时补齐 bundle 和公司索引；之后用户关闭 bundle 或修改 indexes 时保留其选择。发布技能随公司资源安装到 `<DSH_HOME>/skills/publish-zhaohua-market`。

## 部署配置

部署参数统一放在 `crysound/web/.env`，照 [示例](../.env.example) 填。`PUBLIC_HOST` 沿用公司网关域名；新增的 `MARKET_ADMINS` 必填已开通用户的 slug，首期填写 Jason 的 slug，多人用逗号分隔。用 `partner-user list` 由管理员核对代号，不把个人编号提交到仓库。所有管理员同时拥有审批权限并收到提醒。机器人需启用发送消息权限（如 `im:message:send_as_bot`），发布应用版本，且管理员在应用可用范围内。

Verdaccio 只加入已有 `partner-net`，没有宿主映射端口，`uplinks: {}` 禁止代理公网 npm。只允许内部网关账号访问 `@crysound/*`；其他 scope 一律拒绝。网关使用公司 Dockerfile 安装锁定的 semver 依赖，校验发布版本和 `engines.dsh`。数据保存在 `PARTNER_DATA/npm`，与 `PARTNER_DATA/gateway/state/market.json` 一起备份和恢复。不要单独恢复其中一份，也不要同时运行多个网关实例写同一市场状态文件。

首次部署由服务器管理员加载 `.env` 后准备目录和内部凭据；以下命令只在目标服务器执行，需要 root 和 `htpasswd`（Debian 的 `apache2-utils`）。随机内部密码不输出到终端；已有文件不覆盖，不把内容复制到 `.env` 或交给用户。网关读取 `market-npm-auth`（root:root 600），Verdaccio 读取同账号密码的 bcrypt `market-htpasswd`（10001:65533 400）。

```sh
set -a
. crysound/web/.env
set +a
python3 - <<'PY'
import os, secrets, subprocess
from pathlib import Path
secure = Path(os.environ['PARTNER_SECURE'])
auth, hashed = secure / 'market-npm-auth', secure / 'market-htpasswd'
if auth.exists() or hashed.exists():
    raise SystemExit('内部凭据已存在；停止，不覆盖或轮换')
password = secrets.token_urlsafe(48)
record = subprocess.run(['htpasswd', '-niB', 'zp-gateway'], input=password + '\n', text=True, capture_output=True, check=True).stdout
os.umask(0o077)
with auth.open('x') as out:
    out.write('zp-gateway:' + password + '\n')
with hashed.open('x') as out:
    out.write(record)
os.chown(auth, 0, 0)
os.chown(hashed, 10001, 65533)
hashed.chmod(0o400)
npm = Path(os.environ['PARTNER_DATA']) / 'npm'
npm.mkdir(mode=0o750, exist_ok=True)
os.chown(npm, 10001, 65533)
PY
docker compose -f crysound/web/compose.yml config --quiet
docker compose -f crysound/web/compose.yml --profile build build partner-image gateway
docker compose -f crysound/web/compose.yml up -d --force-recreate verdaccio gateway
```

网关启动给已开通用户签发 `.zp-market-token`（zpd，180 天），自助或手工开通也会签发；用户目录与文件分别归 UID 1001 所有。再按现有空闲升级流程重建用户容器，入口脚本将令牌原文写到 `/data/.npmrc`，权限 600。它不能引用含 TOKEN 的环境变量，因为 dsh 的 pnpm 子进程会过滤此类变量。180 天内重建容器以更新身份；过期 401 时重建，不让用户索取内部密码。`partner-user upgrade` 也会重新签发；其签名格式与网关一致。

桌面版更新后登录或恢复登录时写 desktop profile 的 `.npmrc`，仅维护公司 scope 和该注册表的 `_authToken`，保留其他配置，切换域名时删除旧市场入口的令牌，退出登录移除公司两项。Host 的 fetch 钩子只给同一公司 origin 的 `/_zp/market/` 补 Authorization，拒绝重定向，401 触发原有重新登录流程。公司索引和模型占位地址在桌面准备阶段替换，网页版 Dockerfile 用 sed 换成 Docker 内部地址。

桌面打包前运行 `node crysound/scripts/configure-public-host.mjs`，它从 `crysound/web/.env` 只提取 `PUBLIC_HOST`，生成被 git 忽略的 `crysound/config/public-host.json`；其他部署值不写入桌面资源。也可显式传入 `PUBLIC_HOST`，此时不读取 `.env`。Mac 和 Windows 打包工作流使用仓库变量 `PUBLIC_HOST`，由运维与部署 `.env` 中的同名值同步；缺失时构建失败。运行时同名环境变量可覆盖安装包值。代码不内置正式或旧域名；生成配置中的域名应使用当前正式入口，避免鉴权请求经过旧网址跳转。

## 发布与审批

发布入口是 `npm publish --registry https://<PUBLIC_HOST>/_zp/npm/`，包名仅 `@crysound/*`。用随包的“发布到兆华市场”技能完成准备和发布，它通过应用提供的路径变量选择本人 `.npmrc`；容器用内网入口。只接受单版本、带 tarball、description 和 `dsh.bundle.patch` 的组合包。第一个成功发布者取得包所有权，后续只能该用户发布新版本；禁止删除、覆盖和改写 dist-tag。

发布成功后持久化 pending 状态，并通过现有飞书机器人发交互卡片。卡片的“查看并审批”打开 `https://<PUBLIC_HOST>/_zp/market/admin`，管理员必须用飞书网页登录；桌面 Bearer 不能代替管理员会话。批准或拒绝的 POST 还检查 Origin，记录操作者与时间。发送失败不影响已发布版本，网关日志会报告失败；审批页的“重发审批卡片”可重试。

`/_zp/npm/*` 和 `/_zp/market/index.json` 都用 `desktopUser` 校验 Bearer zpd 的签名、期限及开通名单，不接受浏览器 cookie 代替。包元数据和 tarball 可被所有已开通的人读取，包括 pending / rejected 版本；审批只控制发现列表，不构成下载隔离。内网元数据返回内网 tarball 地址，公网返回公网地址，均由网关替换内部账号；客户端只持有本人令牌。

索引为 format 1，结合 Verdaccio 包数据与审批记录，按 SemVer 降序列出仍存在的全部 approved 版本及 `engines.dsh`，不写 registry，依靠 `@crysound:registry` 映射。注册表无法核对时返回错误，不能伪装成空索引。dsh 会缓存索引十分钟，可在发现页刷新。第一期不提供私有包 README 的公共 CDN 镜像；详细介绍可能不可用。

上传前先原子保存 publishing；连接中断、5xx 或后续保存失败时可能已经上传成功，不自动重试或放开所有权。由管理员停止网关，备份并核对 Verdaccio 对应版本与 `market.json`：确认存在且内容正确才把 publishing 改成 pending；确认未写入才撤销该版本预留（无其他版本时可移除包记录）；不能确认则保持 publishing。修改后重启网关再审批，勿删除已发布 tarball。损坏状态不会重置为空；恢复成对备份。此阶段恢复仅由运维完成。

## 本地验证

所有测试使用临时目录、假身份和隔离配置，不读取真实 `.env` 或凭据，不发送真实飞书消息。Node 至少 24.9，配置与索引验证测试需要仓库已安装的依赖：

```sh
node --test crysound/web/gateway/tests/*.test.mjs
node crysound/web/tests/compose-config.mjs
```

真实注册表冒烟需要在独立临时目录安装 `verdaccio@6.1.6`、`pnpm@11`，安装时使用临时 HOME、空 user/global npm 配置和独立 cache，避免读取本机凭据；将该目录传给 `MARKET_TEST_TOOLS`：

```sh
MARKET_TEST_TOOLS=<隔离依赖目录> node crysound/web/tests/registry-smoke.mjs
```

冒烟自动在 loopback 随机端口启动真实 Verdaccio，用 npm 连续发布两个版本，经生产网关处理器审批，再用 pnpm 11 从 profile `.npmrc` 查询、下载和安装；退出时等待进程结束并清理临时数据。

真实环境还需验证：镜像构建和现有用户重建、新用户自助开通、桌面登录/退出/过期重登、Jason 收到卡片并完成审批、品牌层下“发现”标签及点击安装、公司网络与代理下的 scope 和 tarball 鉴权、容器内网 DNS 与磁盘权限。不要在验收中输出凭据。
