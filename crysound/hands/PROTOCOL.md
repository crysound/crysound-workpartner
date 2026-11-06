# 本机工具协议 v1

桌面端主动连接 `wss://<host>/_zp/device`，HTTP Upgrade 使用现有 `Authorization: Bearer zpd.…`，凭证不放在 URL 或日志里。生产客户端使用已声明的 `ws` 依赖；测试可注入 Node 24 WebSocket。普通 `ws://` 仅允许回环地址。

## 连接与调用

文本消息为 JSON 对象，最大 8 MiB；工具名、中文描述、参数 Schema、确认要求仅由 [tools.json](tools.json) 定义。

| type | 字段 | 语义 |
|---|---|---|
| `hello` | `version: 1, id, name, os, appVersion` | 桌面端先发；各字符串 1–128 字符，无控制字符。网关答 `{type:"hello",version:1}` 后才能调用 |
| `call` | `id, tool, arguments, source` | 网关生成 UUID，单用户同一时间只允许一个调用；忙时返回工具错误 |
| `result` | `id, value, bytes, confirmed` | 本机操作成功，confirmed 为是否经过单次或有效会话许可确认 |
| `error` | `id, code, message, bytes, confirmed` | 稳定错误码与中文说明；取消、断线可能发生在修改提交后，调用方须检查文件，不能自动重放 |
| `cancel` | `id` | 取消确认、传输和尚未提交的写入；已提交的 OS 操作不能撤回 |
| `heartbeat` | `at` | 双方每 30 秒发送；连续超过 90 秒未收到消息则断开 |

10 秒未完成 hello 会被关闭。每个用户最后成功完成 hello 的最新连接生效；旧连接以 4001 关闭，旧客户端停止自动重连，避免互相抢占。网络断线按 0.5 秒起、倍增至 30 秒的间隔重连，只恢复连接，不重放调用。网关保留最近 100 个结束请求的 id，忽略对应迟到消息。

## 文件传输

`fetch_to_cloud` 由本机发送文件；`save_to_laptop` 经本机授权检查、确认并准备临时文件后先发 `{type:"receive_ready",id}`，网关才开始发送。

1. 发送方发 `{type:"transfer",id,size}`；接收方校验 size 为 0–209715200 整数并回 `{type:"ready",id}`。
2. 每条二进制 WebSocket 消息含：4 字节大端 JSON 头长度（最多 256），UTF-8 JSON `{id,seq}`，以及最多 65536 字节文件内容。seq 从 0 连续递增；收到一块并写盘后回 `{type:"ack",id,seq}`，发送方再发下一块。
3. 发送方验证文件大小、mtime、ctime 未变化，发 `{type:"transfer_end",id,sha256}`，sha256 为完整文件的十六进制摘要。接收方校验总大小及摘要后回 `{type:"received",id}`。
4. 文件先写独占临时文件，校验后才发布。确认等待上限 60 秒；单块等待 30 秒，接收和网关调用总预算 240 秒，MCP 客户端预算 300 秒。失败清理临时文件；进程崩溃可能留下 `.part` 或 `.tmp`，不得当成功文件使用。

云端源文件必须使用 `/data/…` 路径，映射到 `/users/<slug>/…`；现有分量须通过 lstat/realpath，拒绝路径逃逸和链接，密钥及账号目录也不可作为源。取回文件以 UUID 前缀放入 `/data/work/来自本机/`，不覆盖已有文件，目录和文件归 1001:1001。返回的云端路径只在最终提交后有效。

## 内网 MCP 与审计

`POST /_zp/device-mcp` 是无会话、JSON 响应的 Streamable HTTP：支持 initialize、notifications/initialized、ping、tools/list、tools/call、notifications/cancelled；不发 MCP session id。GET 返回 405。工具始终存在，离线调用返回 isError 和“电脑未连接，请在你的电脑上打开兆华工作伙伴后重试。”。

用户身份仅来自 TCP 来源 IP → Docker 运行容器的 partner-net 地址与容器名 → 用户名单。转发头、CF 头、Origin 一律拒绝；不使用请求参数或转发 IP 选用户。桌面通行证不授权 MCP 入口。

每次调用重新读取 `/state/devices-policy.json`，全员或用户禁用立即阻止新调用；文件损坏、不可读也拒绝。`/state/devices/<slug>.json` 保存设备 id/name/os/appVersion/firstSeen/lastSeen。`/state/device-audit/<slug>.jsonl` 每行含 time/user/device/tool/paths/bytes/outcome/confirmed，不存参数正文或文件内容；bytes 为报告的完成字节数，断线时 confirmed 为 null 表示未获确认状态。审计落盘失败返回操作结果可能已生效的错误，并输出无内容的诊断。

当前 dsh MCP 调用不传递可信对话 id。网关不会把模型参数当会话授权依据：默认每次写操作都确认，“本次对话允许文件夹”没有可信宿主会话时仅允许本次操作，详见 [接入要求](INTEGRATION.md)。
