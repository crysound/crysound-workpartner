// With no log destination, install no loader and leave every runtime module unchanged.
if (process.env.CRYSOUND_TOOL_TIMING_LOG) await import("./timing-loader.mjs");
