// 桌面启动准备，使用现有登录文件，不另存本人令牌。
import path from "node:path";
import { prepareSkills, prepareWrappers, prepareSkillProfile } from "./setup.mjs";
const [company, identityFile, publicOrigin, execPath, patch, projectHost = ""] = process.argv.slice(2);
prepareSkills(company);
prepareWrappers({ kind: "desktop", bin: path.join(company, "bin"), execPath, identityFile,
  tokenUrl: `${publicOrigin}/_zp/feishu/desktop-token`, authorizationUrl: `${publicOrigin}/_zp/feishu/`, meegleHost: projectHost }, path.join(company, "feishu.json"));
prepareSkillProfile(patch);
