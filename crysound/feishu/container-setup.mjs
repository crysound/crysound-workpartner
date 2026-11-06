// 每次容器启动只更新不含凭据的公共设置；只读公司技能和命令脚本来自镜像。
import fs from "node:fs";
import path from "node:path";
import { prepareSkillProfile } from "./setup.mjs";
const source = JSON.parse(fs.readFileSync("/opt/partner/feishu.json", "utf8"));
source.authorizationUrl = `https://${process.env.PUBLIC_HOST}/_zp/feishu/`;
source.meegleHost = process.env.MEEGLE_HOST || "";
const target = "/data/.zp-feishu-cli.json";
fs.writeFileSync(target, JSON.stringify(source), { mode: 0o600 });
fs.chmodSync(target, 0o600);
prepareSkillProfile(path.join(process.env.DSH_HOME, "profiles/web/cordis.patch.yml"));
