// Exercise the pinned JS artifact, supplying only schema/host-service stubs rather than installing dsh.
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";
import { createRequire } from "node:module";

export class WebError extends Error {
  constructor(message, code, options) { super(message, options); this.code = code; }
}

export async function released(packageName, { fetch = globalThis.fetch, root = process.env.DSH_WEB_TOOLS_RELEASE_ROOT } = {}) {
  if (!root) throw new Error("Set DSH_WEB_TOOLS_RELEASE_ROOT to the pinned release node_modules (see README.md)");
  const file = join(root, "@deepseek-ai", packageName, "lib/index.js");
  const context = createContext({ console, fetch, AbortSignal, AbortController, DOMException, Response, URL, TextDecoder, Uint8Array, Symbol });
  const field = (fallback) => {
    const value = input => input === undefined ? fallback : input;
    value.default = fallback => field(fallback);
    for (const method of ["role", "volatile", "step", "min"]) value[method] = () => value;
    return value;
  };
  const schema = {
    string: () => field(), number: () => field(), boolean: () => field(),
    object: fields => input => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value(input[key])])),
  };
  const require = createRequire(join(process.env.DSH_WEB_TOOLS_RELEASE_ROOT ?? root, "@deepseek-ai/dsh-tool-web/lib/index.js"));
  const modules = {
    "@deepseek-ai/schemastery": { default: schema },
    "@deepseek-ai/dsh-web": { WebError },
    "@deepseek-ai/dsh-tools": { defineTool: value => value },
    "@deepseek-ai/dsh-output-retention": { truncateWithoutSplittingSurrogatePair: (value, max) => value.slice(0, max) },
    "turndown": { default: require("turndown") },
    "@joplin/turndown-plugin-gfm": require("@joplin/turndown-plugin-gfm"),
    "@deepseek-ai/dsh-util-values": { assertNever: value => { throw new Error(String(value)); } },
    "@deepseek-ai/dsh-credentials": { credentialRef: value => value },
    "@deepseek-ai/dsh-session": { appendPluginRecord: (session, type, data) => session.append(type, data) },
    "@deepseek-ai/dsh-launch-environment": { launchEnvironmentOf: ctx => ctx.environment },
    "@deepseek-ai/dsh-timeout": {
      deadline: (signal, milliseconds, code) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort({ code }), milliseconds);
        return { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, [Symbol.dispose]: () => clearTimeout(timer) };
      },
      timeoutOf: (signal, code) => signal.reason?.code === code ? signal.reason : undefined,
    },
  };
  const module = new SourceTextModule(await readFile(file, "utf8"), { context, identifier: file });
  await module.link(async specifier => {
    const exports = modules[specifier] ?? await import(pathToFileURL(join(dirname(file), specifier)).href);
    return new SyntheticModule(Object.keys(exports), function () {
      for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
    }, { context });
  });
  await module.evaluate();
  return module.namespace;
}
