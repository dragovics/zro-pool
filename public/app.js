'use strict';
/* zro-pool admin dashboard — vanilla JS, zero dependency, ES2022. UI: Bahasa Indonesia. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  user: null,
  section: 'ringkasan',
  stats: null,
  keys: [],
  gatewayKeys: [],
  selectedGwId: null,
  settings: null,
};

/* ================= helpers ================= */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

const nfInt = new Intl.NumberFormat('id-ID');
const nfCompact = new Intl.NumberFormat('id-ID', { notation: 'compact', maximumFractionDigits: 1 });
const nfPct = new Intl.NumberFormat('id-ID', { style: 'percent', maximumFractionDigits: 1 });

const fmtInt = (n) => nfInt.format(Number(n) || 0);
const fmtCompact = (n) => nfCompact.format(Number(n) || 0);
const fmtPct = (x) => nfPct.format(Number(x) || 0);
const fmtTime = (ts) =>
  ts ? new Date(ts).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '—';
const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

function busy(form, on) {
  const btn = form.querySelector('button[type="submit"]');
  if (btn) btn.disabled = on;
}

/* ================= API ================= */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await fetch(`/admin/api${path}`, {
      method,
      headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Tidak dapat terhubung ke server');
  }
  let data = null;
  try { data = await res.json(); } catch { /* body kosong */ }
  if (res.status === 401) {
    if (state.user) toast('Sesi berakhir, silakan login lagi', 'err');
    state.user = null;
    showLogin();
    throw new ApiError(401, data?.error || 'belum login');
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `HTTP ${res.status}`);
  return data;
}

function handleErr(e) {
  if (e instanceof ApiError && e.status === 401) return; // sudah ditangani api()
  toast(e?.message || 'Terjadi kesalahan', 'err');
}

/* ================= toast & clipboard ================= */

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 350);
  }, 3500);
}

async function copyText(btn, text) {
  let ok = false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      ok = true;
    }
  } catch {
    ok = false;
  }
  if (!ok) {
    // fallback untuk konteks non-secure / clipboard API tidak tersedia
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.append(ta);
      ta.select();
      ok = document.execCommand('copy');
      ta.remove();
    } catch {
      ok = false;
    }
  }
  if (ok) flashBtn(btn);
  else toast('Gagal menyalin ke clipboard', 'err');
}

function flashBtn(btn, msg = 'Tersalin!') {
  if (btn.dataset.origText == null) {
    btn.dataset.origText = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('ok-flash');
    setTimeout(() => {
      btn.textContent = btn.dataset.origText;
      delete btn.dataset.origText;
      btn.classList.remove('ok-flash');
    }, 1500);
  }
}

/* ================= views & navigasi ================= */

function show(el, on) {
  el.classList.toggle('hidden', !on);
}

function showLogin() {
  show($('#view-app'), false);
  show($('#view-login'), true);
  $('#login-err').classList.add('hidden');
  $('#login-pass').value = '';
  $('#login-user').focus();
}

function showApp() {
  show($('#view-login'), false);
  show($('#view-app'), true);
  $('#user-chip').textContent = state.user || '';
  setSection(state.section || 'ringkasan', false);
}

