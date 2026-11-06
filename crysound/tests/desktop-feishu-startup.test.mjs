// Node 24, --experimental-vm-modules; no Electron launch or dependency installation.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { stripTypeScriptTypes } from "node:module";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const assets = resolve(import.meta.dirname, "..");
const desktop = resolve(assets, "../apps/desktop/src");
async function temp(t) {
  const root = await mkdtemp(join(tmpdir(), "partner-desktop-feishu-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
function run(args, env = process.env) {
  const result = spawnSync(process.execPath, args, { env, encoding: "utf8", timeout: 15000 });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

test("Finder startup keeps login-shell tools after prepending the company wrappers", {
  skip: process.platform === "win32" ? "Finder's executable probe uses a POSIX shebang" : false,
}, async (t) => {
  const root = await temp(t), shellBin = join(root, "shell-bin");
  await mkdir(shellBin);
  await writeFile(join(shellBin, "partner-path-probe"), `#!${process.execPath}\nconsole.log("login-shell tool available");\n`, { mode: 0o755 });
  const gui = { PATH: "/usr/bin:/bin" }, login = { PATH: `${shellBin}${delimiter}${gui.PATH}`, FROM_LOGIN_SHELL: "preserved" };
  const context = createContext({ process: { env: gui }, URL });
  const module = new SourceTextModule(stripTypeScriptTypes(await readFile(join(desktop, "crysound/partner.ts"), "utf8")), { context });
  const mocks = {
    electron: { app: { isPackaged: false, getPath: () => root, getAppPath: () => resolve(desktop, "..") }, BrowserWindow: class {}, session: {} },
    "../paths.ts": { resolveDesktopPaths: () => ({ profile: join(root, "profile") }) },
    "./npmrc.ts": { writeMarketNpmrc: async () => {} },
    "./origin.ts": { companyOrigin: () => "https://partner.example.test" },
  };
  await module.link(async (name) => {
    const exports = mocks[name] ?? await import(name);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
  });
  await module.evaluate();
  // Execute the actual main-process environment initialization and its awaited refresh.
  const main = await readFile(join(desktop, "main.ts"), "utf8");
  const start = main.indexOf("  let hostEnvironment:");
  assert.ok(start >= 0);
  const initialization = stripTypeScriptTypes(main.slice(start, main.indexOf("  let quitting =", start)));
  const initialize = new Function("process", "partner", "partnerHostEnvironment", "loginShell",
    `${initialization}\nreturn {initial: hostEnvironment, prepare: async () => { await prepareHostEnvironment(); return hostEnvironment; }};`);
  const state = initialize({ env: gui }, { token: "fake-token" }, module.namespace.partnerHostEnvironment, Promise.resolve(login));
  assert.equal(state.initial.PATH, `${join(root, "company/bin")}${delimiter}${gui.PATH}`);
  const environment = await state.prepare();
  assert.equal(environment.PATH, `${join(root, "company/bin")}${delimiter}${login.PATH}`);
  assert.equal(environment.FROM_LOGIN_SHELL, "preserved");
  const probe = spawnSync("partner-path-probe", [], { env: environment, encoding: "utf8", timeout: 15000 });
  assert.equal(probe.error, undefined);
  assert.equal(probe.signal, null);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "login-shell tool available");
});

test("installer validator accepts generated public settings and refuses private or malformed fields", async (t) => {
  const root = await temp(t), file = join(root, "public-host.json");
  const script = await readFile(join(assets, "scripts/verify-mac-package.sh"), "utf8");
  const match = script.match(/node -e '([\s\S]*?)' "\$res\/crysound\/config\/public-host.json"/);
  assert.ok(match, "execute the installer's actual public-config validator without mounting an image");
  const validate = () => run(["-e", match[1], file]);
  for (const projectHost of ["", "project.example.test"]) {
    const env = { ...process.env, PUBLIC_HOST: "partner.example.test", MEEGLE_HOST: projectHost };
    assert.equal(run([join(assets, "scripts/configure-public-host.mjs"), join(root, "no-deployment-env"), file], env).status, 0);
    assert.equal(validate().status, 0, `generated project host: ${projectHost}`);
  }
  await writeFile(file, JSON.stringify({ PUBLIC_HOST: "partner.example.test" }));
  assert.equal(validate().status, 0, "legacy one-field public config remains accepted");
  for (const value of [
    { PUBLIC_HOST: "https://partner.example.test" },
    { PUBLIC_HOST: "partner.example.test", MEEGLE_HOST: "https://project.example.test" },
    { PUBLIC_HOST: "partner.example.test", MEEGLE_HOST: 42 },
    { PUBLIC_HOST: "partner.example.test", APP_SECRET: "fake-private-value" },
  ]) {
    await writeFile(file, JSON.stringify(value));
    assert.notEqual(validate().status, 0, JSON.stringify(value));
  }
});
