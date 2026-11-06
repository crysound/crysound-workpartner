# 固定的官方技能

`official-skills.tar.gz` 只含官方技能及许可证，不含 CLI 二进制或凭据。网页镜像与桌面版本机模式使用同一归档，展开到公司管理的只读目录；不覆盖个人 AGENTS.md 和技能目录。公司技能 company-feishu 从 config/skills/company-feishu 同步装入归档；它对官方技能中的直接登录、切换身份和自动升级说明拥有优先级。

| 来源 | 版本 | 提交 |
| --- | --- | --- |
| https://github.com/larksuite/cli | 1.0.99 | 8d8357d39dd15ac5e9aa815d4ab2639d56bd3239 |
| https://github.com/larksuite/meegle-cli | 1.0.27 | 51b6c92fe7bab9f830db9f4bbf2739927c434815 |

更新归档使用 `repack-skills.py <larksuite/cli 检出> <larksuite/meegle-cli 检出>`。脚本核对提交后只选 skills/ 和许可证，输出稳定的 tar/gzip；CLI 版本同时在 Dockerfile 与 cli.mjs 固定。归档更改后桌面版使用新的只读版本目录，旧目录保留。