function setSection(name, fetch = true) {
  state.section = name;
  $$('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  $$('.section').forEach((s) => { s.hidden = s.dataset.name !== name; });
  if (!state.user || !fetch) return;
  if (name === 'ringkasan') refreshOverview();
  else if (name === 'keys') loadKeys();
  else if (name === 'gateway') loadGateway();
  else if (name === 'settings') loadSettings();
  else if (name === 'endpoint') renderEndpoint();
}

/* ================= Ringkasan ================= */

async function refreshOverview() {
  try {
    state.stats = await api('/stats');
    renderStats();
  } catch (e) {
    handleErr(e);
  }
}

function renderStats() {
  const s = state.stats;
  if (!s) return;
  const l = s.last24h ?? {};
  const live = s.live ?? {};

  $('#stat-req').textContent = fmtInt(l.requests);
  $('#stat-req-sub').textContent = `${fmtInt(l.errors)} error`;

  $('#stat-tok-in').textContent = fmtCompact(l.input_tokens);
  $('#stat-tok-in-sub').textContent = `${fmtInt(l.input_tokens)} token`;

  $('#stat-tok-out').textContent = fmtCompact(l.output_tokens);
  $('#stat-tok-out-sub').textContent = `${fmtInt(l.output_tokens)} token`;

  $('#stat-cache').textContent = fmtPct(s.cache_hit_rate_24h);
  $('#stat-cache-sub').textContent = `${fmtCompact(l.cached_tokens)} token dari cache`;

  const pills = [
    ['green', `${fmtInt(live.active_keys)} aktif`],
    ['orange', `${fmtInt(live.cooldown_keys)} cooldown`],
    ['red', `${fmtInt(live.dead_keys)} dead`],
  ];
  $('#stat-keys').innerHTML = pills
    .map(([c, t]) => `<span class="pill"><span class="dot ${c}"></span>${t}</span>`)
    .join('');
  $('#stat-keys-sub').textContent = live.paused_keys ? `${fmtInt(live.paused_keys)} dijeda` : '';

  $('#stat-live').textContent = `${fmtInt(live.inflight)} / ${fmtInt(live.queued)}`;
  $('#stat-live-sub').textContent = 'inflight / antre (realtime)';

  const tm = (s.top_models ?? []).slice(0, 8);
  $('#top-models').innerHTML = tm.length
    ? `<div class="table-scroll"><table class="tbl">
        <thead><tr><th>Model</th><th>Requests</th><th>Token</th></tr></thead>
        <tbody>${tm.map((m) => `<tr>
          <td class="mono">${esc(m.model) || '—'}</td>
          <td>${fmtInt(m.requests)}</td>
          <td>${fmtCompact(m.tokens)}</td></tr>`).join('')}
        </tbody></table></div>`
    : '<div class="empty">Belum ada data model 24 jam terakhir.</div>';

  drawChart($('#chart'), s.hourly ?? []);
}

const CHART_FONT = '11px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

function drawChart(canvas, hourly) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(120, canvas.clientWidth || 600);
  const h = Math.max(80, canvas.clientHeight || 240);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 46;
  const padR = 6;
  const padT = 8;
  const padB = 22;
  const iw = w - padL - padR;
  const ih = h - padT - padB;
  const vals = hourly.map((b) => Number(b.requests) || 0);
  const max = Math.max(1, ...vals);
  const steps = 4;

  // grid + label sumbu Y
  ctx.font = CHART_FONT;
  for (let i = 0; i <= steps; i++) {
    const y = padT + ih - (ih * i) / steps;
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.12)';
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR, y);
    ctx.stroke();
    ctx.fillStyle = 'rgba(139, 152, 173, 0.9)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(nfCompact.format(Math.round((max * i) / steps)), padL - 6, y);
  }

  if (!vals.length) {
    ctx.fillStyle = 'rgba(139, 152, 173, 0.9)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Belum ada data', padL + iw / 2, padT + ih / 2);
    return;
  }

  const n = vals.length;
  const bw = iw / n;
  const now = Date.now();
  const labelEvery = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i++) {
    const v = vals[i];
    const bh = v > 0 ? Math.max(2, (v / max) * ih) : 0;
    const x = padL + i * bw;
    const y = padT + ih - bh;
    const bucketEnd = new Date(hourly[i].hour).getTime() + 3600000;
    ctx.fillStyle = bucketEnd > now ? 'rgba(96, 165, 250, 0.95)' : 'rgba(96, 165, 250, 0.5)';
    ctx.fillRect(x + 1, y, Math.max(1, bw - 2), bh);
    if (i % labelEvery === 0) {
      const d = new Date(hourly[i].hour);
      ctx.fillStyle = 'rgba(139, 152, 173, 0.9)';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(`${String(d.getHours()).padStart(2, '0')}:00`, x + bw / 2, padT + ih + 5);
    }
  }
}

