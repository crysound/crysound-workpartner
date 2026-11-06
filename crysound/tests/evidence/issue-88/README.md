# 网页默认自动审查验收证据

截图来自已有固定版本镜像的独立临时容器，应用本 PR 的真实发布模块补丁后，以受支持的 `dsh --profile web` 启动；不是界面模拟或线上截图。没有模型凭据，没有发起模型请求。浏览器沿用手册指定的持久 CDP 入口，在本轮新建的标签页访问临时本地端口。初次选择工作区使用仓库指定的网页目录选择器覆盖层。

- `new-session.png`：未保存个人默认权限，选择目录后创建首个会话，输入框显示自动审查，未出现启用确认。
- `default-options.png`：通用设置显示自动审查，下拉有四种默认权限。
- `manual-confirmation.png`：已有工作区内修改会话手动切向自动审查，仍显示上游实验确认；此次取消，没有批准任何工具调用。

页面另已实际选择工作区内修改、再选择自动审查，核对个人 YAML 的唯一默认字段依次保存对应值；当前会话保持原权限。未来会话采用更新设置由真实权限服务测试覆盖。

复现（不装依赖、不建镜像）：

```sh
docker run --rm --network none --cpus 1 --memory 512m \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" \
  --entrypoint node zhaohua-partner:0.2.2-rc.1 \
  --test /repo/crysound/tests/web-auto-review.test.mjs

docker run --rm --name partner-auto-review-ui --cpus 1 --memory 768m \
  -p 127.0.0.1:18888:3080 \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" \
  --entrypoint sh zhaohua-partner:0.2.2-rc.1 \
  /repo/crysound/tests/web-auto-review-ui.sh
```

第二条打印的登录链接只用于本地临时环境。浏览器打开该链接，关闭无模型时的开始使用提示，通过选择工作区选择临时容器内目录，核对输入框和设置。停止后删除的只有该临时容器自身的测试数据。

待伙伴助理验收：重建完整网页镜像，在独立测试账号验证普通读写无需本人审批、删除预先存在目录被审查拒绝并转本人审批、默认值切回其他模式后新会话生效。该阶段应使用可丢弃的专用目录并保留拒绝/审批证据。没有把本机无模型页面检查说成模型行为已验收。桌面覆盖限于未修补运行时的真实权限默认服务，没有启动 Electron。PR 使用静态截图展示默认值和确认窗口，未录制 GIF。
