// Patch only the pinned release during the image build. Unexpected upstream code stops the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const patches = [
  {
    package: "@deepseek-ai/dsh-tool-web",
    import: '// crysound: allow both bounded search attempts before the tool deadline.\n',
    edits: [{
      from: 'searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS)',
      to: 'searchTimeoutMs: z.number().default(65_000)',
    }],
    files: {},
  },
  {
    package: "@deepseek-ai/dsh-web-search-deepseek",
    import: 'import { searchWithFallback } from "./crysound-search.mjs";\n',
    edits: [{
      from: 'search: (request, signal) => provider.search(request, signal)',
      previous: 'search: (request, signal) => searchWithFallback(DeepSeekSearchProvider, WebError, options(), ctx.get("agents")?.currentInitiator()?.model.current()?.model, request, signal)',
      to: 'search: (request, signal) => searchWithFallback(DeepSeekSearchProvider, WebError, options(), request, signal)',
    }],
    files: { "search.mjs": "crysound-search.mjs" },
  },
  {
    package: "@deepseek-ai/dsh-web-fetch-http",
    import: 'import { companyFetcher, renderOptions } from "./crysound-fetch.mjs";\n',
    edits: [{
      from: 'userAgent: z.string().default(DEFAULT_USER_AGENT)\n',
      to: 'userAgent: z.string().default(DEFAULT_USER_AGENT),\n\trenderConcurrency: z.number().default(1),\n\trenderTimeoutMs: z.number().default(15_000)\n',
    }, {
      from: 'ctx.web.registerFetchProvider(new HttpFetchProvider(limits));',
      to: 'ctx.web.registerFetchProvider(companyFetcher(HttpFetchProvider, WebError, limits, renderOptions(resolved)));',
    }],
    files: { "fetch.mjs": "crysound-fetch.mjs", "network.mjs": "network.mjs" },
  },
];

/** Patch the pinned runtime without changing shared hardlinks. @param root Runtime node_modules. @returns Nothing; mismatches throw and stop the image build. */
export function patchWebTools(root) {
  for (const patch of patches) {
    const directory = path.join(root, patch.package);
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    if (manifest.version !== "0.2.2-rc.1") throw new Error(`Web tools patch needs review for ${patch.package}@${manifest.version}`);
    const file = path.join(directory, "lib/index.js");
    const before = fs.readFileSync(file, "utf8");
    let after = before;
    const alreadyPatched = before.startsWith(patch.import);
    for (const { from, previous, to } of patch.edits) {
      if (alreadyPatched && after.split(to).length === 2 && !after.includes(from)) continue;
      if (alreadyPatched && previous && after.split(previous).length === 2 && !after.includes(from) && !after.includes(to)) {
        after = after.replace(previous, to);
        continue;
      }
      if (alreadyPatched || after.split(from).length !== 2 || after.includes(to)) throw new Error(`Web tools patch did not match exactly once: ${patch.package}`);
      after = after.replace(from, to);
    }
    if (!alreadyPatched) after = patch.import + after;
    for (const [source, destination] of Object.entries(patch.files)) {
      const target = path.join(directory, "lib", destination);
      const content = fs.readFileSync(path.join(here, source), "utf8");
      // Avoid modifying any shared pnpm hardlink.
      if (fs.existsSync(target)) fs.unlinkSync(target);
      fs.writeFileSync(target, content, { mode: 0o644 });
    }
    if (after !== before) { fs.unlinkSync(file); fs.writeFileSync(file, after, { mode: 0o644 }); }
  }
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: node patch.mjs <runtime node_modules>");
  patchWebTools(process.argv[2]);
}
