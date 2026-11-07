# 网页发送与用量默认值验收证据

截图来自已有固定版镜像的独立临时容器，通过本次真实 `profile-upgrades.mjs --web-preview` 刷新配置后，用受支持的 `dsh --profile web` 启动。浏览器使用手册配置的持久 CDP 入口和本轮独立标签页；没有修改线上账号、安装依赖、构建镜像或调用付费模型。

- `defaults.png`：没有保存过两项设置的临时用户，通用设置显示“插话发送”“简洁”。
- `saved-choices.png`：在真实设置页改选“排队发送”“详细”，重新加载页面后仍显示这两个选择。复制页面实际写出的个人配置，在另一隔离临时容器执行同一升级命令后，`cmp` 确认文件逐字节不变。

自动检查覆盖新用户、空配置、只有旧工作步骤配置、缺少 config 的条目、分别或同时保存两项偏好、动态表达式、重复升级，以及不传网页选项的桌面启动。相关十项检查全部通过：

```sh
docker run --rm --network none --cpus 1 --memory 512m \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" \
  --entrypoint node zhaohua-partner:0.2.2-rc.1 \
  --expose-internals --experimental-vm-modules --test \
  '--test-name-pattern=Web defaults|desktop refresh|work-step display|new and existing company profiles|shared refresh|first startup|configuration refresh|refresh replaces' \
  /repo/crysound/tests/company-config.test.mjs
```

整份 `company-config.test.mjs` 共十九项，十八项通过；已有“refresh web limits”用例把 YAML 的 `!!js` 地址表达式以字符串传给网页工具校验器，报 `Invalid URL`。把测试文件及升级器同时换回本分支基线版本后，该用例同样失败；本次未修改网页工具或该用例。新增三项检查全部通过，不能把整份检查说成全绿。

复现截图环境（从已有镜像启动，不构建）：

```sh
docker run --rm --name partner-preferences-193 --cpus 1 --memory 768m \
  -p 127.0.0.1:18993:3080 \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" \
  --entrypoint sh zhaohua-partner:0.2.2-rc.1 /repo/crysound/tests/web-preferences-ui.sh
```

用浏览器打开命令打印的临时登录链接，打开账号菜单中的设置，滚到“繁忙时的发送行为”和“性能与用量”。脚本使用仓库规定的网页目录选择器覆盖层。静态截图展示设置状态，本次未录 GIF。

已核对固定版本原生输入策略：支持插话的运行中会话按 Enter 使用首选行为，Cmd/Ctrl+Enter 使用另一行为；原生统计组件在 compact 模式下仅保留可用的输出速度与缓存命中，隐藏统计弹窗和每轮用量。本轮没有在有模型的运行中会话里实测这些路径，仍须伙伴助理上线后验收：先核对负责人和一个未改设置的测试账号，再核对已选过旧值的账号，实际验证快捷键和输入框下方统计。桌面默认保持不变已由配置检查覆盖，未启动 Electron。
