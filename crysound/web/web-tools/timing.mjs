import { AsyncLocalStorage } from "node:async_hooks";
import { constants, openSync, fstatSync, writeSync, closeSync } from "node:fs";
import { isAbsolute } from "node:path";

class ToolTiming {
  context = new AsyncLocalStorage();
  fd;

  open(file) {
    if (!isAbsolute(file)) throw new Error("CRYSOUND_TOOL_TIMING_LOG must be an absolute path");
    if (this.fd !== undefined) closeSync(this.fd);
    this.fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
    const stat = fstatSync(this.fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      closeSync(this.fd);
      this.fd = undefined;
      throw new Error("Tool timing log must be an owner-only regular file owned by this user");
    }
  }

  attempt(session, turn, step, attempt) {
    const records = [], calls = new Map();
    const identity = { version: 1, pid: process.pid, processStartTime: performance.timeOrigin, session, turn, step, attempt };
    const mark = (stage, callId, extra = {}) => {
      const monotonicMs = performance.now();
      for (const [id, name] of callId === undefined ? calls : [[callId, calls.get(callId)]]) {
        records.push({ ...identity, callId: id, name, stage, monotonicMs, time: performance.timeOrigin + monotonicMs, ...extra });
      }
    };
    return {
      mark,
      chunk(chunk) {
        if (chunk.type === "block-end" && chunk.block.type === "tool-call") {
          calls.set(chunk.block.id, chunk.block.name);
          mark("block-end", chunk.block.id);
        } else if (chunk.type === "finish") mark("finish");
      },
      append(operation) {
        mark("assistant-message-append-start");
        const result = operation();
        mark("assistant-message-written");
        return result;
      },
      execute: operation => {
        mark("tools-execute-start");
        return this.context.run({ mark }, operation);
      },
      flush: () => {
        if (records.length === 0) return;
        if (this.fd !== undefined) {
          try {
            const bytes = Buffer.from(records.map(record => JSON.stringify(record)).join("\n") + "\n");
            let offset = 0;
            while (offset < bytes.length) offset += writeSync(this.fd, bytes, offset);
          } catch (_error) {
            // Diagnostics must not fail an otherwise successful turn. Do not expose error paths or text.
            try { closeSync(this.fd); } catch (_closeError) { /* A failed sink is no longer used. */ }
            this.fd = undefined;
            console.warn("Tool timing log write failed; timing disabled for this process");
          }
        }
        records.length = 0;
      },
    };
  }

  dispatch(exec, operation) {
    const parent = this.context.getStore();
    if (!parent) return operation();
    parent.mark("tool-dispatch-start", exec.callId);
    return this.context.run({ ...parent, callId: exec.callId, searchAttempt: 0 }, () => operation().then(outcome => {
      parent.mark("tool-result-returned", exec.callId, { isError: outcome.result.isError === true });
      return outcome;
    }));
  }

  result(callId, isError) {
    this.context.getStore()?.mark("tool-result-finalized", callId, { isError: isError === true });
  }

  fetch(stage, outcome) {
    const context = this.context.getStore();
    if (this.fd === undefined || context?.callId === undefined) return;
    context.mark(`fetch-${stage}`, context.callId, outcome === undefined ? {} : { outcome });
  }

  exa(stage, extra = {}) {
    const context = this.context.getStore();
    if (context?.callId === undefined) return;
    context.mark(stage, context.callId, extra);
  }

  search(stage) {
    const context = this.context.getStore();
    if (context?.callId === undefined) return;
    if (stage === "search-request-record") context.searchAttempt++;
    context.mark(stage, context.callId, { searchAttempt: context.searchAttempt });
  }
}

/** Process-owned diagnostic sink; each async tool dispatch retains its own call identity. */
export const toolTiming = new ToolTiming();
