// Probe behavior against a loopback gateway; never sends a paid model request.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const probe = fileURLToPath(new URL('../scripts/probe-anthropic-search.mjs', import.meta.url));
const secret = 'fixture-key-must-never-be-logged';
const citation = { type: 'web_search_result_location', url: 'https://example.com/source' };
const content = [
  { type: 'server_tool_use', id: 'srvtoolu_fixture', name: 'web_search', input: { query: 'fixture' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_fixture', content: [{ type: 'web_search_result', url: citation.url }] },
  { type: 'text', text: 'Found.', citations: [citation] },
];

for (const mode of ['stream', 'json', 'ignored', 'http-error', 'truncated', 'tool-error']) {
  test(`live probe reports ${mode} gateway response without logging secrets`, async () => {
    const requests = [];
    const server = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      requests.push({ url: request.url, key: request.headers['x-api-key'], body: JSON.parse(body) });
      if (mode === 'http-error') {
        response.writeHead(403);
        response.end(JSON.stringify({ error: { message: secret } }));
      } else if (mode === 'json') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ type: 'message', content, stop_reason: 'end_turn' }));
      } else {
        response.setHeader('content-type', 'text/event-stream');
        const frames = mode === 'ignored' ? [] : content.map((block, index) => ({ type: 'content_block_start', index, content_block: block }));
        if (mode === 'stream') frames.push({ type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation } });
        if (mode === 'tool-error') frames.push({ type: 'content_block_start', index: 3, content_block: { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } } });
        if (mode !== 'truncated') frames.push({ type: 'message_stop' });
        const wire = frames.map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join('');
        // Split the data prefix across writes to exercise streaming decoding.
        response.write(wire.slice(0, 9));
        setImmediate(() => response.end(wire.slice(9)));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const child = spawn(process.execPath, [probe, '--base-env', 'PROBE_FIXTURE_BASE', '--key-env', 'PROBE_FIXTURE_KEY', '--model', 'fixture-claude', ...(mode === 'json' ? ['--json'] : [])], {
        env: { ...process.env, NODE_OPTIONS: '', PROBE_FIXTURE_BASE: `http://127.0.0.1:${server.address().port}/v1`, PROBE_FIXTURE_KEY: secret },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
      assert.ok(!output.includes(secret));
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, '/v1/messages');
      assert.equal(requests[0].key, secret);
      assert.deepEqual(requests[0].body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 1 }]);
      const passed = ['stream', 'json'].includes(mode);
      assert.equal(code, passed ? 0 : 1, output);
      const report = JSON.parse(output);
      assert.equal(report.gatewayVerified, passed);
      if (passed) assert.equal(report.citedSourceCount, 1);
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
}
