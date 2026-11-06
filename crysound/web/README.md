# 网页容器的公司配置

公司配置不进入网页镜像。服务器维护 `PARTNER_CONFIG` 目录，网关与每人容器都把它只读挂到 `/opt/partner-config`；`PARTNER_CONFIG` 是宿主机绝对路径，不是网关内路径。在 `crysound/web/.env` 同时设置 `MAGPIE_BASE_URL`，它必须是网页容器能访问的模型接口地址。桌面版仍从自己的登录网关访问模型。

目录里必须有这七个文件（包含当前市场功能需要的脚本和技能）：`plugins.json`、`partner.patch.yml`、`profile-upgrades.mjs`、`plugin-patches.mjs`、`market-profile.mjs`、`market-npmrc.mjs`、`skills/publish-zhaohua-market/SKILL.md`。从同一提交的 `crysound/config/` 同步，目录应允许容器用户遍历，文件应允许读取。不要放钥匙或个人资料：已开通的同事可以用桌面登录令牌通过 `GET /_zp/config/<文件名>` 读取这七个文件。接口不接受网页登录凭证，不提供写入，不缓存结果，也不提供目录内的其他文件。旧域名也继续提供这个接口。

每次启动按插件清单核对安装版本、执行插件补丁，并刷新公司 `magpie` 提供方的整个块（包括删除不再列出的模型）。个人其他提供方和自己选择的默认模型、推理等级保留；历史默认 GPT 未选等级时仍升级到中。提供方地址使用 `!!js` 从启动环境读取，不再构建时替换地址。非法个人 YAML 或动态的整个 `providers` 表达式无法安全修改时会报错，文件保持原样。

dsh 的 bundle、个人、全局和启动覆盖层按顺序生效，patch 的 `config` 整块替换（见 `packages/boot/app-boot/src/profile.ts` 和 `packages/boot/app-boot/src/config-schema/document.ts`）。旧个人配置会覆盖低优先级的公司层；高优先级的公司层会覆盖个人提供方，并使设置页无法保存该配置（`packages/boot/config-editor/src/index.ts`）。因此在不改上游的约束下，启动时在个人 YAML 的语法树上只替换 `providers.magpie`，保留其他节点、注释及 `!!js` 标签。首次默认值仍只写一次。公司网页搜索条目缺失时会补齐；每次启动按公司配置刷新搜索地址和模型，地址从启动环境读取，其他搜索选项保留。

桌面版启动时携带现有桌面登录令牌，从模型网关同源地址下载完整的七文件快照，使用独立临时目录，完成本次准备后清理。任何文件下载失败、超时、返回非成功响应或插件清单不合法，整份回退到安装包配置，不混用下载中的半份配置。断网回退可能恢复安装包中的旧插件版本和旧公司模型清单；重新联网并启动后重新取服务器配置。已开始应用后的插件安装失败沿用原有行为：记录日志，下次启动重试；配置刷新失败记日志，桌面壳继续启动。

## 飞书插件本地归档

飞书插件使用镜像内 `file:/opt/company-plugins/aiwayds-dsh-feishu-0.17.0-crysound.1.tgz`。构建脚本从固定发行地址下载，核对 SHA-512 后才写入镜像。启动时在任何 `plugin add` 前修复个人 `pnpm-lock.yaml` 及已有 `node_modules/.pnpm/lock.yaml` 中该旧远程地址缺失的校验值，再按新 want 替换；不清空锁文件、不修改其他插件的 resolution。已有校验值不匹配或 YAML 无效时停止启动并保留原文件。

本次必须重建镜像并同步清单，先验证独立测试账号，再逐人空闲时换镜像；不能只更新清单后重启旧镜像。Mac/Windows 下个安装包携带同一校验后的归档，桌面会将共享清单中的网页路径转换为 profile 内的相对文件依赖。旧桌面包不支持这个本地路径，需随新包更新。

轻量测试使用 Node 24 和已有 yaml：`node --test crysound/tests/plugin-artifacts.test.mjs`；默认从已有 dsh 运行时找 yaml，也可设置 `PARTNER_YAML_PACKAGE` 为已有 yaml 包路径。设置 `PARTNER_FEISHU_ARCHIVE` 为校验过的归档绝对路径后，覆盖桌面复制模板、旧版替换、重复启动和校验失败；不设时跳过需要真实归档的用例。

