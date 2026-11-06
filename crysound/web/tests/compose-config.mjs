// 只展开 compose；隔离 .env、Docker 配置和宿主环境，不连接 Docker 服务。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "zp-compose-test-"));
try {
  const file = path.join(root, "fake.env");
  fs.writeFileSync(file, `PUBLIC_HOST=partner.example.test\nPARTNER_DATA=${root}/data\nPARTNER_SECURE=${root}/fake-secure\nPARTNER_FEISHU_APP_ID=cli_fake\nPILOT_CHAT_ID=oc_fake\nMARKET_ADMINS=alice,bob\n`);
  const result = spawnSync("docker", ["compose", "--env-file", file, "-f", fileURLToPath(new URL("../compose.yml", import.meta.url)), "config", "--format", "json"], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, DOCKER_CONFIG: root, COMPOSE_DISABLE_ENV_FILE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const registry = config.services.verdaccio;
  assert.equal(registry.image, "verdaccio/verdaccio:6.1.6");
  assert.equal(registry.ports, undefined);
  assert.deepEqual(Object.keys(registry.networks), ["partner-net"]);
  assert.ok(registry.volumes.some((v) => v.source === `${root}/data/npm` && v.target === "/verdaccio/storage"));
  assert.equal(config.services.gateway.environment.MARKET_ADMINS, "alice,bob");
  console.log("compose config：临时假 .env 展开成功；Verdaccio 仅 partner-net、无映射端口、数据目录正确。");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