/* ================= Key Upstream ================= */

async function loadKeys() {
  try {
    const { keys } = await api('/keys');
    state.keys = keys;
    const tbody = $('#keys-tbody');
    const focused = tbody.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
    if (focused) $('#keys-count').textContent = `${keys.length} key`; // jangan ganggu input yang sedang diedit
    else renderKeys();
  } catch (e) {
    handleErr(e);
  }
}

function statusBadge(k) {
  if (k.status === 'cooldown') {
    const until = Date.now() + (Number(k.cooldown_remaining_ms) || 0);
    const secs = Math.max(0, Math.ceil((Number(k.cooldown_remaining_ms) || 0) / 1000));
    return `<span class="badge orange" data-cd="${until}">cooldown&nbsp;<span class="cd-s">${secs}</span>s</span>`;
  }
  if (k.status === 'dead') return '<span class="badge red">dead</span>';
  if (k.status === 'paused') return '<span class="badge gray">dijeda</span>';
  return '<span class="badge green">aktif</span>';
}

function renderKeys() {
  const tbody = $('#keys-tbody');
  $('#keys-count').textContent = `${state.keys.length} key`;
  if (!state.keys.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">Belum ada key upstream. Tambahkan lewat form di bawah.</td></tr>';
    return;
  }
  tbody.innerHTML = state.keys.map((k) => {
    const err = k.last_error
      ? `<span class="err-text" title="${esc(k.last_error)} (${fmtInt(k.error_count)} error)">${esc(trunc(k.last_error, 26))}</span>`
      : '<span class="muted">—</span>';
    return `<tr data-id="${k.id}">
      <td><div class="key-cell">
        <span class="mono">${esc(k.key_masked)}</span>
        ${k.label ? `<span class="label-chip" title="${esc(k.label)}">${esc(k.label)}</span>` : ''}
      </div></td>
      <td>${statusBadge(k)}</td>
      <td class="conc-cell"><span class="inflight">${fmtInt(k.inflight)}</span> /
        <input class="conc-input" type="number" min="1" max="100" step="1"
          value="${k.concurrency_limit}" data-prev="${k.concurrency_limit}" data-id="${k.id}"
          title="Concurrency limit (1–100), ubah lalu tekan Enter">
      </td>
      <td>${fmtPct(k.cache_hit_rate)}</td>
      <td>${fmtInt(k.total_requests)}</td>
      <td class="mono small" title="input / output / cached">
        ${fmtCompact(k.total_input_tokens)} / ${fmtCompact(k.total_output_tokens)} / ${fmtCompact(k.total_cached_tokens)}
      </td>
      <td class="small">${err}</td>
      <td class="actions">
        <button class="btn tiny" type="button" data-action="toggle-key" data-id="${k.id}" data-enabled="${k.enabled ? 1 : 0}">${k.enabled ? 'Jeda' : 'Lanjut'}</button>
        <button class="btn tiny" type="button" data-action="reset-key" data-id="${k.id}">Reset</button>
        <button class="btn tiny danger" type="button" data-action="del-key" data-id="${k.id}">Hapus</button>
      </td>
    </tr>`;
  }).join('');
}

async function toggleKey(id, enabled) {
  try {
    await api(`/keys/${id}`, { method: 'PATCH', body: { enabled: !enabled } });
    toast(enabled ? 'Key dijeda' : 'Key dilanjutkan');
    await loadKeys();
  } catch (e) {
    handleErr(e);
  }
}

async function resetKey(id) {
  try {
    await api(`/keys/${id}/reset`, { method: 'POST' });
    toast('Key direset ke aktif');
    await loadKeys();
    refreshOverview();
  } catch (e) {
    handleErr(e);
  }
}

async function deleteKey(id) {
  try {
    await api(`/keys/${id}`, { method: 'DELETE' });
    toast('Key dihapus');
    await loadKeys();
    refreshOverview();
  } catch (e) {
    handleErr(e);
  }
}

