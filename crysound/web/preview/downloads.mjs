import { Transform } from "node:stream";
import { createGunzip, createInflate, createBrotliDecompress } from "node:zlib";

const SCRIPT = Buffer.from("<script>window.__baoyuNativeDownloads=true;</script>");
const DECODERS = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress };

/** Inject before editor scripts, retaining bytes and streaming after the head (at most 64 KiB). */
export function nativeDownloadHtml() {
  let prefix = Buffer.alloc(0), injected = false;
  const emit = (stream, end = false) => {
    const head = /<head\b[^>]*>/i.exec(prefix.toString("latin1"));
    if (!head && !end && prefix.length < 65536) return;
    const at = head ? head.index + head[0].length : 0;
    stream.push(prefix.subarray(0, at)); stream.push(SCRIPT); stream.push(prefix.subarray(at));
    prefix = null; injected = true;
  };
  return new Transform({
    transform(chunk, encoding, done) {
      if (injected) this.push(chunk);
      else { prefix = Buffer.concat([prefix, chunk]); emit(this); }
      done();
    },
    flush(done) { if (!injected) emit(this, true); done(); },
  });
}

/** Only the authenticated web-preview gateway rewrites HTML; relay and desktop stay untouched. */
export function previewDownloadBody(reply, headers) {
  if (reply.statusCode !== 200 || !/^text\/html(?:\s*;|$)/i.test(headers["content-type"] || "")
    || headers["content-disposition"] || /charset\s*=\s*["']?(?!utf-8\b|utf8\b)[\w-]+/i.test(headers["content-type"])) return reply;
  const encoding = String(headers["content-encoding"] || "identity").toLowerCase();
  if (encoding !== "identity" && !Object.hasOwn(DECODERS, encoding)) return reply;
  for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest"]) delete headers[name];
  const output = nativeDownloadHtml();
  let input = reply;
  if (encoding !== "identity") {
    input = DECODERS[encoding]();
    input.on("error", (error) => output.destroy(error));
    reply.pipe(input);
  }
  output.on("close", () => { if (input !== reply) input.destroy(); });
  return input.pipe(output);
}
