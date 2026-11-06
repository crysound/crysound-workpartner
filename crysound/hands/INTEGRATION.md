# 本机文件服务接入

桌面构建单独打包 `apps/desktop/src/crysound/hands/index.mjs` 为 `lib/crysound-hands.js`，内含唯一工具注册表与协议实现；electron-builder 显式包含此文件。该模块不导入 Electron，也不自动运行。网关代码位于 `crysound/web/gateway/devices.mjs`；Compose 的单文件挂载覆盖新模块及共享 registry/wire/paths。

## Node API

`createHandsCore({confirm,trash,open,confirmTimeoutMs})` 返回 `setGrants([{path,readOnly}])`、`execute(tool,args,context)` 和 `clearSessions()`。授权默认空，confirm 默认拒绝，trash/open 未注入则返回不可用错误。`setGrants` 先撤销旧授权和会话许可，再 realpath 新授权；调用者应使用 `list_folders` 返回的规范路径。确认超时可缩短但不可超过 60 秒。

`confirm` 收到 tool、规范 paths、summary、source、可选可信 sessionId、AbortSignal，返回 `allow`、`deny` 或 `allow-folder-for-session`。宿主须在 signal 取消后关闭弹窗；迟到的允许不再生效。文件夹许可仅适用于明确的可信会话与精确父目录，最多 100 条，跨目录移动仍逐次确认。断线、授权修改或 clearSessions 清除全部许可；宿主也须在会话结束或退出登录时清除。dsh 当前未传递对话身份，默认客户端不启用跨调用许可，不能用模型自报的 sessionId 扩大权限。

`execute` 返回 `{value,bytes,confirmed}`，错误使用 HandsError.code，中文 message 可转为工具错误。context 可提供 signal、source、可信 sessionId、sendFile(handle,size,check)、receiveFile(handle)。传输宿主不得关闭借用的 handle，sendFile 每块及完成前须调用 check；core 负责关闭、临时文件清理与最终提交。delete 只调用注入的 OS 废纸篓能力，无永久删除回退。move 对普通文件采用独占硬链接再移除源，不覆盖目标，只支持同一文件系统；原文件未移除会报告 PARTIAL，要求检查两个文件。open 只接受文档/图片扩展名，拒绝程序、脚本、可执行文件及目录。

路径检查对只读授权取限制更强的一项；敏感目录规则独立于授权，拒绝软链接（包括指向授权内的链接）、多硬链接及特殊文件。目录遍历跳过这些项。搜索最多检查 2000 项、32 层、读取 20 MiB、返回 100 项；目录列表最多检查 2000 项、返回 500 项，均报告截断。文本上限 1 MiB，单文件传输上限 200 MiB。授权变更会阻止后续检查及尚未提交的写入；已经提交的 OS 调用不回滚。Node 的 realpath/lstat/O_NOFOLLOW 不能替代跨平台内核级文件系统沙箱：能恶意并发替换祖先目录的本地进程仍构成竞态风险，不应给不可信进程共享可写授权目录。

`createHandsClient({url,token,device,core,createSocket,onStatus,sessionForCall,heartbeatMs,reconnectMs,maxReconnectMs})` 返回 start/stop。device 含 id/name/os/appVersion；默认 createSocket 动态加载已声明的 ws，并通过请求头传通行证。仅可信宿主可提供 sessionForCall，默认 undefined。onStatus 提供 online/offline/connection-error/protocol-error/superseded，不包含凭证；UI 必须让用户看到失效与被其他设备接管。stop 中止在途操作并等待清理。重连必须先等待旧操作结束，不能重放工具调用。

## Web 配置

`crysound/web/device-profile.mjs` 仅由 Web entrypoint 在每次启动时执行，独立于 `.zp-seed-v1`。它按固定行 id `crysound-laptop-mcp` 幂等添加 insert 行，使用 serverName laptop 和内网 gateway 地址；已有同 id 行（包括用户主动禁用）原样保留。共享 `partner.patch.yml` 和桌面配置不加此行。CLI 的 resolver manifest 已包含 MCP client；Web Docker 构建额外检查该依赖确实存在。新行添加客户端实例，base bundle 已提供 MCP resources，不需要再启用另一个全局 MCP 插件。已有容器须在经批准的镜像更新并重启后才会执行这一步，本任务不部署或重启服务。

## Electron 宿主任务

下一步从现有登录状态在内存中传入通行证，为每台设备持久化非敏感 id；在主进程启动和停止 hands，退出登录时停连、撤销授权并清理许可。授权页默认不勾选目录，持久化 path/readOnly，撤销时立即调用 setGrants。确认弹窗应显示云端伙伴、操作、路径和改动摘要，三个按钮及 60 秒取消使用上述回调，无法证明对话身份时不显示会话级许可。trash 接 Electron shell.trashItem，open 接 shell.openPath 并将其非空错误字符串转换为失败；不得执行任意命令。关闭窗口后的托盘常驻、开机启动、云端/本机模式、离线与接管提示、真实 Mac/Windows 废纸篓和路径验证归此任务。

设备设置展示/踢出、审计 180 天保留与云端副本 30 天清理、记忆同步不属于本模块的自动行为，需后续产品与运维接入。网关请求不可访问对方容器或任意主机路径；本模块不启动容器、不部署。

## 验证

依赖 Node 24；源码检查运行 `node --test crysound/hands/tests/*.test.mjs`，或顶层 `npm run test:hands`。gateway 测试使用真实 hands core/client，只有 Docker 地址查找和通行证验证使用临时测试宿主，不读取运行服务或真实登录凭证。全部监听为 OS 分配的回环端口，测试结束关闭连接并移除 mkdtemp 目录。

设置 `HANDS_TEST_ARTIFACT` 为已生成 bundle 的绝对路径，可用同一个 gateway 测试验证产物。仓库的正式 tsdown 打包与 build:artifacts/build:check 依赖完整工作区安装；没有依赖时不能宣称桌面正式构建通过。协议细节见 [PROTOCOL.md](PROTOCOL.md)。
