import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import { nativeDownloadHtml, previewDownloadBody } from "../downloads.mjs";

const collect = async (stream) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return Buffer.concat(chunks); };

test("HTML head split across chunks preserves UTF-8 and streams before EOF", async () => {
  const input = nativeDownloadHtml(), parts = [];
  input.on("data", (chunk) => parts.push(chunk));
  input.write(Buffer.from('<!doctype html><html><HE'));
  assert.equal(parts.length, 0);
  input.write(Buffer.from('AD data-x="1"><script>start()</script>'));
  assert.match(Buffer.concat(parts).toString(), /<HEAD data-x="1"><script>window.__baoyuNativeDownloads=true;<\/script><script>start/);
  const bytes = Buffer.from("中文标题</html>");
  const done = collect(input);
  input.write(bytes.subarray(0, 1)); input.end(bytes.subarray(1));
  assert((await done).includes(bytes));
});

test("HTML without a head and documents beyond the prefix limit remain byte-for-byte unchanged", async () => {
  for (const html of [
    '<section data-slide="9"><h1>选型逻辑</h1></section>\r\n',
    '<!doctype html><html><body>没有 head</body></html>',
    " ".repeat(65536) + "<head></head><body>late head</body>",
  ]) {
    const bytes = Buffer.from(html);
    const output = await collect(Readable.from([bytes.subarray(0, 65536), bytes.subarray(65536)]).pipe(nativeDownloadHtml()));
    assert.deepEqual(output, bytes);
  }
});

test("attachments, binary, SSE, unsupported charset and non-200 responses are byte-for-byte streams", async () => {
  for (const [statusCode, extra] of [
    [200, { "content-type": "application/pdf" }], [200, { "content-type": "text/event-stream" }],
    [200, { "content-disposition": "attachment; filename=test.html" }],
    [200, { "content-encoding": "constructor" }],
    [200, { "content-type": "text/html; charset=gbk" }], [206, {}], [304, {}],
  ]) {
    const reply = Object.assign(Readable.from([Buffer.from([0, 255, 17])]), { statusCode });
    const headers = { "content-type": "text/html", "content-length": 3,
      "content-security-policy": "script-src 'self'", ...extra };
    const original = { ...headers };
    assert.equal(previewDownloadBody(reply, headers), reply);
    assert.deepEqual(headers, original);
    assert.deepEqual(await collect(reply), Buffer.from([0, 255, 17]));
  }
});

test("CSP authorizes the injected script without disabling existing inline scripts", async () => {
  const hash = `'sha256-${createHash("sha256").update("window.__baoyuNativeDownloads=true;").digest("base64")}'`;
  const cases = [
    ["script-src 'self' 'sha256-editor'", `script-src 'self' 'sha256-editor' ${hash}`],
    ["script-src 'nonce-editor' 'unsafe-inline'", `script-src 'nonce-editor' 'unsafe-inline' ${hash}`],
    ["script-src 'unsafe-inline' 'sha384-editor'", `script-src 'unsafe-inline' 'sha384-editor' ${hash}`],
    ["script-src 'sha512-editor' 'strict-dynamic'", `script-src 'sha512-editor' 'strict-dynamic' ${hash}`],
    ["default-src 'none'; img-src data:", `default-src 'none' ${hash}; img-src data:`],
    ["default-src 'self'; SCRIPT-SRC 'none'; script-src-elem 'nonce-editor'", `default-src 'self'; SCRIPT-SRC 'none'; script-src-elem 'nonce-editor' ${hash}`],
    ["script-src 'unsafe-inline'", "script-src 'unsafe-inline'"],
    ["default-src 'self' 'unsafe-inline'; img-src data:", "default-src 'self' 'unsafe-inline'; img-src data:"],
    ["img-src 'none'", "img-src 'none'"],
    [`script-src ${hash}`, `script-src ${hash}`],
    ["script-src 'self'; script-src 'none'", `script-src 'self' ${hash}; script-src 'none'`],
    ["script-src 'self', default-src 'none'", `script-src 'self' ${hash}, default-src 'none' ${hash}`],
    [["script-src 'self'", "script-src 'unsafe-inline'"], [`script-src 'self' ${hash}`, "script-src 'unsafe-inline'"]],
  ];
  for (const [policy, expected] of cases) {
    const reply = Object.assign(Readable.from(["<head></head>"]), { statusCode: 200 });
    const headers = { "content-type": "text/html", "content-security-policy": policy,
      "content-security-policy-report-only": "script-src 'none'" };
    await collect(previewDownloadBody(reply, headers));
    assert.deepEqual(headers["content-security-policy"], expected);
    assert.equal(headers["content-security-policy-report-only"], "script-src 'none'");
  }
});