/* konfirmasi dua langkah (tanpa dialog native) */
function armDelete(btn, fn) {
  if (btn.dataset.armed === '1') {
    delete btn.dataset.armed;
    fn();
    return;
  }
  btn.dataset.armed = '1';
  btn.dataset.origText = btn.textContent;
  btn.textContent = 'Yakin?';
  btn.classList.add('armed');
  setTimeout(() => {
    if (btn.dataset.armed === '1') {
      delete btn.dataset.armed;
      btn.textContent = btn.dataset.origText;
      delete btn.dataset.origText;
      btn.classList.remove('armed');
    }
  }, 3000);
}

/* ================= Key Gateway ================= */

async function loadGateway() {
  try {
    const { keys } = await api('/gateway-keys');
    state.gatewayKeys = keys;
    renderGateway();
    renderEndpoint();
  } catch (e) {
    handleErr(e);
  }
}

function renderGateway() {
  const wrap = $('#gw-list');
  $('#gw-count').textContent = `${state.gatewayKeys.length} key`;
  if (!state.gatewayKeys.length) {
    wrap.innerHTML = '<div class="empty">Belum ada gateway key. Buat lewat form di atas.</div>';
    return;
  }
  wrap.innerHTML = state.gatewayKeys.map((k) => `
    <div class="gw-item ${k.enabled ? '' : 'disabled'}" data-id="${k.id}">
      <div class="gw-main">
        <div class="gw-name">
          ${esc(k.name) || '<span class="muted">(tanpa nama)</span>'}
          ${k.enabled ? '<span class="badge green">aktif</span>' : '<span class="badge gray">nonaktif</span>'}
        </div>
        <div class="gw-key-row">
          <code class="mono small">${esc(k.key)}</code>
          <button class="btn tiny" type="button" data-action="copy-key" data-key="${esc(k.key)}">Salin</button>
        </div>
        <div class="muted small">${fmtInt(k.total_requests)} request · dibuat ${fmtTime(k.created_at)}</div>
      </div>
      <div class="gw-actions">
        <button class="btn tiny" type="button" data-action="gw-toggle" data-id="${k.id}" data-enabled="${k.enabled ? 1 : 0}">${k.enabled ? 'Nonaktifkan' : 'Aktifkan'}</button>
        <button class="btn tiny danger" type="button" data-action="gw-del" data-id="${k.id}">Hapus</button>
      </div>
    </div>`).join('');
}

async function toggleGateway(id, enabled) {
  try {
    await api(`/gateway-keys/${id}`, { method: 'PATCH', body: { enabled: !enabled } });
    toast(enabled ? 'Gateway key dinonaktifkan' : 'Gateway key diaktifkan');
    await loadGateway();
  } catch (e) {
    handleErr(e);
  }
}

async function deleteGateway(id) {
  try {
    await api(`/gateway-keys/${id}`, { method: 'DELETE' });
    toast('Gateway key dihapus');
    if (state.selectedGwId === id) state.selectedGwId = null;
    await loadGateway();
  } catch (e) {
    handleErr(e);
  }
}

/* ================= Pengaturan ================= */

const ROUTING_DESC = {
  affinity: 'Cache-Affinity (rekomendasi) — sesi nempel di satu key agar cache panas.',
  no_rotate: 'No-Rotate — pakai key utama, failover kalau error.',
  round_robin: 'Round-Robin — putar merata semua key.',
};

async function loadSettings() {
  try {
    const s = await api('/settings');
    state.settings = s;
    $('#set-routing').value = s.routing_mode;
    $('#routing-desc').textContent = ROUTING_DESC[s.routing_mode] ?? '';
    $('#set-timeout').value = String(s.queue_timeout_ms / 1000);
    $('#set-failback').checked = !!s.failback;
    $('#settings-info').textContent = `Upstream: ${s.upstream_base_url} · Versi: ${s.version}`;
  } catch (e) {
    handleErr(e);
  }
}

/* ================= Endpoint ================= */

function curlExample(base, key) {
  return `curl ${base}/chat/completions \\\n` +
    `  -H "Authorization: Bearer ${key}" \\\n` +
    `  -d '{"model":"glm-5.3","messages":[{"role":"user","content":"halo"}]}'`;
}

