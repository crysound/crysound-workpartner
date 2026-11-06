# Mac 自动更新接入草稿

本草稿提供公司后台下载模块、发版输入检查、签名后更新包和清单生成，以及最终 ZIP 验证脚本。主入口与工作流尚未接入，现有安装包仍不检查更新。接入需先经需求分诊确认：允许主入口增加下面的调用，并允许调整手动构建工作流。不要合入或发布此草稿。

依赖 `desktop/bundle-plugins` 合入后，把本分支变基到 main，只保留本单提交。不要把依赖分支的其他改动当作本单变更。

## 待确认的主入口接入

在 `apps/desktop/src/main.ts` 导入公司模块：

```ts
import { companyUpdateReadyPrompt, companyUpdatesEnabled, createCompanyAutoUpdateSchedule } from './crysound/auto-update.ts'
```

更新协调器创建前计算更新开关与通道：

```ts
const companyUpdateEnabled = companyUpdatesEnabled(app.isPackaged, process.platform, process.resourcesPath)
const updateChannel = companyUpdateEnabled ? 'latest' : desktopUpdateChannel(manifest)
```

把协调器当前固定关闭的 `() => false` 改为 `() => companyUpdateEnabled`。保留其他参数，尤其是上游安装前的任务确认、锁定和干净停止流程。公司更新源只由签名步骤写入，未签名与开发包没有这个文件。

用以下分支替换现有 `updateSchedule` 创建语句，复用原来的启动检查、恢复检查与退出清理；不要同时启动两个轮询器：

```ts
const updateSchedule = companyUpdateEnabled
  ? createCompanyAutoUpdateSchedule(updates, async () => {
      await windowShown()
      if (quitting) return false
      const result = await ordinaryMessageBox(companyUpdateReadyPrompt)
      return result.response === 0
    })
  : new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))
```

提示默认选择“稍后”，关闭弹窗也不重启；同一版本只自动提示一次。“立即重启”继续走上游的安装前确认流程，运行中任务仍受保护。自动轮询失败在六小时后重试，手动检查保留原有交互。

## 待确认的手动构建工作流接入

只修改 `.github/workflows/desktop-mac.yml`，保持 `workflow_dispatch`，不增加推送、标签或定时触发，不自动上传下载站，不增加凭据或权限。

增加两个字符串输入：`version` 必填（例如 `0.2.3`）；`update_url` 可选。更新目录也可用仓库变量 `CRYSOUND_DESKTOP_UPDATE_URL` 指定。目录必须是同事电脑无需登录即可读取的固定 HTTPS 目录，末尾统一为 `/`；目录里只服务 Apple 芯片 Mac 的正式版本。此草稿不设置该变量。

把输入放入 job 的环境变量，避免把输入直接插进 shell：

```yaml
CRYSOUND_DESKTOP_VERSION: ${{ inputs.version }}
CRYSOUND_DESKTOP_UPDATE_URL: ${{ inputs.update_url || vars.CRYSOUND_DESKTOP_UPDATE_URL }}
```

安装依赖与打包前执行：

```sh
node crysound/scripts/mac-update-release.mjs prepare . "$CRYSOUND_DESKTOP_VERSION" "$CRYSOUND_DESKTOP_UPDATE_URL"
```

这只在本次构建的临时检出中改桌面 manifest 的版本，不改依赖、锁文件或内嵌运行时的版本。上游打包脚本允许与产品版本相同的版本，因此不需要改上游版本校验，也不采用日期编号。继续调用现有未签名打包命令；公司签名脚本在原始未签名 DMG 的副本上注入更新源，再签名、公证。无签名凭据时仍只上传没有更新源的未签名 DMG。

签名产物上传步骤的 `path` 改为三行：

```yaml
path: |
  signed/*.dmg
  signed/*.zip
  signed/latest-mac.yml
```

`sign-mac.sh` 有完整发版输入时生成额外文件；缺少全部发版输入时保留旧签名路径；只提供一个输入或格式错误会在签名前失败。生成 ZIP 前对同一个已签名 app 盖公证章，再用 `ditto --keepParent` 打包，最后计算清单中的大小与 SHA-512。`latest-mac.yml` 使用合法 YAML 的 JSON 子集，包含 `version`、`files`、兼容字段 `path` 与 `sha512`。生成后从最终 ZIP 解出 app，检查 Developer ID、代码签名、公证章、系统信任、应用版本及内嵌更新目录。真实 Mac 上的这些检查尚未执行。

## 构建和发布验收

接入获准且依赖已合入后，由伙伴助理手动触发一次候选构建：`version=0.2.3`，`update_url=<选定的固定 HTTPS 更新目录>/`；若已有 `0.2.3`，必须使用更高的正式版本，不能复用相同版本号覆盖文件。本轮没有触发付费构建。

签名产物应包含：

- `crysound-workpartner-0.2.3-mac-arm64.dmg`
- `crysound-workpartner-0.2.3-mac-arm64.zip`
- `latest-mac.yml`

伙伴助理把这三个文件传到 `update_url` 对应的同一目录。先上传版本文件，确认 ZIP 已完整可下载，再覆盖清单；清单应禁用长缓存。保留旧版本文件。此处未执行上传，也不自动改线上目录或缓存设置。

真实 Mac 验收还需两个不同版本的签名包：旧包和新包都必须包含已接入的公司更新模块。先在旧包启动时确认更新源可达，再在该固定目录放新版 ZIP 与清单，检查后台下载、中文提示、“稍后”继续工作、“立即重启”安全停止任务并升级，最后核对安装后版本。不要改写已签名 app 内的更新源；做本地静态服务器验收时，应在签名前指向本机可访问、证书可信的测试 HTTPS 服务。HTTP 更新源在此实现中被拒绝。另装未签名包与运行开发版，确认没有更新网络请求。

已经发布且固定关闭更新的旧包无法自动收到第一次更新，需要手动安装首个支持自动更新的正式包。

## 本地轻量自查

使用 Node 24：

```sh
node --experimental-transform-types --test crysound/scripts/mac-update-release.test.mjs crysound/scripts/company-auto-update.test.mjs
node --check crysound/scripts/mac-update-release.mjs
bash -n crysound/scripts/sign-mac.sh
bash -n crysound/scripts/verify-mac-update.sh
```

模块检查只证明公司逻辑与元数据行为，不代替主入口接入、Mac 签名、公证、构建和实际安装升级验收。没有运行依赖安装、整套测试、桌面构建或镜像构建。
