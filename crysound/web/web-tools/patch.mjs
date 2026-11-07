// Patch only the pinned release during the image build. Unexpected upstream code stops the build.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const patches = [
  {
    package: "@deepseek-ai/dsh-tool-web",
    import: '// crysound: allow both bounded search attempts before the tool deadline.\n',
    extraImport: 'import { fetchPage } from "./crysound-fetch-pipeline.mjs";\nimport { validateSummaryConfig } from "./crysound-summary.mjs";\nimport { credentialRef } from "@deepseek-ai/dsh-credentials";\nimport { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";\nimport { appendPluginRecord } from "@deepseek-ai/dsh-session";\n',
    edits: [{
      from: 'description: "Search the web for current information. Returns an optional summary answer and a list of source URLs.",',
      to: 'description: "Search the web for current information. Returns an optional summary answer and source URLs. If the answer or source summaries provide sufficient evidence, answer directly with available citations; do not web_fetch the same sources merely to confirm them. Fetch only to fill a specific evidence gap, such as original text, details or tables, or to meet the requested source count.",',
    }, {
      from: 'searchTimeoutMs: z.number().default(DEFAULT_WEB_TOOL_TIMEOUT_MS)',
      previous: 'searchTimeoutMs: z.number().default(65_000)',
      to: 'searchTimeoutMs: z.number().default(18_000)',
    }, {
      from: 'fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS)',
      to: 'fetchMaxOutputChars: z.number().default(DEFAULT_FETCH_MAX_OUTPUT_CHARS),\n\tfetchSummary: z.boolean().default(true),\n\tfetchSummaryModel: z.string().default("deepseek/deepseek-flash"),\n\tfetchSummaryBaseURL: z.string().default(""),\n\tfetchSummaryTimeoutMs: z.number().default(2_000),\n\tfetchSummaryMaxTokens: z.number().default(1600),\n\tfetchSummaryMinChars: z.number().default(12000),\n\tfetchTreg: z.boolean().default(true),\n\tfetchDirectTimeoutMs: z.number().default(1500),\n\tfetchTregTimeoutMs: z.number().default(8000),\n\tfetchTotalTimeoutMs: z.number().default(9500),\n\tfetchDeepSeek: z.boolean().default(true),\n\tfetchDeepSeekTimeoutMs: z.number().default(8000),\n\tfetchDeepSeekMinChars: z.number().default(80)',
    }, {
      from: 'function applyWebFetchTool(ctx, timeoutMs, maxOutputChars) {',
      to: 'function applyWebFetchTool(ctx, timeoutMs, maxOutputChars, summaryConfig = { fetchSummary: false }) {',
    }, {
      from: 'if (resolved.fetch) applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars);',
      to: 'validateSummaryConfig(resolved);\n\tif (resolved.fetch) applyWebFetchTool(ctx, resolved.fetchTimeoutMs, resolved.fetchMaxOutputChars, resolved);',
    }, {
      from: 'description: "Fetch the content of a specific HTTP(S) URL and return it decoded to text.",',
      previous: 'description: "Fetch a specific HTTP(S) URL. Supply prompt with the information you need to receive a focused summary with key quotes and numbers; without prompt returns bounded page text.",',
      to: 'description: "Fetch a specific HTTP(S) URL when original text, details or tables are needed, or to fill another specific evidence gap. If a web_search answer or source summaries are sufficient, answer directly without fetching the same sources. Supply prompt with the information you need to receive a focused summary with key quotes and numbers; without prompt returns bounded page text.",',
    }, {
      from: 'description: "The HTTP(S) URL to fetch."\n\t\t} },',
      to: 'description: "The HTTP(S) URL to fetch."\n\t\t}, prompt: { type: "string", description: "The question or specific information to extract from this page. Prefer providing this for web research." } },',
    }, {
      from: 'function parseFetchArgs(args) {',
      to: 'function parseFetchArgs(args) {\n\tif (args.prompt !== void 0 && typeof args.prompt !== "string") throw new Error("prompt must be a string");',
    }, {
      from: 'const result = await ctx.web.fetch({ url: input.url }, exec.signal);',
      to: 'const result = await fetchPage(ctx, summaryConfig, { url: input.url }, args.prompt, value => renderFetchOutput(value, maxOutputChars), exec.signal, { credentialRef, launchEnvironmentOf, appendPluginRecord, request: fetch });',
    }, {
      from: 'timeoutMs,\n\t\tisConcurrencySafe: () => true,\n\t\tasync execute(args, exec) {\n\t\t\tconst input = parseFetchArgs(args);',
      to: 'timeoutMs: (summaryConfig.fetchTreg || summaryConfig.fetchDeepSeek) ? summaryConfig.fetchTotalTimeoutMs + 500 : timeoutMs + (summaryConfig.fetchSummary ? summaryConfig.fetchSummaryTimeoutMs : 0),\n\t\tisConcurrencySafe: () => true,\n\t\tasync execute(args, exec) {\n\t\t\tconst input = parseFetchArgs(args);',
    }],
    files: { "summary.mjs": "crysound-summary.mjs", "fetch-pipeline.mjs": "crysound-fetch-pipeline.mjs", "gateway-fetch.mjs": "crysound-gateway-fetch.mjs", "network.mjs": "network.mjs" },
  },
  {
    package: "@deepseek-ai/dsh-web-search-deepseek",
    import: 'import { searchWithFallback } from "./crysound-search.mjs";\n',
    extraImport: 'import { searchAnswer } from "./crysound-search.mjs";\n',
    additionalImports: ['import { resolveSearchBudget } from "./crysound-search.mjs";\n'],
    edits: [{
      from: 'maxUses: z.number().step(1).min(1).default(5).volatile()\n',
      to: 'maxUses: z.number().step(1).min(1).default(5).volatile(),\n\tsearchTotalTimeoutMs: z.number().step(1).min(1).default(18_000).volatile(),\n\tsearchApiTimeoutMs: z.number().step(1).min(1).default(4_000).volatile(),\n\tsearchFlashTimeoutMs: z.number().step(1).min(1).default(12_000).volatile(),\n\tsearchLunaReserveMs: z.number().step(1).min(1).default(6_000).volatile()\n',
    }, {
      from: 'const options = () => resolveOptions(ctx, {',
      to: 'const options = () => ({ ...resolveOptions(ctx, {',
    }, {
      from: '\t});\n\tconst provider = new DeepSeekSearchProvider(options);',
      to: '\t}), searchBudget: resolveSearchBudget({ searchTotalTimeoutMs: config.searchTotalTimeoutMs.get(), searchApiTimeoutMs: config.searchApiTimeoutMs.get(), searchFlashTimeoutMs: config.searchFlashTimeoutMs.get(), searchLunaReserveMs: config.searchLunaReserveMs.get() }) });\n\toptions();\n\tconst provider = new DeepSeekSearchProvider(options);',
    }, {
      from: 'search: (request, signal) => provider.search(request, signal)',
      previous: 'search: (request, signal) => searchWithFallback(DeepSeekSearchProvider, WebError, options(), ctx.get("agents")?.currentInitiator()?.model.current()?.model, request, signal)',
      to: 'search: (request, signal) => searchWithFallback(DeepSeekSearchProvider, WebError, options(), request, signal)',
    }, {
      from: 'return mapAnthropicResponse(await response.json());',
      to: 'return searchAnswer(await response.json(), mapAnthropicResponse);',
    }],
    files: { "search.mjs": "crysound-search.mjs" },
  },
  {
    package: "@deepseek-ai/dsh-web-fetch-http",
    import: 'import { companyFetcher, renderOptions } from "./crysound-fetch.mjs";\n',
    edits: [{
      from: 'userAgent: z.string().default(DEFAULT_USER_AGENT)\n',
      to: 'userAgent: z.string().default(DEFAULT_USER_AGENT),\n\trenderConcurrency: z.number().default(1),\n\trenderTimeoutMs: z.number().default(2_000)\n',
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
      if (alreadyPatched && after.split(to).length === 2 && !after.replace(to, "").includes(from)) continue;
      if (alreadyPatched && previous && after.split(previous).length === 2 && !after.includes(from) && !after.includes(to)) {
        after = after.replace(previous, to);
        continue;
      }
      if (after.split(from).length !== 2 || after.includes(to)) throw new Error(`Web tools patch did not match exactly once: ${patch.package}: ${from.slice(0, 100)}`);
      after = after.replace(from, to);
    }
    if (!alreadyPatched) after = patch.import + after;
    for (const extraImport of [patch.extraImport, ...(patch.additionalImports ?? [])].filter(Boolean)) {
      if (!after.includes(extraImport)) after = patch.import + extraImport + after.slice(patch.import.length);
    }
    for (const [source, destination] of Object.entries(patch.files)) {
      const target = path.join(directory, "lib", destination);
      let content = fs.readFileSync(path.join(here, source), "utf8");
      for (const [local, copied] of Object.entries(patch.files)) content = content.replaceAll(`"./${local}"`, `"./${copied}"`);
      content = content.replaceAll('"./timing.mjs"', JSON.stringify(new URL("./timing.mjs", import.meta.url).href));
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
