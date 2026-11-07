// Explicit live probe; use only an authorized test account's existing env.
// Logs counts and known protocol types, never credentials or response bodies.
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'base-env': { type: 'string' }, 'key-env': { type: 'string' },
  model: { type: 'string' }, json: { type: 'boolean', default: false },
} });
const base = process.env[values['base-env']];
const key = process.env[values['key-env']];
if (!base || !key || !values.model) {
  console.error('Provide --base-env <existing base URL variable> --key-env <existing key variable> --model <test account Claude route>; optionally --json');
  process.exit(2);
}
let endpoint;
try {
  endpoint = new URL(base.replace(/\/$/, '') + '/messages');
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
} catch {
  console.error('Base URL must be an HTTP(S) Messages API base without credentials, query or fragment');
  process.exit(2);
}
const knownTypes = new Set(['server_tool_use', 'web_search_tool_result', 'text', 'thinking', 'tool_use', 'web_search_result', 'web_search_tool_result_error']);
const counts = {};
const sources = new Set();
const citationSources = new Set();
let searchErrors = 0;
let terminal = false;
function inspect(block) {
  if (!block || typeof block !== 'object') return;
  if (knownTypes.has(block.type)) counts[block.type] = (counts[block.type] ?? 0) + 1;
  if (block.type === 'web_search_tool_result_error') searchErrors++;
  if (typeof block.url === 'string') sources.add(block.url);
  if (block.type === 'web_search_result_location' && typeof block.url === 'string') citationSources.add(block.url);
  if (Array.isArray(block.content)) block.content.forEach(inspect);
  else if (block.content && typeof block.content === 'object') inspect(block.content);
  if (Array.isArray(block.citations)) block.citations.forEach(inspect);
  if (block.citation) inspect(block.citation);
}
try {
  const response = await fetch(endpoint, {
    method: 'POST', signal: AbortSignal.timeout(60000),
    headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key, authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: values.model, max_tokens: 1024, stream: !values.json,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }],
      messages: [{ role: 'user', content: 'Use web_search once to find the official Anthropic web search documentation, then give one brief sentence with a source citation. Do not answer from memory.' }],
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    console.log(JSON.stringify({ httpStatus: response.status, accepted: false, gatewayVerified: false }));
    process.exitCode = 1;
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let pending = '';
    function consumeLine(line) {
      if (!line.startsWith('data:')) return;
      const data = JSON.parse(line.slice(5).trim());
      if (data.type === 'error') throw new Error();
      if (data.type === 'message_stop') terminal = true;
      inspect(data.content_block);
      inspect(data.delta);
    }
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 4 * 1024 * 1024) throw new Error();
        pending += decoder.decode(value, { stream: true });
        if (!values.json) {
          const lines = pending.split('\n');
          pending = lines.pop();
          lines.forEach(consumeLine);
        }
      }
      pending += decoder.decode();
      if (values.json) {
        const data = JSON.parse(pending);
        if (data.type !== 'message' || !data.stop_reason) throw new Error();
        inspect(data);
        terminal = true;
      } else if (pending.trim()) consumeLine(pending);
    } finally {
      await reader.cancel();
    }
    const verified = terminal && counts.server_tool_use > 0 && counts.web_search_tool_result > 0 && citationSources.size > 0 && searchErrors === 0;
    console.log(JSON.stringify({ httpStatus: response.status, accepted: true, mode: values.json ? 'json' : 'stream', terminal, counts, sourceCount: sources.size, citedSourceCount: citationSources.size, searchErrors, gatewayVerified: verified }));
    if (!verified) process.exitCode = 1;
  }
} catch {
  console.error('Probe incomplete: transport, deadline, response limit or protocol error; no live capability conclusion');
  process.exitCode = 1;
}
