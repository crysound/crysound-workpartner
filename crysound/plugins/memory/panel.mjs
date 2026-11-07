/** Same-origin panel routes; the gateway supplies identity, webStartup supplies trusted authorities. */
import { isIP } from 'node:net';

function authority(value, protocol = 'http:') {
  if (typeof value !== 'string' || !value || /[\s/@?#\\]/u.test(value)) return undefined;
  try {
    const url = new URL(protocol + '//' + value);
    return url;
  } catch (error) {
    // Invalid request authorities are refused before any data is read.
    return undefined;
  }
}

/** Refuse DNS rebinding and cross-origin requests without broadening the deployment allowlist. */
export function trustedRequest(request, { trustedHosts }, bindHost) {
  const { host, origin, 'sec-fetch-site': site } = request.headers;
  const url = authority(host);
  if (!url || (site !== undefined && site !== 'same-origin' && site !== 'none')) return false;
  const hostname = url.hostname.replace(/^\[|\]$/gu, '');
  const local = hostname === 'localhost' || hostname === '::1' || /^127\./u.test(hostname) && isIP(hostname) === 4;
  const allowed = local || hostname === bindHost || trustedHosts.some(entry => {
    const candidate = authority(entry);
    if (!candidate) return false;
    const hasPort = entry.startsWith('[') ? entry.includes(']:') : entry.includes(':');
    if (!hasPort) return candidate.hostname === url.hostname;
    // Host and configured authority must agree under both default-port normalizations.
    return candidate.host === url.host && authority(entry, 'https:').host === authority(host, 'https:').host;
  });
  if (!allowed) return false;
  if (origin === undefined) return true;
  try {
    const from = new URL(origin);
    return ['http:', 'https:'].includes(from.protocol) && from.origin === origin
      && from.host === authority(host, from.protocol)?.host;
  } catch (error) {
    // Opaque or malformed browser origins cannot access personal facts.
    return false;
  }
}

function reply(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}

/** Register personal-memory endpoints with the same store and revision checks as the model tools. */
export function registerPanel(ctx, store) {
  const limits = { maxMemories: store.maxMemories, recallChars: store.recallChars };
  const actions = {
    delete: input => store.remove(input),
    save: ({ id, revision, kind, title, content }) => store.save({ id, revision, kind, title, content }, { source: id === undefined ? 'manual' : 'edited', requireEnabled: false }),
    enabled: input => store.setEnabled(input),
    'auto-learning': input => store.setAutoLearning(input),
    'undo-learning': input => store.undoLearning(input),
    clear: input => store.clear(input),
  };
  for (const [path, method] of [['list', 'GET'], ['learning', 'GET'], ...Object.keys(actions).map(path => [path, 'POST'])]) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: '/crysound-memory/api/' + path,
      async handler(request, response) {
        if (!trustedRequest(request, ctx.webStartup, ctx.webServer.host)) return reply(response, 403, { error: '请从本人的工作伙伴页面访问。' });
        if (request.method !== method) return reply(response, 405, { error: '请求方式不支持。' });
        try {
          if (method === 'GET') return reply(response, 200, { ...store.snapshot({ includeLearning: path === 'learning' }), limits });
          if (request.headers['content-type']?.split(';')[0].trim() !== 'application/json') {
            return reply(response, 415, { error: '请使用个人记忆页面上的按钮。' });
          }
          const chunks = [];
          let length = 0;
          for await (const chunk of request) {
            length += Buffer.byteLength(chunk);
            if (length > 4096) return reply(response, 413, { error: '请求内容过长。' });
            chunks.push(Buffer.from(chunk));
          }
          let input;
          try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (error) { return reply(response, 400, { error: '请求内容无效，请刷新。' }); }
          if (!input || typeof input !== 'object') return reply(response, 400, { error: '请求内容无效，请刷新。' });
          return reply(response, 200, { ...actions[path](input), limits });
        } catch (error) {
          // Return an actionable failure; never report an uncommitted deletion as successful.
          return reply(response, 409, { error: error.message });
        }
      },
    }));
  }
}
