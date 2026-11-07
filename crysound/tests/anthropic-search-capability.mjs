// Keyless diagnostic of the pinned provider: loopback SSE only, no profile writes.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { SourceTextModule, SyntheticModule } from 'node:vm';

const root = process.env.DSH_RELEASE_ROOT;
assert.ok(root, 'Set DSH_RELEASE_ROOT to the existing dsh runtime node_modules');
const adapterDir = join(root, '@deepseek-ai/dsh-llm-pi-ai');
const piDir = join(root, '@earendil-works/pi-ai');
const versions = {};
for (const [dir, expected] of [[adapterDir, '0.2.2-rc.1'], [piDir, '1.5.0']]) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.version, expected, 'Review diagnostic when the runtime version changes');
  versions[manifest.name] = manifest.version;
}

// Expose only the bundled profile resolver for the diagnostic. All imports and
// provider/stream/replay code are the real release; nothing is written to it.
const file = join(adapterDir, 'lib/index.js');
const source = await readFile(file, 'utf8');
assert.ok(process.execArgv.includes('--experimental-import-meta-resolve'), 'Run with --experimental-import-meta-resolve');
const resolveImport = specifier => import.meta.resolve(specifier, pathToFileURL(file).href);
const module = new SourceTextModule(source + '\nexport { resolveProfiles };\n', {
  identifier: file,
  initializeImportMeta: meta => { meta.url = pathToFileURL(file).href; },
  importModuleDynamically: specifier => import(resolveImport(specifier)),
});
await module.link(async specifier => {
  const exports = await import(resolveImport(specifier));
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [name, value] of Object.entries(exports)) this.setExport(name, value);
  });
});
await module.evaluate();
const { PiAiAdapter, resolveProfiles } = module.namespace;

const sourceURL = 'https://example.com/server-search-source';
const serverId = 'srvtoolu_search_fixture';
const modelId = 'claude-capability-fixture';
const frames = [
  { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: serverId, name: 'web_search', input: {} } },
  { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"query":"fixture"}' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'web_search_tool_result', tool_use_id: serverId, content: [{ type: 'web_search_result', url: sourceURL, title: 'Fixture source', encrypted_content: 'fixture-encrypted-content' }] } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Answer from search.' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: sourceURL, title: 'Fixture source', encrypted_index: 'fixture-index', cited_text: 'Fixture evidence' } } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } },
  { type: 'message_stop' },
];
const requests = [];
const server = createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  requests.push(JSON.parse(body));
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.end(frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join(''));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  const profiles = resolveProfiles({ fixture: {
    api: 'anthropic-messages',
    baseURL: `http://127.0.0.1:${server.address().port}`,
    models: [{ id: modelId, input: ['text'], contextWindow: 200000, maxTokens: 1024 }],
  } });
  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => 'fixture-not-a-secret',
    auth: {
      credentials: { read: async () => undefined, list: async () => [], modify: async () => undefined, delete: async () => {} },
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
  });
  const user = { role: 'user', content: [{ type: 'text', text: 'Search the fixture.' }] };
  const options = {
    provider: 'fixture', model: modelId, maxTokens: 128, messages: [user],
    // Supplying a native type on an otherwise valid local tool still gets
    // serialized as a client tool. This is a probe, not a production setting.
    tools: [{ type: 'web_search_20250305', name: 'web_search', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }],
  };
  const chunks = [];
  for await (const chunk of adapter.stream(options)) chunks.push(chunk);
  const finish = chunks.find(chunk => chunk.type === 'finish');
  assert.equal(finish.reason.kind, 'stop');
  const text = chunks.filter(chunk => chunk.type === 'block-end').map(chunk => chunk.block);
  assert.deepEqual(text, [{ type: 'text', text: 'Answer from search.' }]);
  assert.equal(requests[0].tools[0].type, undefined);
  assert.ok(requests[0].tools[0].input_schema);
  const persisted = JSON.parse(JSON.stringify({ content: text, replayState: finish.replayState }));
  assert.doesNotMatch(JSON.stringify(persisted), /server-search-source/);
  assert.ok(!JSON.stringify(persisted).includes(serverId));
  // Replay the exact JSON-serializable output that a session can save.
  for await (const chunk of adapter.stream({ ...options, messages: [user, {
    role: 'assistant', ...persisted, source: { kind: 'model', provider: 'fixture', model: modelId },
  }, { role: 'user', content: [{ type: 'text', text: 'Continue.' }] }] })) {
    assert.notEqual(chunk.type === 'finish' && chunk.reason.kind, 'error');
  }
  assert.doesNotMatch(JSON.stringify(requests[1].messages), /server-search-source/);
  assert.ok(!JSON.stringify(requests[1].messages).includes(serverId));
  console.log(JSON.stringify({
    versions, fixtureRequests: requests.length, textStreaming: 'works',
    nativeToolDeclaration: 'type stripped; serialized as client input_schema',
    serverToolUse: 'dropped', webSearchToolResult: 'dropped', citations: 'dropped',
    serializedReplay: 'source URL and server tool blocks absent',
    nextRequest: 'source URL and server tool blocks absent',
    uiInput: 'plain answer only; no structured sources reach UI',
    conclusion: 'BLOCKED: pinned runtime does not support native server search',
    scope: 'keyless fixture, not a live gateway or browser acceptance',
  }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
}
