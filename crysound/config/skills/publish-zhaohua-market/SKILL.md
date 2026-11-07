---
name: publish-zhaohua-market
description: 把公司 Cordis 插件组合包发布或更新到兆华市场，等待管理员审批。用户要求共享公司私有插件时使用。
---

# 发布到兆华市场

只发布用户要求共享给公司的插件。包名必须是 `@crysound/<小写包名>`；首个发布者拥有这个包，非官方包以后只有该发布者能发新版本；官方包也允许管理员指定的维护人发布，每个版本仍需审批。版本不能覆盖，修正内容需递增 SemVer 版本。

## 准备包

`package.json` 需要 `name`、`version`、中文 `description`、`type: "module"`、`files` 和 `dsh.bundle.patch`。有 JavaScript 入口时，`main` / `exports` 指向实际打包文件；纯配置组合包可以只有 patch 文件。例如：

```json
{
  "name": "@crysound/example",
  "version": "0.1.0",
  "displayName": "示例插件",
  "description": "这个插件帮助同事完成什么",
  "type": "module",
  "files": ["cordis.patch.yml", "lib", "README.md"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

README 说明用途、配置、权限和限制；有版本要求时声明 `engines.dsh`。先构建，用 `npm pack --dry-run` 核对内容并确认可通过 dsh profile 加载。不得包含令牌、`.env`、用户数据或本机路径。

`package.json` 可写中文 `displayName`（也支持 `title`，前者优先），1 到 80 字；市场按它显示，安装仍使用原包名。公司官方插件显示名统一用“兆华 + 两到四字”，例如“兆华设计”“兆华动效”。“兆华”前缀保留给官方包，普通包的包名、displayName 或 title 不能以“兆华”开头。“兆华官方”标识和作者“兆华工作伙伴”由公司官方名单决定，发布者不能用包内字段自行声明官方；普通同事发布的包不带该标识。

## 身份与发布

应用提供 `CRYSOUND_MARKET_REGISTRY` 和 `CRYSOUND_NPM_USERCONFIG`，分别指向当前公司的注册表入口和本人 `.npmrc`。桌面版登录时写 desktop profile 的 `.npmrc`；网页版启动时写 `/data/.npmrc`。两者权限均为 600，保存字面令牌；不要读取、打印或复制凭据内容，也不要把令牌放进环境变量。插件目录中的 `.npmrc` 或 `publishConfig.registry` 不能改指其他注册表。

在插件目录执行：

```sh
: "${CRYSOUND_MARKET_REGISTRY:?请在工作伙伴中执行，或先配置公司市场入口}"
: "${CRYSOUND_NPM_USERCONFIG:?请在工作伙伴中执行，或先配置本人 npm 配置路径}"
NPM_CONFIG_USERCONFIG="$CRYSOUND_NPM_USERCONFIG" npm publish --registry "$CRYSOUND_MARKET_REGISTRY"
```

桌面版注册表为 `https://<公司网关域名>/_zp/npm/`；网页版使用容器已有的内网 scope 映射。外部终端可自行设置以上两个非秘密路径变量，`.npmrc` 仍由应用登录维护。不要运行 `npm login`，不要用公共 npm 的令牌替代公司身份。

发布成功后网关给配置的管理员发送飞书审批卡片；管理员从卡片进入审批页完成批准或拒绝。批准版本才进入“兆华市场”索引，客户端需刷新索引（默认缓存十分钟）。发布者可读取自己的待审批版本；其他同事只能读取已批准版本，被拒绝版本不可安装。私有包的详细介绍暂不能经公共 npm CDN 读取，关键信息写进 description。

遇到 401，桌面版重新登录，网页版联系管理员重建容器。403 检查 scope、官方保留名称和首发所有权或维护人资格；409 或“上传结果未知”时停止，不重试同一版本，请管理员核对。通知失败不会撤销已发布版本，管理员可从审批页重发卡片。不要 unpublish、删除 dist-tag 或覆盖版本。

发布前请作者选择分类，写入 `package.json` 的 `labels` 或 `keywords`：设计、视频、文档与报告、数据、研发、销售与市场、其他（对应 `design`、`video`、`documents`、`data`、`development`、`sales`、`other`）。没有选择时归入其他。可把包内样例图编码为 `dsh.market.preview`（PNG、JPEG 或 WebP 的 base64 data URL，解码后不超过 32 KiB）；不要填私有下载地址、令牌或外部追踪 URL。官方身份和维护姓名由管理员配置，包内声明不能授予官方标识或发布权限。

## 官方插件的首页引导

维护人可在包内添加 `dsh.market.guide`，普通包不会因此获得官方身份。中英文都要有，每种语言需一句 `summary`（最多 200 字符）、一段 `prompt`（最多 500 字符）和恰好三个 `examples`（各最多 300 字符），均不能只有空白。prompt 说明用哪个技能或工具完成用户需求，会与用户文字及附件一起进入会话日志，不放秘密或绕过确认的指令。例如，合并到已有 `dsh` 中：

```json
{
  "market": {
    "guide": {
      "zh": {
        "summary": "用公司品牌制作网页和海报。",
        "prompt": "请使用本插件提供的设计技能完成以下需求。",
        "examples": ["设计产品介绍页", "制作展会海报", "检查页面设计"]
      },
      "en": {
        "summary": "Create branded pages and posters.",
        "prompt": "Use this plugin’s design skill for the following request.",
        "examples": ["Design a product page", "Create an event poster", "Review a page design"]
      }
    }
  }
}
```

引导只读已批准版本，修改后需递增版本、重新发布和审批；客户端已安装版本必须与引导版本一致且处于启用状态。首页是否展示由管理员的官方清单控制，包不能自行置顶。首次发布前核对三个例句实际能由本插件完成；不要把示例版本当成已发布版本。缺引导的包仍可使用原生设置。
