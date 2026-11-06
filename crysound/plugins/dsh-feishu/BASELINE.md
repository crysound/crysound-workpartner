# 源码基线与本地维护

源码来自 https://github.com/fan56/dsh-feishu 的提交 5e5555d。上游 package.json 为 0.5.0，发布 CI 在打包前按 tag 改版本。对应 npm 包为 @aiwayds/dsh-feishu@0.17.0。

2026-11-06 在独立临时目录按上游 CI 执行 `npm install --no-audit --no-fund`，安装 latest/next 均指向的 dsh 0.2.2-rc.1，按 CI 对直接 @deepseek-ai 依赖固定版本，通过 `DSH_CLOSURE_DIR` 运行 `scripts/link-dsh-closure.mjs` 后执行 `npm run build`。环境：Node 22.23.3、npm 10.9.9、TypeScript 5.9.3。首次缺宿主类型的构建未用于验收；链接类型后的构建退出码为 0。

使用 `npm pack @aiwayds/dsh-feishu@0.17.0 --ignore-scripts` 下载发布包，在新建空目录解包，未执行包内代码。构建的 31 个 lib/*.js 与发布包同名文件全部逐字节一致，文件集合相同，无差异。

复核命令（在未修改的上游源码构建后执行）：

```sh
node scripts/compare-baseline.mjs /path/to/upstream/lib /path/to/unpacked/package/lib /tmp/comparison.json
```

提交内容保留上游源码、测试、LICENSE、NOTICE、CHANGELOG 与忽略规则，不含 .git、node_modules 或构建产物；不复制上游 .npmrc。公司修改说明见 NOTICE。包名保持不变以沿用同事 profile 的插件配置；plugins.json 暂不切换，本地版本号为 0.17.0-crysound.1。

本地验证与打包：先按上游方式安装依赖并链接 dsh 类型，再执行 `npm test` 和 `npm run check`，最后执行 `npm run build` 与 `npm pack --pack-destination /tmp/zp-codex/out`。lib/ 按上游 .gitignore 不提交，tarball 只留在仓库外。
