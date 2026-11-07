import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { instrumentTiming, timingTargets } from "./timing-patch.mjs";
import { toolTiming } from "./timing.mjs";

toolTiming.open(process.env.CRYSOUND_TOOL_TIMING_LOG);
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith("file:")) return result;
    const file = fileURLToPath(url);
    const target = timingTargets.find(target => file.endsWith(`/node_modules/${target.package}/lib/${target.file}`));
    if (!target) return result;
    const manifest = JSON.parse(readFileSync(join(dirname(file), "../package.json"), "utf8"));
    if (manifest.version !== "0.2.2-rc.1") throw new Error(`Tool timing needs review for ${target.package}@${manifest.version}`);
    const source = typeof result.source === "string" ? result.source : Buffer.from(result.source).toString("utf8");
    return { ...result, source: instrumentTiming(target.package, source) };
  },
});
