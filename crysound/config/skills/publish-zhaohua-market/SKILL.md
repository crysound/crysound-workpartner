---
name: publish-zhaohua-market
description: 把公司 Cordis 插件组合包发布或更新到兆华市场，等待管理员审批。用户要求共享公司私有插件时使用。
---

# 发布到兆华市场

只发布用户要求共享给公司的插件。包名必须是 `@crysound/<小写包名>`；首个发布者拥有这个包，以后只有该发布者能发新版本。版本不能覆盖，修正内容需递增 SemVer 版本。

## 准备包

`package.json` 需要 `name`、`version`、中文 `description`、`type: "module"`、`files` 和 `dsh.bundle.patch`。有 JavaScript 入口时，`main` / `exports` 指向实际打包文件；纯配置组合包可以只有 patch 文件。例如：

```json
{
  "name": "@crysound/example",
  "version": "0.1.0",
  "description": "这个插件帮助同事完成什么",
  "type": "module",
  "files": ["cordis.patch.yml", "lib", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

README 说明用途、配置、权限和限制；有版本要求时声明 `engines.dsh`。先构建，用 `npm pack --dry-run` 核对内容并确认可通过 dsh profile 加载。不得包含令牌、`.env`、用户数据或本机路径。

## 身份与发布

应用提供 `CRYSOUND_MARKET_REGISTRY` 和 `CRYSOUND_NPM_USERCONFIG`，分别指向当前公司的注册表入口和本人 `.npmrc`。桌面版登录时写 desktop profile 的 `.npmrc`；网页版启动时写 `/data/.npmrc`。两者权限均为 600，保存字面令牌；不要读取、打印或复制凭据内容，也不要把令牌放进环境变量。插件目录中的 `.npmrc` 或 `publishConfig.registry` 不能改指其他注册表。

在插件目录执行：

```sh
: "${CRYSOUND_MARKET_REGISTRY:?请在工作伙伴中执行，或先配置公司市场入口}"
: "${CRYSOUND_NPM_USERCONFIG:?请在工作伙伴中执行，或先配置本人 npm 配置路径}"
NPM_CONFIG_USERCONFIG="$CRYSOUND_NPM_USERCONFIG" npm publish --registry "$CRYSOUND_MARKET_REGISTRY"
```

桌面版注册表为 `https://<公司网关域名>/_zp/npm/`；网页版使用容器已有的内网 scope 映射。外部终端可自行设置以上两个非秘密路径变量，`.npmrc` 仍由应用登录维护。不要运行 `npm login`，不要用公共 npm 的令牌替代公司身份。

发布成功后网关给配置的管理员发送飞书审批卡片；管理员从卡片进入审批页完成批准或拒绝。批准版本才进入“兆华市场”索引，客户端需刷新索引（默认缓存十分钟）。待审批和被拒绝版本仍可被已开通用户按包名直接读取；审批控制发现列表。私有包的详细介绍暂不能经公共 npm CDN 读取，关键信息写进 description。

遇到 401，桌面版重新登录，网页版联系管理员重建容器。403 检查 scope 和首发所有权；409 或“上传结果未知”时停止，不重试同一版本，请管理员核对。通知失败不会撤销已发布版本，管理员可从审批页重发卡片。不要 unpublish、删除 dist-tag 或覆盖版本。
