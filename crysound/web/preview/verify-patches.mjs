/** Verify patches against unpacked released packages, without installing dependencies or building. */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { installPreviewClient } from "./client.mjs";

const [browserPackage, ...artifactPackages] = process.argv.slice(2);
if (!browserPackage || !artifactPackages.length) throw new Error("Usage: node verify-patches.mjs <unpacked-browser-package> <unpacked-artifacts-package> [...]");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "preview-patches-"));
const patcher = fileURLToPath(new URL("../../config/plugin-patches.mjs", import.meta.url));
try {
  const browser = path.join(root, "@deepseek-ai/dsh-client-ui-sidebar-browser/lib/client.js");
  fs.mkdirSync(path.dirname(browser), { recursive: true }); fs.copyFileSync(path.join(browserPackage, "lib/client.js"), browser);
  for (const [index, artifact] of artifactPackages.entries()) {
    const dir = path.join(root, ".pnpm", `artifact-${index}`, "node_modules/dsh-claude-artifacts");
    fs.mkdirSync(dir, { recursive: true }); fs.cpSync(artifact, dir, { recursive: true });
  }
  execFileSync(process.execPath, [patcher, root]);
  const files = [browser, ...artifactPackages.map((_, index) => path.join(root, ".pnpm", `artifact-${index}`, "node_modules/dsh-claude-artifacts/lib/client.js"))];
  const first = files.map((file) => fs.readFileSync(file, "utf8"));
  execFileSync(process.execPath, [patcher, root]);
  for (const [index, file] of files.entries()) {
    assert.equal(fs.readFileSync(file, "utf8"), first[index], `second patch changed ${file}`);
    assert(first[index].includes("zp-preview-url"));
    execFileSync(process.execPath, ["--check", file]);
  }
  for (const [index, artifact] of artifactPackages.entries()) {
    const dir = path.join(root, ".pnpm", `artifact-${index}`, "node_modules/dsh-claude-artifacts");
    for (const entry of fs.readdirSync(artifact)) {
      if (entry === "lib") continue;
      // Skills, editors and license notices must remain byte-for-byte equal.
      const compare = (a, b) => {
        if (fs.statSync(a).isDirectory()) for (const child of fs.readdirSync(a)) compare(path.join(a, child), path.join(b, child));
        else assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b), a);
      };
      compare(path.join(artifact, entry), path.join(dir, entry));
    }
  }
  const runBrowser = (cloud) => {
    const listeners = new Map(), frames = [], calls = [], disposers = [];
    class Element {
      style = {}; dataset = {}; children = [];
      append(element) { this.children.push(element); if (element.tag === "iframe") frames.push(element); }
      remove() { const i = frames.indexOf(this); if (i >= 0) frames.splice(i, 1); }
      setAttribute(key, value) { this[key] = value; }
      addEventListener() {}
      closest() { return this.href ? this : null; }
    }
    const host = new Element();
    const document = {
      addEventListener(type, fn) { const values = listeners.get(type) || new Set(); values.add(fn); listeners.set(type, values); },
      removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
      dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); },
      querySelector: () => ({}), getElementById: () => host,
      createElement: (tag) => Object.assign(new Element(), { tag }), head: new Element(),
    };
    let api, body;
    const ctx = {
      effect(fn) { const dispose = fn(); if (typeof dispose === "function") disposers.push(dispose); },
      inject() {}, locale: { bind: () => (value) => value, register: () => () => {} },
      slots: { inject: (_name, fn) => fn(), register(spec) { if (spec.name === "sidebar.right.pane.tab") body = spec; return () => {}; } },
      sidebarRight: { openTabs: { getSnapshot: () => [{ sessionId: "s1", tabId: "t1" }] }, commandTarget: () => ({ sessionId: "s1" }),
        openTabIn: (...args) => calls.push(args) },
      sidebarRightTabs: { register: () => () => {} },
    };
    const store = {
      defineStore: (spec) => spec,
      createSnapshotStore(initial) {
        let state = initial; const subscribers = new Set();
        return { getSnapshot: () => state, subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
          set(value) { state = value; for (const fn of subscribers) fn(); } };
      },
    };
    const sandbox = { document, Element, URL, AbortController, console,
      CustomEvent: class { constructor(type, { detail }) { this.type = type; this.detail = detail; } },
      window: { __ModuleLoader__: { load({ factory }) { api = factory((name) => name === "@deepseek-ai/dsh-client-store" ? store : {}); } } },
    };
    vm.createContext(sandbox);
    if (cloud) vm.runInContext(`(${installPreviewClient.toString()})({previewHost:"preview.example.test",scope:"abc"})`, sandbox);
    vm.runInContext(first[0], sandbox); api.apply(ctx);
    const injected = body.inject("s1", { replace() {}, forget() {} });
    const lifetime = new AbortController();
    injected.mount({ tabId: "t1", signal: lifetime.signal, viewportId: "viewport", applicationOrigin: cloud ? "https://app.example.test" : "dsh-app://app",
      initial: undefined, initialUrl: "http://127.0.0.1:4710/slides/demo/?x=1#p2", openTab() {} });
    assert.equal(frames.length, 1);
    const frameUrl = frames[0].src;
    assert.equal(injected.keyedHooks.browserState("t1").getSnapshot().frame.target.kind, cloud ? "https" : "http");
    if (cloud) {
      const at = new URL(frameUrl); assert.equal(at.host, "preview.example.test");
      assert.equal(at.searchParams.get("owner"), "abc"); assert.equal(at.searchParams.get("port"), "4710");
      assert.equal(at.searchParams.get("path"), "/slides/demo/?x=1#p2");
      const anchor = Object.assign(new Element(), { href: "http://localhost:4710/slides/demo/" });
      let prevented = false;
      const click = { type: "click", target: anchor, button: 0, preventDefault() { prevented = true; }, stopImmediatePropagation() {} };
      for (const fn of listeners.get("click")) fn(click);
      assert(prevented); assert.equal(calls[0][0], "s1"); assert.equal(calls[0][1], "browser");
      assert.equal(calls[0][2].params.url, anchor.href);
      prevented = false; click.ctrlKey = true;
      for (const fn of listeners.get("click")) fn(click);
      assert(!prevented); assert.equal(calls.length, 1); assert.match(anchor.href, /^https:/);
      // Re-entering a saved rewritten URL must still load in the real Browser controller.
      injected.loadUrl("t1", anchor.href); assert.equal(frames.at(-1).src, anchor.href);
    } else assert.equal(frameUrl, "http://127.0.0.1:4710/slides/demo/?x=1#p2");
    lifetime.abort();
    return Promise.resolve(injected.dispose()).then(async () => { for (const dispose of disposers.reverse()) await dispose(); });
  };
  await runBrowser(true); await runBrowser(false);
  console.log(`Released Browser: iframe URL, saved URL, chat sidebar click, modifier new tab, local desktop unchanged: PASS`);
  console.log(`${files.length} released files: syntax and second-run idempotence PASS; artifact files outside lib unchanged`);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
