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
    const fetchStages = {};
    for (const segment of ["direct", "download", "extract", "render", "summary-request", "open", "open-request"]) {
      const starts = [], spans = [];
      for (const record of records) {
        if (record.stage === `fetch-${segment}-start`) starts.push(record);
        if (record.stage === `fetch-${segment}-end`) {
          const start = starts.shift();
          spans.push({ durationMs: start ? record.monotonicMs - start.monotonicMs : null, outcome: record.outcome });
        }
      }
      for (const _start of starts) spans.push({ durationMs: null, outcome: "incomplete" });
      fetchStages[segment] = spans;
    }
    return {
      ...(name === "web_fetch" ? { fetchStages, fetchBranches: records.filter(record => /^fetch-.*-skip$/.test(record.stage)).map(({ stage, outcome }) => ({ stage, outcome })) } : {}),
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

/** Aggregate completed fetch stages without counting absent or unfinished stages as zero.
 * @param reports Per-call timing reports. @returns Stage distributions and branch counts.
 */
export function fetchTimingSummary(reports) {
  const stages = {}, branches = {};
  for (const report of reports) {
    for (const [name, spans] of Object.entries(report.fetchStages ?? {})) {
      const stage = stages[name] ??= { values: [], incomplete: 0, outcomes: {} };
      for (const span of spans) {
        if (span.durationMs === null) stage.incomplete++;
        else stage.values.push(span.durationMs);
        stage.outcomes[span.outcome ?? "completed"] = (stage.outcomes[span.outcome ?? "completed"] ?? 0) + 1;
      }
    }
    for (const { stage, outcome } of report.fetchBranches ?? []) {
      const key = `${stage}:${outcome}`;
      branches[key] = (branches[key] ?? 0) + 1;
    }
  }
  for (const [name, stage] of Object.entries(stages)) {
    stage.values.sort((a, b) => a - b);
    const quantile = fraction => stage.values.length ? stage.values[Math.ceil(stage.values.length * fraction) - 1] : null;
    stages[name] = { count: stage.values.length, incomplete: stage.incomplete, medianMs: quantile(0.5), p90Ms: quantile(0.9), outcomes: stage.outcomes };
  }
  return { calls: reports.filter(report => report.name === "web_fetch").length, stages, branches };
}

if (import.meta.main) {
  if (!process.argv[2]) throw new Error("Usage: node timing-report.mjs <timing.jsonl>");
  const reports = timingReport(readFileSync(process.argv[2], "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line)));
  if (process.argv.includes("--fetch-summary")) console.log(JSON.stringify(fetchTimingSummary(reports)));
  else for (const report of reports) console.log(JSON.stringify(report));
}
