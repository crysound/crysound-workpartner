import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Pinned published modules; source files and disabled runtime modules are never modified. */
export const timingTargets = [
  { package: "@deepseek-ai/dsh-agent-loop", file: "index.js" },
  { package: "@deepseek-ai/dsh-tools", file: "pipeline.js" },
  { package: "@deepseek-ai/dsh-web-search-deepseek", file: "index.js" },
];

/** Generate the enabled-only module in memory. @param name Published package. @param source Released JavaScript. @returns Instrumented JavaScript, or throws on upstream drift. */
export function instrumentTiming(name, source) {
  const edits = name === "@deepseek-ai/dsh-agent-loop" ? [
    ['let started = false;', 'const zpTiming = toolTiming.attempt(this.session.id, turn, step, live.attemptId);\n\t\t\tlet started = false;'],
    ['live.push(chunk);', 'zpTiming.chunk(chunk);\n\t\t\t\t\tlive.push(chunk);'],
    ['\n\t\t\t\t}\n\t\t\t\tsignal.throwIfAborted();\n\t\t\t} catch (error) {', '\n\t\t\t\t}\n\t\t\t\tzpTiming.mark("stream-end");\n\t\t\t\tsignal.throwIfAborted();\n\t\t\t} catch (error) {'],
    ['live.settle("assistant/message", () => this.session.append("assistant/message", {\n\t\t\t\t\tturn,', 'live.settle("assistant/message", () => zpTiming.append(() => this.session.append("assistant/message", {\n\t\t\t\t\tturn,'],
    ['}, { surfaceOp: "append" }).seq);\n\t\t\t\tif (finish.kind', '}, { surfaceOp: "append" }).seq));\n\t\t\t\tif (finish.kind'],
    ['const result = await this.loopCtx.tools.execute({', 'const result = await zpTiming.execute(() => this.loopCtx.tools.execute({'],
    ['toolSet: decision.toolSet\n\t\t\t\t\t});', 'toolSet: decision.toolSet\n\t\t\t\t\t}));'],
    ['if (!started) throw error;', 'zpTiming.flush();\n\t\t\t\tif (!started) throw error;'],
    ['if (!live.ended) live.abandon();\n\t\t\t\tthrow error;\n\t\t\t}', 'if (!live.ended) live.abandon();\n\t\t\t\tthrow error;\n\t\t\t} finally {\n\t\t\t\tzpTiming.flush();\n\t\t\t}'],
  ] : name === "@deepseek-ai/dsh-tools" ? [
    ['pipeline.dispatch(prepared.exec).then((outcome) => {', 'toolTiming.dispatch(prepared.exec, () => pipeline.dispatch(prepared.exec)).then((outcome) => {'],
    ['commit(block, result, callSeq) {', 'commit(block, result, callSeq) {\n\t\ttoolTiming.result(block.id, result.isError);'],
  ] : name === "@deepseek-ai/dsh-web-search-deepseek" ? [
    ['options.recordRequest?.({', 'toolTiming.search("search-request-record");\n\t\toptions.recordRequest?.({'],
    ['response = await fetch(endpoint, {', 'toolTiming.search("search-request-dispatch");\n\t\t\tresponse = await fetch(endpoint, {'],
  ] : undefined;
  if (!edits) throw new Error(`Unknown tool timing package: ${name}`);
  let after = source;
  for (const [from, to] of edits) {
    if (after.split(from).length !== 2) throw new Error(`Tool timing patch did not match exactly once: ${name}: ${from.slice(0, 80)}`);
    after = after.replace(from, to);
  }
  return `import { toolTiming } from ${JSON.stringify(new URL("./timing.mjs", import.meta.url).href)};\n` + after;
}

/** Validate all enabled-only edits at image build without writing published modules. @param root Runtime node_modules. @returns Nothing; drift stops the build. */
export function checkTimingRuntime(root) {
  for (const target of timingTargets) {
    const directory = join(root, target.package);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    if (manifest.version !== "0.2.2-rc.1") throw new Error(`Tool timing needs review for ${target.package}@${manifest.version}`);
    instrumentTiming(target.package, readFileSync(join(directory, "lib", target.file), "utf8"));
  }
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: node timing-patch.mjs <runtime node_modules>");
  checkTimingRuntime(process.argv[2]);
}
