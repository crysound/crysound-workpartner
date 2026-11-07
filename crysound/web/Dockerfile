FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates python3 ripgrep iproute2 librsvg2-bin \
 && rm -rf /var/lib/apt/lists/* \
 && npm i -g @deepseek-ai/dsh@0.2.2-rc.1 pnpm@10 && npm cache clean --force
# The same pinned npm native payload ships in desktop installers; no plugin is enabled here.
COPY mnemon/ /opt/partner/mnemon-build/
RUN node /opt/partner/mnemon-build/prepare.mjs /opt/partner/mnemon \
 && node /opt/partner/mnemon-build/smoke.mjs /opt/partner/mnemon/bin
ENV PATH="/opt/partner/mnemon/bin:${PATH}"
# 公司市场标签在打包时修补；运行中的普通用户不写全局运行时。
COPY scripts/patch-official-plugins.mjs /opt/partner/scripts/
COPY scripts/patch-market-*.mjs /opt/partner/scripts/
COPY config/plugins.json /opt/partner/config/plugins.json
COPY brand/market-locales.mjs /opt/partner/brand/market-locales.mjs
RUN node /opt/partner/scripts/patch-official-plugins.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
RUN node /opt/partner/scripts/patch-market-ui.mjs --runtime "$(npm root -g)/@deepseek-ai/dsh/node_modules"
# Sidebar and skin #133 ship together; this patch also runs before Desktop integrity manifests.
COPY scripts/patch-sidebar.mjs scripts/sidebar-policy.mjs /opt/partner/scripts/
RUN node /opt/partner/scripts/patch-sidebar.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
# Neutral running indicator shared with the next Desktop package.
COPY scripts/patch-running-status.mjs /opt/partner/scripts/
RUN node /opt/partner/scripts/patch-running-status.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
# Web containers use Auto review for an unset personal default; desktop artifacts are never patched here.
COPY scripts/patch-web-auto-review.mjs /opt/partner/scripts/
RUN node /opt/partner/scripts/patch-web-auto-review.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
# 固定公司插件包在构建时下载并校验；profile 只依赖本地文件。
COPY plugin-artifacts.mjs /opt/partner/plugin-artifacts.mjs
RUN node /opt/partner/plugin-artifacts.mjs download /opt/company-plugins \
 && chmod a+r /opt/company-plugins/*.tgz /opt/partner/plugin-artifacts.mjs
# 飞书命令放独立前缀，PATH 上只暴露公司用户身份包装器。
RUN npm install -g --prefix /opt/partner-clis @larksuite/cli@1.0.99 @lark-project/meegle@1.0.27 && npm cache clean --force
COPY feishu/ /opt/partner/feishu/
COPY config/skills/workpartner-help/ /opt/partner/skills/workpartner-help/
RUN chmod -R a+rX /opt/partner/skills
RUN node /opt/partner/feishu/setup.mjs > /opt/partner/feishu-skills-path \
 && chmod a+r /opt/partner/feishu.json /opt/partner/feishu-skills-path \
 && chmod -R a+rX /opt/partner/feishu /opt/partner/company /opt/partner-clis
ENV LARKSUITE_CLI_STRICT_MODE=user CRYSOUND_FEISHU_CONFIG=/data/.zp-feishu-cli.json
# 语音输入的识别模型（SenseVoice int8 + 静音检测）装进镜像，所有人共用这一份；地址与校验值取自 dsh 自带的模型清单。
RUN set -e; a=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/runtime/assets.json; \
 get() { mkdir -p "$1"; node -e 'const a=require(process.argv[1]);const x=process.argv[2].split(".").reduce((o,k)=>o[k],a);console.log(x.url,x.name,x.sha256)' "$a" "$2" \
   | { read url name sha; curl -fsSL --retry 3 "$url" -o "$1/$name"; echo "$sha  $1/$name" | sha256sum -c -; }; }; \
 get /opt/sensevoice/models/sensevoice-onnx models.int8; get /opt/sensevoice/models/sensevoice-onnx tokens; get /opt/sensevoice/models/silero vad; \
 chmod -R a+rX /opt/sensevoice
# SlideStudio 做幻灯片用的渲染浏览器（Playwright 1.61.1 + Chromium Headless Shell 1228，与插件固定版本一致）和中文字体，所有人共用这一份。
COPY web/slidestudio-runtime/ /opt/slidestudio-runtime/
RUN set -e; cd /opt/slidestudio-runtime; npm i --no-save --no-package-lock playwright@1.61.1; \
 PLAYWRIGHT_BROWSERS_PATH=/opt/slidestudio-runtime/browsers npx playwright install --with-deps --only-shell chromium; \
 apt-get install -y --no-install-recommends fonts-noto-cjk; rm -rf /var/lib/apt/lists/* /root/.npm; chmod -R a+rX /opt/slidestudio-runtime
ENV SLIDESTUDIO_PLAYWRIGHT_RUNTIME=/opt/slidestudio-runtime/runtime.mjs
# 视频剪辑（dsh-video-editor / hyperframes）用的 ffmpeg、ffprobe，浏览器复用上面那份共用的。
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg util-linux && rm -rf /var/lib/apt/lists/*
ENV HYPERFRAMES_FFMPEG_PATH=/usr/bin/ffmpeg HYPERFRAMES_FFPROBE_PATH=/usr/bin/ffprobe \
    HYPERFRAMES_BROWSER_PATH=/opt/slidestudio-runtime/browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell \
    PUPPETEER_EXECUTABLE_PATH=/opt/slidestudio-runtime/browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
# 公司搜索与抓取适配只改固定版本的发布产物；未命中即停止构建。
COPY web/web-tools/ /opt/partner/web-tools/
RUN node /opt/partner/web-tools/patch.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
RUN node /opt/partner/web-tools/timing-patch.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
# 公司动效复用同一份浏览器；口播和采样下载不随插件启用。
ENV OM_CHROME=/opt/slidestudio-runtime/browsers/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell OM_SAMPLES=off
# 品牌层：换网页图标、标签页标题和安装名，注入 brand.css / brand.js，以及新开通时自动启动飞书接入的 welcome.js。
# 图标地址带品牌文件的版本号：换图后飞书内置浏览器不会继续用缓存里的旧图。
COPY brand/ /tmp/brand/
RUN set -e; v=$(find /tmp/brand -maxdepth 1 -type f -print0 | sort -z | xargs -0 cat | md5sum | cut -c1-8); d=$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist; \
 cp /tmp/brand/zp-mark.svg /tmp/brand/zp-mark-32.svg /tmp/brand/favicon.svg /tmp/brand/favicon-dark.svg /tmp/brand/*.png $d/; \
 cp /tmp/brand/skin.css /tmp/brand/skin.js /tmp/brand/brand.css /tmp/brand/brand.js /tmp/brand/timezone.js /tmp/brand/pet.js /tmp/brand/welcome.js $d/; chmod 644 $d/zp-mark*.svg $d/favicon*.svg $d/brand.* $d/skin.* $d/timezone.js $d/pet.js $d/welcome.js; \
 sed -i -e 's#<title>DeepSeek Harness</title>#<title>兆华工作伙伴</title>#' \
        -e 's#content="DSH"#content="兆华工作伙伴"#' \
        -e 's#\(href="\./\(favicon[-a-z]*\.svg\|apple-touch-icon\.png\)\)"#\1?v='"$v"'"#g' \
        -e 's#</head>#<script src="./timezone.js?v='"$v"'"></script><script src="./skin.js?v='"$v"'"></script><script src="/_zp/preview/client.js"></script>  <link rel="stylesheet" href="./brand.css?v='"$v"'" />\n    <link rel="stylesheet" href="./skin.css?v='"$v"'" />\n    <script src="./brand.js?v='"$v"'" defer></script>\n    <script src="./welcome.js?v='"$v"'" defer></script>\n  </head>#' $d/index.html; \
 sed -i 's#\.svg")#.svg?v='"$v"'")#g' $d/brand.css; grep -q "zp-mark.svg?v=$v" $d/brand.css; \
 sed -i -e 's#"DeepSeek Harness"#"兆华工作伙伴"#g' -e 's#"DSH"#"兆华伙伴"#g' $d/manifest.webmanifest; \
 grep -q skin.js $d/index.html; grep -q skin.css $d/index.html; grep -q timezone.js $d/index.html; grep -q brand.js $d/index.html; grep -q welcome.js $d/index.html; chmod 644 $d/*.png; rm -rf /tmp/brand
# 公司配置由服务器目录挂载；Host 钩子属于固定运行时代码。
COPY host-hook.mjs /opt/partner/host-hook.mjs
RUN chmod 644 /opt/partner/host-hook.mjs
# 检出目录的权限随 umask 变化，这里统一放开，容器内的普通用户才能读和执行。
COPY config/plugin-patches.mjs /opt/partner/preview-plugin-patches.mjs
RUN node /opt/partner/preview-plugin-patches.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
COPY web/preview/ /opt/partner/preview/
RUN chmod -R a+rX /opt/partner/preview
COPY web/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 755 /usr/local/bin/entrypoint.sh
ENV NODE_OPTIONS="--import=/opt/partner/host-hook.mjs --import=/opt/partner/web-tools/timing-hook.mjs" CRYSOUND_MARKET_ORIGIN=http://zhaohua-partner-gateway:3090 CRYSOUND_MARKET_TOKEN_FILE=/data/.zp-market-token
ENV CRYSOUND_MARKET_REGISTRY=http://zhaohua-partner-gateway:3090/_zp/npm/ CRYSOUND_NPM_USERCONFIG=/data/.npmrc
ENV DSH_HOME=/data/.dsh DSH_TELEMETRY_DISABLED=1 HOME=/data
WORKDIR /data
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

# 原生市场卡片的兆华数据使用按钮；不新增标签或目录页。
COPY config/patch-data-use.mjs /opt/partner/patch-data-use.mjs
RUN node /opt/partner/patch-data-use.mjs "$(npm root -g)/@deepseek-ai/dsh/node_modules"
