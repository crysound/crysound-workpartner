import { readFileSync } from "node:fs";

/** Compare monotonic timestamps within each process, attempt and tool call. @param records Parsed timing JSONL. @returns One summary per call, retaining absent stages as null. */
export function timingReport(records) {
  const calls = new Map();
  for (const record of records) {
    const key = JSON.stringify([record.processStartTime, record.pid, record.session, record.attempt, record.turn, record.step, record.callId]);
    if (!calls.has(key)) calls.set(key, []);
    calls.get(key).push(record);
  }
  return [...calls.values()].map(records => {
    const { session, turn, step, attempt, callId, name, pid, processStartTime } = records[0];
    const first = stage => records.find(record => record.stage === stage)?.monotonicMs;
    const between = (from, to) => first(from) === undefined || first(to) === undefined ? null : first(to) - first(from);
    const required = ["block-end", "finish", "assistant-message-written", "tools-execute-start", "tool-result-returned"];
    if (name === "web_search") required.push("search-request-record", "search-request-dispatch");
    return {
      session, turn, step, attempt, callId, name, pid, processStartTime,
      missing: required.filter(stage => first(stage) === undefined),
      durationsMs: {
        blockToFinish: between("block-end", "finish"),
        finishToStreamEnd: between("finish", "stream-end"),
        streamEndToAppend: between("stream-end", "assistant-message-append-start"),
        assistantAppend: between("assistant-message-append-start", "assistant-message-written"),
        appendToExecute: between("assistant-message-written", "tools-execute-start"),
        executeToToolDispatch: between("tools-execute-start", "tool-dispatch-start"),
        executeToFirstSearch: between("tools-execute-start", "search-request-dispatch"),
        firstSearchToResult: between("search-request-dispatch", "tool-result-returned"),
      },
      searchAttempts: records.filter(record => record.stage === "search-request-dispatch").map(record => {
        const logged = records.find(candidate => candidate.stage === "search-request-record" && candidate.searchAttempt === record.searchAttempt);
        return {
          attempt: record.searchAttempt,
          afterExecuteMs: first("tools-execute-start") === undefined ? null : record.monotonicMs - first("tools-execute-start"),
          recordToDispatchMs: logged === undefined ? null : record.monotonicMs - logged.monotonicMs,
        };
      }),
    };
  });
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: node timing-report.mjs <timing.jsonl>");
  for (const report of timingReport(readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)))) {
    console.log(JSON.stringify(report));
  }
}
