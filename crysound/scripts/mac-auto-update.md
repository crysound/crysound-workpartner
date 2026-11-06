# Mac 自动更新

公司 Mac 正式包通过上游 `electron-updater` 协调器检查固定 generic 更新目录，后台下载后提示重启。主入口只接入公司模块、签名包开关、`latest` 通道和一个六小时轮询器；安装前的任务检查、锁定、停止流程保留。网关提供仅持桌面通行证可读的专用更新目录，不依赖网页登录。

## 应用内行为

`apps/desktop/src/crysound/auto-update.ts` 只对已安装的 macOS 包且存在签名步骤写入的 `Resources/app-update.yml` 启用更新。开发版、未签名包不访问更新源。每次检查与下载前都从 `readPartnerSession()` 读取当前登录，与公司配置使用同一份通行证，并只在内存中的 `autoUpdater.requestHeaders` 设置 `Authorization: Bearer zpd.…`。未登录时不检查、不下载，登录后下一轮再查；令牌变化后后续请求使用新令牌，退出登录时清除请求头。通行证不写入日志或 `app-update.yml`。启动检查一次，之后每六小时检查；前台恢复与系统唤醒复用同一个轮询器与截止时间，不额外启动定时器。下载失败在下次轮询时重试，退出时清理轮询器，并阻止迟到的提示与安装。

后台下载完成后，等应用窗口可见时显示中文提示：“新版本已下载，重启后生效”，按钮为“立即重启”“稍后”，默认与关闭弹窗均选“稍后”。同一版本每次运行只自动提示一次。“立即重启”继续进入上游安装确认与任务保护流程；有运行中任务时仍需确认停止，取消后继续工作。应用不会在退出时自动安装，也不强制升级。既有手动更新交互保持上游行为。

## 手动构建

`.github/workflows/desktop-mac.yml` 只由 `workflow_dispatch` 触发，不增加推送、标签或定时触发，不自动上传下载站，不增加凭据或权限。

伙伴助理手动触发候选构建时填写：

- `version`：必填正式版本，例如 `0.2.3`。如果已发布过该版本，必须改用更高版本，不能覆盖同一版本文件。
- `update_url`：`https://<PUBLIC_HOST>/_zp/updates/mac/`；留空时使用仓库变量 `CRYSOUND_DESKTOP_UPDATE_URL`。主机由部署配置提供，路径固定为 `/_zp/updates/mac/`，专供 Apple 芯片 Mac 正式版本，以桌面通行证鉴权。地址不写死进仓库，末尾统一为 `/`。

工作流把输入分别放入 `CRYSOUND_DESKTOP_VERSION` 与 `CRYSOUND_DESKTOP_UPDATE_URL`，先检查输入，再安装依赖与打包。`electron-builder-config.mjs` 把正式版本号写入安装包的 `extraMetadata.version`，从而传到安装包文件名、应用版本与更新比较；源代码 manifest、锁文件和内嵌 dsh 运行时版本保持原样，继续通过上游的同版本校验。

继续调用现有未签名打包命令。只有五项现有签名凭据均存在时，`sign-mac.sh` 才在未签名 DMG 的副本上注入更新源，并签名、公证、盖章。未签名 DMG 始终不带更新源。缺少签名凭据时只上传未签名 DMG，不能作为自动更新发布。

有完整发版输入时，签名脚本额外生成 ZIP 与清单；全部发版输入缺失时保留旧签名路径；只提供一个输入或格式错误会在签名前失败。生成 ZIP 前对同一个已签名 app 盖公证章，再用 `ditto --keepParent` 打包，最后计算大小与 SHA-512。`latest-mac.yml` 使用合法 YAML 的 JSON 子集，包含 `version`、`files`、兼容字段 `path` 与 `sha512`。脚本从最终 ZIP 解出 app，检查 Developer ID、代码签名、公证章、系统信任、应用版本及内嵌更新目录。这些 Mac 检查步骤尚未实际执行。

签名工作流产物 `crysound-workpartner-mac-arm64-signed` 应含：

- `crysound-workpartner-0.2.3-mac-arm64.dmg`
- `crysound-workpartner-0.2.3-mac-arm64.zip`
- `latest-mac.yml`

伙伴助理先部署网关与新增只读模块（按 `crysound/web/compose.yml` 重建网关），再把三个文件上传到服务器数据目录的 `downloads/updates/mac/`，该目录只读挂载为网关的 `/downloads/updates/mac/`。先上传版本文件，用有效桌面通行证确认 ZIP 已完整可下载，再覆盖清单；保留旧版本文件。CI 不上传或改线上目录。

网关在新旧域名上均直接处理 `/_zp/updates/mac/<文件名>`。仅允许 GET、HEAD；有效桌面通行证与 `/_zp/config` 使用同一鉴权，无效或缺失时返回 401，不跳登录。文件名只允许字母、数字、点、下划线、短横线且不得含 `..`；缺失文件（含未发布的 blockmap）返回 404。`latest-mac.yml` 使用 `cache-control: no-cache`，版本文件使用 `no-store`。HEAD 保留文件长度，不返回正文；不提供 Range，下载走完整文件。

## 真实 Mac 验收（未验证）

需两个不同版本的签名包，旧包和新包都包含公司更新模块。伙伴助理触发构建后检查三个产物、签名、公证及版本，再在真实 Mac 上检查：

1. 带有效登录的旧包启动后能通过专用更新源读取清单和 ZIP，发布新版后能检查到、后台下载。未登录时不发请求，登录后下一轮检查恢复；令牌更新后后续请求携带新令牌。
2. 显示指定中文提示，“稍后”和关闭弹窗继续工作，不自动安装。
3. “立即重启”保留任务检查与停止确认；取消停止继续工作，确认后安全升级，重启后版本变成新版。
4. 未签名包与开发版不发出更新网络请求。

做本地静态服务器验收时，应在签名前指向本机可访问、证书可信的测试 HTTPS 服务；不改写已签名 app 内的更新源。HTTP 更新源在此实现中被拒绝。已经发布且固定关闭更新的旧包无法自动收到第一次更新，需要手动安装首个支持自动更新的正式包。

## 轻量自查

使用 Node 24，在已具备仓库依赖的环境运行：

```sh
node --experimental-transform-types --experimental-test-module-mocks --test crysound/scripts/mac-update-release.test.mjs crysound/scripts/company-auto-update.test.mjs crysound/web/gateway/tests/updates.test.mjs
node --check crysound/web/gateway/gateway.mjs
node --check crysound/web/gateway/updates.mjs
node --check crysound/scripts/mac-update-release.mjs
node --check apps/desktop/scripts/electron-builder-config.mjs
bash -n crysound/scripts/sign-mac.sh
bash -n crysound/scripts/verify-mac-update.sh
```

网关测试在随机本地端口执行实际请求分发和新旧域名规则，使用真实测试通行证检查有效、无效、过期、名单外身份、文件名、缓存与 HEAD。桌面测试覆盖未登录跳过、登录后恢复、检查与下载间更新令牌、手动下载与退出登录。测试执行实际主入口的更新初始化片段、公司模块与上游轮询器，并以协调器和对话框替身验证下载与重启选择。打包配置测试导入实际配置，替换不执行的签名、公证与 Windows 工具；核对正式版本元数据及源 manifest 不变。临时文件测试验证更新配置、清单、最终字节哈希、篡改拒绝与重复运行结果。模块与配置检查不代替完整类型检查、Mac 签名、公证、构建和真实安装升级验收。
