import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
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

test("headless HTML and a long preamble still get a bounded prefix injection", async () => {
  for (const html of ["<p>导出</p>", " ".repeat(65536)]) {
    const output = await collect(Readable.from([Buffer.from(html)]).pipe(nativeDownloadHtml()));
    assert.equal(output.toString(), "<script>window.__baoyuNativeDownloads=true;</script>" + html);
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
    const headers = { "content-type": "text/html", "content-length": 3, ...extra };
    const original = { ...headers };
    assert.equal(previewDownloadBody(reply, headers), reply);
    assert.deepEqual(headers, original);
    assert.deepEqual(await collect(reply), Buffer.from([0, 255, 17]));
  }
});
