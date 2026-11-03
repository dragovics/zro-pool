import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, stmt, getSetting, setSetting, statsQuery, startOfDayUtc } from '../lib/db.js';
import {
  hashPassword, verifyPassword, issueSession, sessionCookie, clearCookie,
  readAdminUser, loginAllowed, recordLoginFailure, clearLoginFailures,
} from '../lib/auth.js';
import { pool } from '../lib/pool.js';
import { upstreamBase, VERSION } from '../lib/proxy.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

const ROUTING_MODES = new Set(['affinity', 'no_rotate', 'round_robin']);
const maskKey = (k) => (k.length <= 8 ? k : `${k.slice(0, 4)}...${k.slice(-4)}`);

// Bodies arrive as raw Buffers (see server.js content parsers) — parse once.
function jsonBody(request) {
  if (request.parsedJsonBody) return request.parsedJsonBody;
  let b = request.body;
  if (b == null) b = {};
  else if (Buffer.isBuffer(b)) {
    try { b = JSON.parse(b.toString('utf8')); } catch { b = {}; }
  }
  request.parsedJsonBody = b;
  return b;
}

function requireAdmin(request, reply) {
  const user = readAdminUser(request);
  if (!user) {
    reply.code(401).send({ error: 'belum login' });
    return null;
  }
  return user;
}

function seedAdminCredentials() {
  if (!getSetting('admin_user')) setSetting('admin_user', process.env.ADMIN_USER || 'admin');
  if (!getSetting('admin_pass_hash')) setSetting('admin_pass_hash', hashPassword(process.env.ADMIN_PASSWORD || 'admin'));
  if (!getSetting('routing_mode')) setSetting('routing_mode', 'affinity');
  if (!getSetting('queue_timeout_ms')) setSetting('queue_timeout_ms', '30000');
  if (!getSetting('failback')) setSetting('failback', '1');
}
seedAdminCredentials();

