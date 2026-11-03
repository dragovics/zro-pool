import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { stmt, getSetting } from './db.js';
import { pool, QueueTimeoutError } from './pool.js';

const VERSION = (() => {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    return JSON.parse(readFileSync(pkgPath, 'utf8')).version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

// how long a single upstream call may hang before we abort (lease-leak guard)
const UPSTREAM_HARD_TIMEOUT_MS = 10 * 60 * 1000;
// client headers worth forwarding verbatim to the upstream
const FORWARD_HEADERS = ['x-request-id', 'anthropic-version', 'anthropic-beta', 'http-referer', 'x-title'];

export const upstreamBase = (() => {
  let base = process.env.ZRO_BASE_URL || 'https://zro.moonmath.ai';
  base = base.replace(/\/+$/, '').replace(/\/v1$/, '');
  return base;
})();

// statuses that trigger failover to the next key
const kindForStatus = (s) => {
  if (s === 429) return 'rate_limit';
  if (s === 409 || s === 402) return 'account';
  if (s === 401 || s === 403) return 'auth';
  if (s >= 500) return 'server';
  return null;
};

export function sessionHashFromBody(rawBody) {
  // Stable hash of the conversation head: model + system-ish first message +
  // first non-system message content. Later turns resend the head unchanged,
  // so the hash stays stable across a session — that's what affinity pins on.
  try {
    const body = JSON.parse(rawBody.toString('utf8'));
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return null;
    const model = String(body.model || '');
    const first = body.messages[0] || {};
    const head2 = body.messages[1] || {};
    const firstUser = body.messages.find((m) => m && m.role !== 'system') || {};
    const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '')).slice(0, 2000);
    return createHash('sha256')
      .update(model)
      .update('\x00')
      .update(String(first.role || '') + ':' + text(first))
      .update('\x00')
      .update(String(head2.role || '') + ':' + text(head2).slice(0, 500))
      .update('\x00')
      .update(text(firstUser))
      .digest('hex');
  } catch {
    return null;
  }
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  // OpenAI shape
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    return {
      input: usage.prompt_tokens || 0,
      output: usage.completion_tokens || 0,
      cached: usage.prompt_tokens_details?.cached_tokens || 0,
    };
  }
  // Anthropic shape
  if (usage.input_tokens != null || usage.output_tokens != null) {
    return { input: usage.input_tokens || 0, output: usage.output_tokens || 0, cached: usage.cache_read_input_tokens || 0 };
  }
  return null;
}

function extractUsageFromJsonText(text) {
  try {
    return normalizeUsage(JSON.parse(text).usage);
  } catch {
    return null;
  }
}

/** Best-effort SSE usage scanner: pass-through bytes, sniff `usage` in data lines. */
class SseUsageScanner extends Transform {
  constructor() {
    super();
    this.usage = null;
    this.buf = '';
  }
  _transform(chunk, enc, cb) {
    this.buf += chunk.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop() ?? '';
    // cap the pending buffer so a headerless garbage stream can't grow memory
    if (this.buf.length > 64 * 1024) this.buf = this.buf.slice(-1024);
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      if (!payload.includes('"usage"')) continue;
      try {
        const u = normalizeUsage(JSON.parse(payload).usage);
        if (u) this.usage = u;
      } catch { /* partial/non-JSON, ignore */ }
    }
    cb(null, chunk);
  }
}

function recordLog({ gwKeyId, keyId, model, status, upstreamStatus, usage, durationMs, error }) {
  try {
    stmt.insertLog.run(
      Date.now(), gwKeyId ?? null, keyId ?? null, model || '', status ?? 0, upstreamStatus ?? 0,
      usage?.input || 0, usage?.output || 0, usage?.cached || 0, durationMs || 0, String(error || '').slice(0, 300),
    );
    if (keyId != null && usage) {
      stmt.bumpUpstreamUsage.run(usage.input || 0, usage.output || 0, usage.cached || 0, Date.now(), keyId);
    } else if (keyId != null) {
      stmt.bumpUpstreamUsage.run(0, 0, 0, Date.now(), keyId);
    }
    if (gwKeyId != null) stmt.bumpGatewayUsage.run(gwKeyId);
  } catch {
    /* never let accounting break the response */
  }
}

function errorJson(reply, status, message, type = 'api_error') {
  reply.code(status).send({ error: { message, type } });
}

export function registerProxyRoutes(app) {
  // auth hook for /v1/*
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/v1/')) return;
    const auth = request.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token.startsWith('zrp_')) return errorJson(reply, 401, 'API key gateway tidak valid (format zrp_...)', 'invalid_request_error');
    const gw = stmt.getGatewayByKey.get(token);
    if (!gw || !gw.enabled) return errorJson(reply, 401, 'API key gateway tidak dikenal atau nonaktif', 'invalid_request_error');
    request.gwKeyId = gw.id;
  });

  app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
    url: '/v1/*',
    handler: proxyHandler,
  });
}

