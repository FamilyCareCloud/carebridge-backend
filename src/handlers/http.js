import { createServer } from 'node:http';
const MAX_BODY = 65536;
const MAX_VOICE_BODY = Number(process.env.AUDIO_MAX_BYTES) || 4 * 1024 * 1024; // base64 오디오는 원본보다 커서 별도 상한 적용
const isVoicePath = url => /^(?:\/groups\/[^/]+\/(?:assistant\/voice|carebridge\/transcriptions)|\/workspaces\/[^/]+\/transcriptions)(?:\?|$)/.test(url);
export function createHttpServer(app) {
  const attempts = new Map();
  return createServer(async (req, res) => {
    const events = /^\/workspaces\/([^/?]+)\/events$/.exec(req.url);
    if (events && req.method === 'GET' && app.subscribeWorkspace) {
      const authorization = req.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
      let closed = false, started = false, pending = false, checking = false;
      const check = async () => {
        if (closed) return;
        if (!started || checking) { pending = true; return; }
        checking = true;
        try {
          const state = await app({ method: 'GET', path: `/workspaces/${events[1]}/access`, token });
          if (!closed) {
            res.write(`event: ${state.status === 200 ? 'invalidate' : 'access-revoked'}\ndata: {}\n\n`);
            if (state.status !== 200) res.end();
          }
        } finally { checking = false; if (pending) { pending = false; void check(); } }
      };
      const unsubscribe = app.subscribeWorkspace(events[1], () => { void check(); });
      const cleanup = () => { closed = true; unsubscribe(); clearInterval(heartbeat); };
      const heartbeat = setInterval(() => { void check(); }, 20000);
      res.on('close', cleanup);
      try {
        const initial = await app({ method: 'GET', path: `/workspaces/${events[1]}/access`, token });
        if (closed) return;
        if (initial.status !== 200) { cleanup(); res.writeHead(initial.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(initial.body)); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        started = true;
        res.write('event: revalidate\ndata: {}\n\n');
        if (pending) { pending = false; await check(); }
      } catch { cleanup(); res.destroy(); }
      return;
    }
    let result;
    try {
      if (req.url.startsWith('/auth/') || req.url.startsWith('/workspace-auth/')) {
        const now = Date.now(), key = req.socket.remoteAddress;
        for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
        const value = attempts.get(key) ?? { count: 0, until: now + 60000 };
        value.count++; attempts.set(key, value);
        if (value.count > 30) { const error = new Error('잠시 후 다시 시도하세요.'); error.status = 429; throw error; }
      }
      const maxBody = isVoicePath(req.url) ? MAX_VOICE_BODY : req.url.includes('/carebridge/') ? 262144 : MAX_BODY;
      const chunks = []; let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > maxBody) { const error = new Error('요청이 너무 큽니다.'); error.status = 413; throw error; }
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks).toString('utf8');
      const authorization = req.headers.authorization ?? '';
      result = await app({ method: req.method, path: req.url, token: authorization.startsWith('Bearer ') ? authorization.slice(7) : null, body: data ? JSON.parse(data) : {} });
    } catch (error) { result = { status: error.status ?? 400, body: { error: error.status ? error.message : '올바른 JSON 요청이 필요합니다.' } }; }
    res.writeHead(result.status, { ...(result.status === 429 && result.body?.details?.retryAfterSeconds ? { 'Retry-After': String(result.body.details.retryAfterSeconds) } : {}), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(JSON.stringify(result.body));
  });
}
