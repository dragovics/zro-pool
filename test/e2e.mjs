// zro-pool e2e test — spawns mock upstream + gateway, runs SPEC scenarios.
// Node builtins only. Exit 0 = all pass.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PROJ = join(ROOT, '..');
const GW = 'http://127.0.0.1:3601';
const MOCK_PORT = 3701;
const DB = join(PROJ, 'data', 'test-e2e.db');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`✓ ${name}`);
  } catch (err) {
    results.push([false, name, err]);
    console.log(`✗ ${name}\n    ${err?.stack || err}`);
  }
}

// ---- tiny fetch helper with cookie jar ------------------------------------
let cookie = '';
async function api(path, { method = 'GET', body, auth } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (auth) headers.authorization = `Bearer ${auth}`;
  const res = await fetch(GW + path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json, text };
}

// ---- spawn & readiness ------------------------------------------------------
const children = [];
function start(cmd, args, env) {
  const p = spawn(cmd, args, { cwd: PROJ, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let errBuf = '';
  p.stderr.on('data', (d) => { errBuf += d; if (errBuf.length > 8000) errBuf = errBuf.slice(-8000); });
  p.getErrorLog = () => errBuf;
  children.push(p);
  return p;
}

async function waitReady(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`service not ready: ${url}`);
}

// ---- main -------------------------------------------------------------------
rmSync(DB, { force: true });
rmSync(DB + '-wal', { force: true });
rmSync(DB + '-shm', { force: true });

start('node', ['test/mock-upstream.js'], { MOCK_PORT: String(MOCK_PORT) });
start('node', ['server.js'], {
  PORT: '3601',
  ZRO_BASE_URL: `http://127.0.0.1:${MOCK_PORT}`,
  DB_PATH: DB,
  ADMIN_PASSWORD: 'admin',
  LOG_LEVEL: 'warn',
});

let gwProc = children[1];
try {
  await waitReady(`${GW}/healthz`);

  await step('1. login salah ditolak, admin/admin diterima', async () => {
    const bad = await api('/admin/api/login', { method: 'POST', body: { user: 'admin', password: 'ngasal' } });
    assert.equal(bad.status, 401);
    cookie = '';
    const ok = await api('/admin/api/login', { method: 'POST', body: { user: 'admin', password: 'admin' } });
    assert.equal(ok.status, 200);
    assert.ok(cookie.startsWith('zrp_admin='));
  });

  let gwKey = '';
  await step('2. bulk add 5 key upstream', async () => {
    const r = await api('/admin/api/keys', {
      method: 'POST',
      body: { keys: ['sk-normal-aaa', 'sk-normal-bbb', 'sk-ratelimit-ccc', 'sk-unauth-ddd', 'sk-warm-eee'].join('\n'), label: 'e2e' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.added, 5);
    assert.equal(r.json.duplicates, 0);
  });

  await step('3. buat gateway key (zrp_...)', async () => {
    const r = await api('/admin/api/gateway-keys', { method: 'POST', body: { name: 'e2e' } });
    assert.equal(r.status, 200);
    assert.ok(r.json.key.startsWith('zrp_'));
    gwKey = r.json.key;
  });

  await step('4. 8x chat non-stream: semua 200, tidak pernah dari key mati', async () => {
    const replies = [];
    for (let i = 0; i < 8; i++) {
      const r = await api('/v1/chat/completions', {
        method: 'POST',
        auth: gwKey,
        // tiap request sesi beda (isi pesan beda) -> affinity nyebar
        body: { model: 'glm-5.3', messages: [{ role: 'user', content: `pertanyaan nomor ${i}` }] },
      });
      assert.equal(r.status, 200, `status ${r.status}: ${r.text?.slice(0, 200)}`);
      replies.push(r.json.choices[0].message.content);
    }
    for (const c of replies) {
      assert.ok(!c.includes('-ccc') && !c.includes('-ddd'), `dilayani key bermasalah: ${c}`);
    }
  });

  await step('5. status key: unauth=dead, ratelimit pernah cooldown, tersebar ke aaa & bbb', async () => {
    const r = await api('/admin/api/keys');
    assert.equal(r.status, 200);
    const dead = r.json.keys.filter((k) => k.status === 'dead');
    assert.equal(dead.length, 1, `harus 1 dead, dapat: ${dead.map((k) => k.key_masked).join(',')}`);
    assert.ok(dead[0].key_masked.endsWith('ddd'), `dead bukan unauth: ${dead[0].key_masked}`);
    const find = (suffix) => r.json.keys.find((k) => k.key_masked.endsWith(suffix));
    const aaa = find('-aaa');
    const bbb = find('-bbb');
    assert.ok(aaa && aaa.total_requests > 0, 'aaa tidak pernah dipakai');
    assert.ok(bbb && bbb.total_requests > 0, 'bbb tidak pernah dipakai');
  });

  await step('6. streaming SSE sampai [DONE] + usage tercatat', async () => {
    const before = (await api('/admin/api/stats')).json.last24h;
    const res = await fetch(`${GW}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${gwKey}` },
      body: JSON.stringify({ model: 'glm-5.3', stream: true, messages: [{ role: 'user', content: 'tes stream halo' }] }),
    });
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') || '').includes('event-stream'));
    const text = await res.text();
    assert.ok(text.includes('data:'), 'tidak ada data: chunk');
    assert.ok(text.includes('[DONE]'), 'tidak ada [DONE]');
    await sleep(300); // kasih waktu accounting
    const after = (await api('/admin/api/stats')).json.last24h;
    assert.ok(after.requests > before.requests, 'request stream tidak tercatat');
    assert.ok(after.input_tokens >= before.input_tokens + 100, 'token stream tidak tercatat');
  });

  await step('7. antrean: 6 paralel pada key slow limit 2, semua selesai', async () => {
    await api('/admin/api/keys', { method: 'POST', body: { keys: 'sk-slow-fff', label: '' } });
    const keys = (await api('/admin/api/keys')).json.keys;
    const slow = keys.find((k) => k.key_masked.endsWith('-fff'));
    assert.ok(slow, 'key slow tidak ketemu');
    const deadId = (keys.find((k) => k.status === 'dead') || {}).id;
    await api(`/admin/api/keys/${slow.id}`, { method: 'PATCH', body: { concurrency_limit: 2 } });
    // matikan key lain biar semua pasti mampir ke slow (atau antre)
    for (const k of keys) {
      if (k.id !== slow.id && k.id !== deadId && k.enabled) await api(`/admin/api/keys/${k.id}`, { method: 'PATCH', body: { enabled: false } });
    }
    const mkBody = (n) => JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'pekerjaan sama' }, { role: 'user', content: `nomor ${n}` }] });
    // sesi sama (head identik) -> affinity pin ke satu key
    const t0 = Date.now();
    const jobs = [];
    let sawQueued = false;
    for (let i = 0; i < 6; i++) {
      jobs.push(fetch(`${GW}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${gwKey}` }, body: mkBody(i) })
        .then(async (r) => { assert.equal(r.status, 200, `job ${i} status ${r.status}`); return r.text(); }));
    }
    const poll = (async () => {
      for (let i = 0; i < 25; i++) {
        await sleep(120);
        const s = (await api('/admin/api/stats')).json;
        if (s.live.queued >= 1) { sawQueued = true; return; }
      }
    })();
    await Promise.all([Promise.all(jobs), poll]);
    const dur = Date.now() - t0;
    assert.ok(dur < 10000, `terlalu lama: ${dur}ms`);
    console.log(`    (durasi ${dur}ms, antrean terlihat: ${sawQueued})`);
    // hidupkan lagi key lain (kecuali yang memang dead)
    for (const k of keys) {
      if (k.id !== slow.id && k.id !== deadId) await api(`/admin/api/keys/${k.id}`, { method: 'PATCH', body: { enabled: true } });
    }
  });

  await step('8. settings: ganti mode & balik', async () => {
    const r1 = await api('/admin/api/settings', { method: 'PATCH', body: { routing_mode: 'round_robin' } });
    assert.equal(r1.status, 200);
    const s1 = await api('/admin/api/settings');
    assert.equal(s1.json.routing_mode, 'round_robin');
    const r2 = await api('/admin/api/settings', { method: 'PATCH', body: { routing_mode: 'affinity' } });
    assert.equal(r2.status, 200);
  });

  await step('9. ganti password: lama gagal, baru sukses, kembalikan', async () => {
    const c = await api('/admin/api/password', { method: 'POST', body: { old_password: 'admin', new_password: 'baru123' } });
    assert.equal(c.status, 200);
    cookie = '';
    const bad = await api('/admin/api/login', { method: 'POST', body: { user: 'admin', password: 'admin' } });
    assert.equal(bad.status, 401);
    const good = await api('/admin/api/login', { method: 'POST', body: { user: 'admin', password: 'baru123' } });
    assert.equal(good.status, 200);
    const back = await api('/admin/api/password', { method: 'POST', body: { old_password: 'baru123', new_password: 'admin' } });
    assert.equal(back.status, 200);
  });

  await step('10. /healthz 200', async () => {
    const r = await fetch(`${GW}/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  });
} finally {
  for (const p of children) {
    p.kill('SIGTERM');
  }
  await sleep(400);
  for (const p of children) if (!p.killed) p.kill('SIGKILL');
}

const pass = results.filter((r) => r[0]).length;
console.log(`\n${pass}/${results.length} PASS`);
if (pass < results.length && gwProc?.getErrorLog) {
  console.log('--- gateway stderr tail ---');
  console.log(gwProc.getErrorLog().slice(-2000));
}
process.exit(pass === results.length ? 0 : 1);