交付验证由伙伴助理在重建的镜像里执行 `node /repo/crysound/tests/plugin-install-smoke.mjs`（仓库只读挂到 `/repo`，使用临时 profile，允许测试安装联网，限一核、512 MiB）。它用真实 dsh/pnpm 检查有、无校验值两种旧锁的入口迁移，重复启动，以及后续 add、add、remove 后远程条目消失且本地 integrity 保留。打包后另跑既有 Mac 首启动冒烟；Windows 需在目标系统核对资源路径与旧版升级。

## 上线顺序

1. 保留旧网关提交、旧镜像标签和公司配置的副本；伙伴助理确认回退位置。以下步骤由伙伴助理在服务器执行，本 PR 不创建服务器目录或改正在使用的容器。
2. 建立 `.env` 的 `PARTNER_CONFIG` 目录，把同一提交的七个配置文件同步进去，设好目录遍历与文件读取权限，并填 `MAGPIE_BASE_URL`。使用完整目录挂载，后续可以原子替换目录内的单个文件；不要把挂载目录本身删除重建或换 inode。
3. 沿用现有市场配置（包括 `MARKET_ADMINS` 和内部注册表设置），先更新网关：`docker compose -f crysound/web/compose.yml config` 核对目录与只读挂载，再 `docker compose -f crysound/web/compose.yml up -d --force-recreate gateway`。核对有效桌面令牌能读七文件，缺失/过期令牌为 401，不在允许列表的文件为 404。旧用户容器此时继续使用原镜像中的配置。
4. 由伙伴助理构建一次新镜像，先用独立测试用户验证完整清单的插件安装与补丁、模型清单和个人提供方保留，再逐人空闲时用 `bin/upgrade-when-idle.sh <代号>` 重建。已有容器必须重建一次才能增加挂载；仅重启旧容器不会增加挂载。命令行开通和重建也读取相同 `.env`。
5. 发布包含本次桌面代码的安装包，分别核对网关可达时的公司配置和断网时的包内回退。本次不触发桌面构建。
6. 以后只变更清单、模型或补丁时，同步七个配置文件（来自同一提交，别在桌面启动下载时发布半份文件），然后安排已挂载目录的个人容器在空闲时重启即可，不需要重新构建镜像。重启前保留个人配置副本；公司 magpie 项会被刷新，其他提供方应保持。系统工具、dsh 或品牌变更仍需要镜像。

## 回退

仅配置有问题时，恢复挂载目录内七个文件的上一份完整副本，再安排空闲重启。新容器挂载路径不变。恢复旧模型配置前须确认旧默认模型仍可用；启动升级不会替用户改掉已经选定的模型。

需要回退代码时，先把新容器按空闲策略重建为保留的旧镜像（它自带旧配置），再把网关切回旧提交并重建。已写入的公司提供方要恢复到旧清单时，应先用修正后的挂载配置启动刷新，或者在旧版本重建前恢复此前备份的个人配置；不要用较早个人配置覆盖用户在此期间新增的提供方。新桌面版连接旧网关拿不到接口时会回退安装包配置。网关签名密钥与个人数据不作变更。

## 轻量自查

不安装仓库依赖，不构建镜像，使用已有运行时镜像执行针对性测试：

```sh
docker run --rm --network none --cpus 1 --memory 512m \
  --mount "type=bind,src=$PWD,dst=/repo,readonly" \
  --entrypoint node zhaohua-partner:0.2.2-rc.1 \
  --experimental-vm-modules --test /repo/crysound/tests/company-config.test.mjs
python3 crysound/tests/partner-user-mount.test.py
python3 crysound/tests/config-container-smoke.py
```

第一条验证没有生成 `lib/` 的源码依赖树仍可刷新配置，并用独立模块环境核对自助开通的 Docker 挂载请求，并测试令牌鉴权、读取白名单、配置更新、个人提供方保留、历史默认迁移、重复启动，以及桌面准备流程在线选新版和离线选包内版（插件安装器用本地假实现，不联网）。第二条核对命令行开通与重建的只读挂载及配置缺失时保留原容器。第三条在隔离的临时容器中，用已有镜像的真实 dsh 和挂载的新入口脚本核对启动、模型清单、个人提供方及缺配置时的退出；不更改正在使用的容器。完整五插件安装、补丁对真实插件的生效与打包后 Electron 验收留给伙伴助理的构建和上线核对。
