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
  fs.writeFileSync(file, `PUBLIC_HOST=partner.example.test\nPARTNER_DATA=${root}/data\nPARTNER_CONFIG=${root}/company-config\nMAGPIE_BASE_URL=http://models.example.test/v1\nPARTNER_SECURE=${root}/fake-secure\nPARTNER_FEISHU_APP_ID=cli_fake\nPILOT_CHAT_ID=oc_fake\nMARKET_ADMINS=alice,bob\n`);
  const result = spawnSync("docker", ["compose", "--env-file", file, "-f", fileURLToPath(new URL("../compose.yml", import.meta.url)), "config", "--format", "json"], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, DOCKER_CONFIG: root, COMPOSE_DISABLE_ENV_FILE: "1" },
  });
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  const gateway = config.services.gateway;
  assert.equal(gateway.environment.HOST_PARTNER_CONFIG, `${root}/company-config`);
  assert.equal(gateway.environment.TREG_MONTHLY_USD, "5");
  assert.ok(gateway.volumes.some((v) => v.target === "/app/treg-state.mjs" && v.read_only));
  for (const volume of gateway.volumes.filter((v) => v.type === "bind" && /^\/app\/.*\.mjs$/.test(v.target))) {
    assert.ok(fs.statSync(volume.source).isFile(), `gateway module mount missing: ${volume.target}`);
  }
  assert.equal(gateway.environment.MAGPIE_BASE_URL, "http://models.example.test/v1");
  const mount = gateway.volumes.find(volume => volume.target === "/opt/partner-config");
  assert.equal(mount.source, `${root}/company-config`);
  assert.equal(mount.read_only, true);
  assert.equal(mount.bind.create_host_path, false);
  const registry = config.services.verdaccio;
  assert.equal(registry.image, "verdaccio/verdaccio:6.1.6");
  assert.equal(registry.ports, undefined);
  assert.deepEqual(Object.keys(registry.networks), ["partner-net"]);
  assert.ok(registry.volumes.some((v) => v.source === `${root}/data/npm` && v.target === "/verdaccio/storage"));
  assert.equal(config.services.gateway.environment.MARKET_ADMINS, "alice,bob");
  assert.equal(config.services.gateway.ports.length, 1);
  assert.equal(config.services.gateway.ports[0].target, 3090);
  assert.equal(config.services.gateway.environment.FEISHU_USER_AUTH_ENABLED, "0");
  assert.ok(config.services.gateway.build.dockerfile.endsWith("web/gateway/Dockerfile"));
  console.log("compose config：临时假 .env 展开成功；Verdaccio 仅 partner-net、无映射端口、数据目录正确。");
} finally { fs.rmSync(root, { recursive: true, force: true }); }