export function registerAdminRoutes(app) {
  // ---- static dashboard ---------------------------------------------------
  app.get('/admin', async (_req, reply) => {
    reply.type('text/html; charset=utf-8').header('cache-control', 'no-store');
    return readFile(join(publicDir, 'index.html'));
  });
  app.get('/admin/app.js', async (_req, reply) => {
    reply.type('text/javascript; charset=utf-8').header('cache-control', 'no-store');
    return readFile(join(publicDir, 'app.js'));
  });
  app.get('/admin/style.css', async (_req, reply) => {
    reply.type('text/css; charset=utf-8').header('cache-control', 'no-store');
    return readFile(join(publicDir, 'style.css'));
  });

  // ---- auth ---------------------------------------------------------------
  app.post('/admin/api/login', async (request, reply) => {
    const ip = request.ip;
    if (!loginAllowed(ip)) return reply.code(429).send({ error: 'terlalu banyak percobaan, tunggu 60 detik' });
    const { user, password } = jsonBody(request);
    const okUser = String(user || '') === getSetting('admin_user');
    const okPass = verifyPassword(String(password || ''), getSetting('admin_pass_hash'));
    if (!okUser || !okPass) {
      recordLoginFailure(ip);
      return reply.code(401).send({ error: 'user atau password salah' });
    }
    clearLoginFailures(ip);
    reply.header('set-cookie', sessionCookie(issueSession(getSetting('admin_user'))));
    return { ok: true };
  });

  app.post('/admin/api/logout', async (_req, reply) => {
    reply.header('set-cookie', clearCookie());
    return { ok: true };
  });

  app.get('/admin/api/session', async (request, reply) => {
    const user = readAdminUser(request);
    if (!user) return reply.code(401).send({ error: 'belum login' });
    return { user };
  });

  app.post('/admin/api/password', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { old_password, new_password } = jsonBody(request);
    if (!verifyPassword(String(old_password || ''), getSetting('admin_pass_hash'))) {
      return reply.code(400).send({ error: 'password lama salah' });
    }
    if (String(new_password || '').length < 4) {
      return reply.code(400).send({ error: 'password baru minimal 4 karakter' });
    }
    setSetting('admin_pass_hash', hashPassword(new_password));
    return { ok: true };
  });

  // ---- upstream keys --------------------------------------------------------
  app.get('/admin/api/keys', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const now = Date.now();
    const live = new Map();
    for (const k of pool.keys.values()) live.set(k.id, k);
    const keys = stmt.listUpstream.all().map((row) => {
      const mem = live.get(row.id);
      const status = !row.enabled ? 'paused'
        : row.status === 'dead' ? 'dead'
        : row.cooldown_until > now ? 'cooldown' : 'active';
      return {
        id: row.id,
        label: row.label,
        key_masked: maskKey(row.key),
        enabled: !!row.enabled,
        status,
        concurrency_limit: row.concurrency_limit,
        inflight: mem ? mem.inflight : 0,
        cooldown_remaining_ms: Math.max(0, row.cooldown_until - now),
        last_error: row.last_error,
        error_count: row.error_count,
        total_requests: row.total_requests,
        total_input_tokens: row.total_input_tokens,
        total_output_tokens: row.total_output_tokens,
        total_cached_tokens: row.total_cached_tokens,
        cache_hit_rate: row.total_input_tokens > 0 ? row.total_cached_tokens / row.total_input_tokens : 0,
        last_used_at: row.last_used_at,
      };
    });
    return { keys };
  });

  app.post('/admin/api/keys', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const { keys, label } = jsonBody(request);
    const lines = String(keys || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!lines.length) return reply.code(400).send({ error: 'tidak ada key yang dikirim' });
    if (lines.length > 500) return reply.code(400).send({ error: 'maksimal 500 key sekali tambah' });
    const now = Date.now();
    let added = 0;
    for (const k of lines) {
      const r = stmt.insertUpstream.run(k, String(label || '').slice(0, 100), now);
      if (r.changes > 0) added++;
    }
    pool.reloadKeys();
    return { added, duplicates: lines.length - added };
  });

  app.patch('/admin/api/keys/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const id = Number(request.params.id);
    const b = jsonBody(request);
    let limit;
    if (b.concurrency_limit != null) {
      limit = Number(b.concurrency_limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        return reply.code(400).send({ error: 'concurrency_limit harus 1–100' });
      }
    }
    const r = stmt.updateUpstreamPatch.run(
      b.label != null ? String(b.label).slice(0, 100) : null,
      b.enabled != null ? (b.enabled ? 1 : 0) : null,
      limit ?? null,
      id,
    );
    if (!r.changes) return reply.code(404).send({ error: 'key tidak ditemukan' });
    pool.reloadKeys();
    return { ok: true };
  });

  app.post('/admin/api/keys/:id/reset', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const r = stmt.resetUpstream.run(Number(request.params.id));
    if (!r.changes) return reply.code(404).send({ error: 'key tidak ditemukan' });
    pool.reloadKeys();
    return { ok: true };
  });

  app.delete('/admin/api/keys/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const r = stmt.deleteUpstream.run(Number(request.params.id));
    if (!r.changes) return reply.code(404).send({ error: 'key tidak ditemukan' });
    pool.reloadKeys();
    return { ok: true };
  });

  // ---- gateway keys ---------------------------------------------------------
  app.get('/admin/api/gateway-keys', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return { keys: stmt.listGateway.all() };
  });

  app.post('/admin/api/gateway-keys', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const name = String(jsonBody(request).name || '').slice(0, 100);
    const key = `zrp_${randomBytes(24).toString('hex')}`;
    const r = stmt.insertGateway.run(key, name, Date.now());
    return { id: Number(r.lastInsertRowid), key };
  });

  app.patch('/admin/api/gateway-keys/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const b = jsonBody(request);
    const r = stmt.patchGateway.run(
      b.name != null ? String(b.name).slice(0, 100) : null,
      b.enabled != null ? (b.enabled ? 1 : 0) : null,
      Number(request.params.id),
    );
    if (!r.changes) return reply.code(404).send({ error: 'key tidak ditemukan' });
    return { ok: true };
  });

  app.delete('/admin/api/gateway-keys/:id', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const r = stmt.deleteGateway.run(Number(request.params.id));
    if (!r.changes) return reply.code(404).send({ error: 'key tidak ditemukan' });
    return { ok: true };
  });

  // ---- settings ---------------------------------------------------------------
  app.get('/admin/api/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    return {
      routing_mode: getSetting('routing_mode', 'affinity'),
      queue_timeout_ms: Number(getSetting('queue_timeout_ms', '30000')),
      failback: getSetting('failback', '1') === '1',
      upstream_base_url: upstreamBase,
      version: VERSION,
    };
  });

  app.patch('/admin/api/settings', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const b = jsonBody(request);
    if (b.routing_mode != null) {
      if (!ROUTING_MODES.has(b.routing_mode)) return reply.code(400).send({ error: 'routing_mode tidak valid' });
      setSetting('routing_mode', b.routing_mode);
    }
    if (b.queue_timeout_ms != null) {
      const t = Number(b.queue_timeout_ms);
      if (!Number.isFinite(t) || t < 1000 || t > 300000) return reply.code(400).send({ error: 'queue_timeout_ms 1000–300000' });
      setSetting('queue_timeout_ms', String(Math.round(t)));
    }
    if (b.failback != null) setSetting('failback', b.failback ? '1' : '0');
    return { ok: true };
  });

  // ---- stats -------------------------------------------------------------------
  app.get('/admin/api/stats', async (request, reply) => {
    if (!requireAdmin(request, reply)) return reply;
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    const today = statsQuery.range.get(startOfDayUtc());
    const last24h = statsQuery.range.get(dayAgo);
    const totals = statsQuery.totals.get();
    const hourlyRows = statsQuery.hourly.all(dayAgo);
    const byBucket = new Map(hourlyRows.map((r) => [Number(r.bucket), r]));

    const hourly = [];
    const firstBucket = Math.floor(dayAgo / 3600000) * 3600000;
    for (let b = firstBucket; b <= now; b += 3600000) {
      const row = byBucket.get(b);
      hourly.push({
        hour: new Date(b).toISOString(),
        requests: row ? row.requests : 0,
        tokens: row ? row.tokens : 0,
      });
    }

    const cacheHit = last24h.input_tokens > 0 ? last24h.cached_tokens / last24h.input_tokens : 0;
    return {
      today,
      last24h,
      totals,
      cache_hit_rate_24h: cacheHit,
      hourly,
      live: pool.liveSnapshot(),
      top_models: statsQuery.topModels.all(dayAgo),
    };
  });
}