function renderEndpoint() {
  const base = `${window.location.origin}/v1`;
  $('#ep-base').textContent = base;

  const sel = $('#ep-key-select');
  const keys = state.gatewayKeys;

  if (!keys.length) {
    sel.innerHTML = '<option value="">— belum ada gateway key —</option>';
    state.selectedGwId = null;
    $('#ep-key-code').textContent = '—';
    $('#ep-hint').textContent = 'Buat gateway key dulu di tab "Key Gateway".';
    $('#ep-curl').textContent = curlExample(base, 'zrp_GANTI_DENGAN_GATEWAY_KEY');
    return;
  }

  sel.innerHTML = keys
    .map((k) => `<option value="${k.id}">${esc(k.name || 'tanpa nama')} — ${esc(k.key.slice(0, 16))}…${k.enabled ? '' : ' (nonaktif)'}</option>`)
    .join('');
  if (!keys.some((k) => k.id === state.selectedGwId)) state.selectedGwId = keys[0].id;
  sel.value = String(state.selectedGwId);

  const key = keys.find((k) => k.id === state.selectedGwId);
  $('#ep-key-code').textContent = key ? key.key : '—';
  $('#ep-hint').textContent =
    'Arahkan base_url klien OpenAI-compatible ke Base URL di atas, dan pakai gateway key ini sebagai API key.';
  $('#ep-curl').textContent = curlExample(base, key ? key.key : 'zrp_...');
}

/* ================= event handlers ================= */

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const act = btn.dataset.action;
  switch (act) {
    case 'nav':
      btn.blur();
      setSection(btn.dataset.section);
      break;
    case 'copy': {
      const target = document.getElementById(btn.dataset.target);
      if (target) copyText(btn, target.textContent);
      break;
    }
    case 'copy-key':
      copyText(btn, btn.dataset.key);
      break;
    case 'copy-curl':
      copyText(btn, $('#ep-curl').textContent);
      break;
    case 'toggle-key':
      toggleKey(Number(btn.dataset.id), btn.dataset.enabled === '1');
      break;
    case 'reset-key':
      resetKey(Number(btn.dataset.id));
      break;
    case 'del-key':
      armDelete(btn, () => deleteKey(Number(btn.dataset.id)));
      break;
    case 'gw-toggle':
      toggleGateway(Number(btn.dataset.id), btn.dataset.enabled === '1');
      break;
    case 'gw-del':
      armDelete(btn, () => deleteGateway(Number(btn.dataset.id)));
      break;
    default:
  }
});

document.addEventListener('change', (ev) => {
  const el = ev.target;

  // edit concurrency inline pada tabel key upstream
  if (el.classList.contains('conc-input')) {
    const v = Number(el.value);
    if (!Number.isInteger(v) || v < 1 || v > 100) {
      toast('Concurrency harus bilangan bulat 1–100', 'err');
      el.value = el.dataset.prev ?? 5;
      return;
    }
    const id = el.dataset.id;
    el.disabled = true;
    api(`/keys/${id}`, { method: 'PATCH', body: { concurrency_limit: v } })
      .then(() => {
        el.dataset.prev = v;
        toast(`Concurrency diubah ke ${v}`);
      })
      .catch((e) => {
        handleErr(e);
        el.value = el.dataset.prev ?? 5;
      })
      .finally(() => { el.disabled = false; });
    return;
  }

  if (el.id === 'ep-key-select') {
    state.selectedGwId = Number(el.value) || null;
    renderEndpoint();
  }
});

/* ---- login ---- */

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const errEl = $('#login-err');
  errEl.classList.add('hidden');
  const user = $('#login-user').value.trim();
  const password = $('#login-pass').value;
  busy(form, true);
  try {
    await api('/login', { method: 'POST', body: { user, password } });
    state.user = user;
    bootData();
    showApp();
    toast(`Selamat datang, ${user}`);
  } catch (e) {
    errEl.textContent = e.message || 'Login gagal';
    errEl.classList.remove('hidden');
  } finally {
    busy(form, false);
  }
});