async function proxyHandler(request, reply) {
  const started = Date.now();
  const rawBody = Buffer.isBuffer(request.body)
    ? request.body
    : request.body != null ? Buffer.from(JSON.stringify(request.body)) : undefined;
  const mode = getSetting('routing_mode', 'affinity');
  const queueTimeoutMs = Number(getSetting('queue_timeout_ms', '30000'));
  const sessionHash = rawBody ? sessionHashFromBody(rawBody) : null;
  let model = '';
  try {
    if (rawBody) model = String(JSON.parse(rawBody.toString('utf8')).model || '');
  } catch { /* non-JSON body, fine */ }

  // resolve target URL and refuse anything that escapes /v1 (e.g. /v1/../admin)
  let target;
  try {
    target = new URL(request.url, upstreamBase);
    if (!target.pathname.startsWith('/v1/')) {
      return errorJson(reply, 400, 'Path harus di bawah /v1/', 'invalid_request_error');
    }
  } catch {
    return errorJson(reply, 400, 'URL tidak valid', 'invalid_request_error');
  }

  if (!pool.anyUsable()) {
    return errorJson(reply, 503, 'Belum ada key upstream aktif. Tambahkan lewat dashboard.', 'no_upstream_key');
  }

  // count only keys that can actually serve: failover must end, not orbit
  const attemptsMax = Math.max(1, Math.min(50, [...pool.keys.values()].filter((k) => k.enabled && k.status !== 'dead').length));
  let lastError = null;
  let lastUpstreamStatus = 0;

  for (let attempt = 0; attempt < attemptsMax; attempt++) {
    let lease;
    try {
      lease = await pool.acquire({ sessionHash, mode, queueTimeoutMs });
    } catch (e) {
      if (e instanceof QueueTimeoutError) {
        if (attempt === 0) {
          // first try: the queue timeout is the designed behavior (all keys busy)
          recordLog({ gwKeyId: request.gwKeyId, keyId: null, model, status: 429, upstreamStatus: 0, usage: null, durationMs: Date.now() - started, error: 'queue timeout' });
          return errorJson(reply, 429, 'Semua key upstream sedang sibuk, coba lagi sebentar lagi.', 'rate_limit_error');
        }
        break; // later attempts: every usable key already failed us — stop fast
      }
      throw e;
    }

    const key = lease.key;
    const headers = {
      'content-type': request.headers['content-type'] || 'application/json',
      accept: request.headers.accept || '*/*',
      authorization: `Bearer ${key.key}`,
      'accept-encoding': 'identity',
    };
    for (const h of FORWARD_HEADERS) {
      if (request.headers[h]) headers[h] = request.headers[h];
    }

    // hard timeout so a hung upstream can never leak the lease forever
    const ac = new AbortController();
    const hardTimer = setTimeout(() => ac.abort(new Error('upstream timeout')), UPSTREAM_HARD_TIMEOUT_MS);

    let res;
    try {
      res = await fetch(target, {
        method: request.method,
        headers,
        redirect: 'manual',
        signal: ac.signal,
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : rawBody,
      });
    } catch (e) {
      clearTimeout(hardTimer);
      lastError = `network: ${e.cause?.code || e.message}`;
      lastUpstreamStatus = 0;
      pool.markFailure(key.id, 'server', lastError);
      lease.release();
      continue;
    }

    const kind = kindForStatus(res.status);
    if (kind) {
      clearTimeout(hardTimer);
      const retryAfter = Number(res.headers.get('retry-after')) || null;
      let detail = '';
      try { detail = (await res.text()).slice(0, 200); } catch { /* ignore */ }
      lastError = `upstream ${res.status}: ${detail}`;
      lastUpstreamStatus = res.status;
      pool.markFailure(key.id, kind, lastError, retryAfter);
      lease.release();
      continue; // failover to next key
    }

    // success path — forward to client
    lease.commitSession();
    const outHeaders = { 'content-type': res.headers.get('content-type') || 'application/json' };
    for (const h of ['x-request-id', 'location', 'retry-after']) {
      const v = res.headers.get(h);
      if (v) outHeaders[h] = v;
    }
    const isStream = (outHeaders['content-type'] || '').includes('event-stream');

    if (isStream) {
      const scanner = new SseUsageScanner();
      reply.hijack();
      reply.raw.writeHead(res.status, outHeaders);
      const body = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
      try {
        await pipeline(body, scanner, reply.raw, { end: true, signal: ac.signal });
      } catch (e) {
        lastError = `stream: ${e.message}`;
        try { reply.raw.end(); } catch { /* already closed */ }
      } finally {
        clearTimeout(hardTimer);
      }
      lease.release();
      pool.markSuccess(key.id, scanner.usage);
      recordLog({ gwKeyId: request.gwKeyId, keyId: key.id, model, status: res.status, upstreamStatus: res.status, usage: scanner.usage, durationMs: Date.now() - started, error: lastError });
      return reply;
    }

    let text;
    try {
      text = await res.text();
    } catch (e) {
      clearTimeout(hardTimer);
      lastError = `body: ${e.message}`;
      pool.markFailure(key.id, 'server', lastError);
      lease.release();
      continue;
    }
    clearTimeout(hardTimer);
    reply.code(res.status);
    for (const [h, v] of Object.entries(outHeaders)) if (v) reply.header(h, v);
    reply.send(text);
    lease.release();
    const usage = extractUsageFromJsonText(text);
    pool.markSuccess(key.id, usage);
    recordLog({ gwKeyId: request.gwKeyId, keyId: key.id, model, status: res.status, upstreamStatus: res.status, usage, durationMs: Date.now() - started });
    return;
  }

  // every attempt failed
  recordLog({ gwKeyId: request.gwKeyId, keyId: null, model, status: 502, upstreamStatus: lastUpstreamStatus, usage: null, durationMs: Date.now() - started, error: lastError || 'all upstream failed' });
  errorJson(reply, 502, `Semua key upstream gagal. Terakhir: ${lastError || 'unknown'}`, 'upstream_error');
}

export { recordLog, VERSION };
