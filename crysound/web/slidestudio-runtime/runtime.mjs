import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PINNED_PLAYWRIGHT_VERSION = "1.61.1";
const PINNED_CHROMIUM_REVISION = "1228";
const BROWSER_DIR_NAME = "chromium_headless_shell-1228";
const root = fileURLToPath(new URL(".", import.meta.url));
const MODULE_DIR = join(root, "node_modules");
const BROWSERS_DIR = join(root, "browsers");
const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || BROWSERS_DIR;
const chromiumRoot = join(browsersPath, BROWSER_DIR_NAME);
const modulePath = join(MODULE_DIR, "playwright", "index.mjs");
const packagePath = join(MODULE_DIR, "playwright", "package.json");
const EXECUTABLE_NAMES = new Set([
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "headless_shell.exe",
  "chrome",
  "Chromium",
  "chrome.exe",
]);

function findExecutable(directory) {
  if (!existsSync(directory)) return "";
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findExecutable(p);
      if (found) return found;
    } else if (entry.isFile() && EXECUTABLE_NAMES.has(entry.name)) {
      return p;
    }
  }
  return "";
}

export const pinnedRuntime = Object.freeze({
  playwrightVersion: PINNED_PLAYWRIGHT_VERSION,
  chromiumRevision: PINNED_CHROMIUM_REVISION,
  root,
  browsersPath,
  modulePath,
  packagePath,
  executablePath: existsSync(chromiumRoot) ? findExecutable(chromiumRoot) : "",
});

export function verifyPinnedRuntime() {
  if (!existsSync(packagePath)) throw new Error("Pinned Playwright package is missing: " + packagePath);
  const packageData = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageData.version !== pinnedRuntime.playwrightVersion) {
    throw new Error(
      "Pinned Playwright version mismatch: expected " +
        pinnedRuntime.playwrightVersion +
        ", found " +
        packageData.version,
    );
  }
  if (!pinnedRuntime.executablePath || !existsSync(pinnedRuntime.executablePath)) {
    throw new Error("Pinned Chromium executable is missing under " + chromiumRoot);
  }
  if (!pinnedRuntime.executablePath.includes(BROWSER_DIR_NAME)) {
    throw new Error(
      "Pinned Chromium executable resolved outside " + BROWSER_DIR_NAME + ": " + pinnedRuntime.executablePath,
    );
  }
  return pinnedRuntime;
}

export async function launchPinnedChromium(options = {}) {
  verifyPinnedRuntime();
  if (options.headless === false) throw new Error("SlideStudio render_page Playwright runtime is headless-only.");
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
  const { chromium } = await import(pathToFileURL(modulePath).href);
  return chromium.launch({ ...options, headless: true, executablePath: pinnedRuntime.executablePath });
}

export async function loadPinnedPlaywright() {
  verifyPinnedRuntime();
  return import(pathToFileURL(modulePath).href);
}