/* ---- tambah key upstream ---- */

$('#add-key-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  busy(form, true);
  try {
    const r = await api('/keys', {
      method: 'POST',
      body: { keys: $('#add-keys-text').value, label: $('#add-key-label').value.trim() },
    });
    toast(`${r.added} key ditambahkan, ${r.duplicates} duplikat`);
    $('#add-keys-text').value = '';
    $('#add-key-label').value = '';
    await loadKeys();
    refreshOverview();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy(form, false);
  }
});

/* ---- buat gateway key ---- */

$('#gw-create-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  busy(form, true);
  try {
    const r = await api('/gateway-keys', { method: 'POST', body: { name: $('#gw-name').value.trim() } });
    state.selectedGwId = r.id;
    toast('Gateway key baru dibuat');
    $('#gw-name').value = '';
    await loadGateway();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy(form, false);
  }
});

/* ---- pengaturan ---- */

$('#set-routing').addEventListener('change', () => {
  $('#routing-desc').textContent = ROUTING_DESC[$('#set-routing').value] ?? '';
});

$('#settings-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  const seconds = Number($('#set-timeout').value);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 300) {
    toast('Queue timeout harus 1–300 detik', 'err');
    return;
  }
  busy(form, true);
  try {
    await api('/settings', {
      method: 'PATCH',
      body: {
        routing_mode: $('#set-routing').value,
        queue_timeout_ms: Math.round(seconds * 1000),
        failback: $('#set-failback').checked,
      },
    });
    toast('Pengaturan disimpan');
    await loadSettings();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    busy(form, false);
  }
});

/* ---- ganti password ---- */

function pwErr(msg) {
  const el = $('#pw-err');
  el.textContent = msg;
  el.classList.remove('hidden');
}

$('#password-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = ev.currentTarget;
  $('#pw-err').classList.add('hidden');
  const oldPassword = $('#pw-old').value;
  const newPassword = $('#pw-new').value;
  const confirmPassword = $('#pw-confirm').value;
  if (newPassword.length < 4) {
    pwErr('Password baru minimal 4 karakter');
    return;
  }
  if (newPassword !== confirmPassword) {
    pwErr('Konfirmasi password tidak cocok');
    return;
  }
  busy(form, true);
  try {
    await api('/password', { method: 'POST', body: { old_password: oldPassword, new_password: newPassword } });
    toast('Password berhasil diganti');
    form.reset();
  } catch (e) {
    if (e.status !== 401) pwErr(e.message);
  } finally {
    busy(form, false);
  }
});

/* ---- logout ---- */

$('#logout-btn').addEventListener('click', async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch {
    /* lanjut keluar meskipun gagal */
  }
  state.user = null;
  showLogin();
  toast('Anda telah keluar');
});

/* ================= polling & tickers ================= */

function bootData() {
  refreshOverview();
  loadKeys();
  loadGateway();
  loadSettings();
}

// auto-refresh Ringkasan + Key Upstream tiap 10 detik (hanya saat tab terlihat & sudah login)
setInterval(() => {
  if (!state.user || document.visibilityState !== 'visible') return;
  refreshOverview();
  loadKeys();
}, 10000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) {
    refreshOverview();
    loadKeys();
  }
});

// countdown badge "cooldown Ns" tiap detik
setInterval(() => {
  const now = Date.now();
  $$('[data-cd]').forEach((el) => {
    const s = el.querySelector('.cd-s');
    if (s) s.textContent = String(Math.max(0, Math.ceil((Number(el.dataset.cd) - now) / 1000)));
  });
}, 1000);

// gambar ulang chart saat ukuran berubah
let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state.stats) drawChart($('#chart'), state.stats.hourly ?? []);
  }, 150);
});

/* ================= boot ================= */

(async () => {
  try {
    const s = await api('/session');
    state.user = s.user;
    bootData();
    showApp();
  } catch {
    showLogin();
  }
})();
