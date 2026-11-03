# Zro Pool — Specification (kontrak internal)

Gateway proxy untuk pool API key zro.moonmath.ai. Satu service Node.js (ESM, tanpa build step).
Bahasa UI dashboard: **Indonesia**. Komentar kode: Inggris ringkas.

## Stack & runtime
- Node.js >= 20 (di mesin dev: v24). ESM (`"type":"module"`).
- Dependencies HANYA: `fastify`, `better-sqlite3`. Mock upstream & e2e test: **node builtins saja** (http, child_process, assert). Dashboard: **zero dependency** (vanilla HTML/CSS/JS, tanpa CDN).
- Storage: SQLite di `DB_PATH` (default `./data/zro-pool.db`).

## Environment variables
| Var | Default | Keterangan |
|---|---|---|
| PORT | 3600 | Port HTTP |
| ADMIN_USER | admin | Username dashboard |
| ADMIN_PASSWORD | admin | Password awal (di-seed kalau settings kosong) |
| ZRO_BASE_URL | https://zro.moonmath.ai | Origin upstream, TANPA `/v1` |
| DB_PATH | ./data/zro-pool.db | Lokasi file SQLite |
| TRUST_PROXY | (kosong) | Set `1` kalau di belakang reverse proxy |
| LOG_LEVEL | info | Log level pino |

## Semantik inti
- **Routing mode** (settings `routing_mode`): `affinity` (default) | `no_rotate` | `round_robin`.
  - `affinity`: hash sesi (sha256 dari `model` + `messages[0]` (biasanya system) + isi pesan non-system pertama, max 2000 char) dipin ke satu key upstream; kalau key pin lagi cooldown/penuh → pilih key eligible lain & re-pin. Sesi idle > 24 jam di-prune.
  - `no_rotate`: pakai key dengan id terkecil yang eligible (primary). Failover ke berikutnya kalau error. Setting `failback` (default `true`): otomatis balik ke primary setelah cooldown habis; kalau `false`, tetap di key pengganti sampai key itu error.
  - `round_robin`: kursor berputar, pilih eligible berikutnya.
- **Eligible** = enabled && status != dead && now >= cooldown_until && inflight < concurrency_limit.
- **Failover triggers** dari upstream: HTTP 429 (cooldown = `Retry-After` detik atau 60s), 409 & 402 (cooldown 300s), 401/403 (status = dead, hanya bisa di-revive manual), 5xx/network error (cooldown 15s). Semua → langsung coba key berikutnya (maks percobaan = jumlah key aktif).
- **Concurrency per key**: `concurrency_limit` 1–100, default 5. Kalau SEMUA key penuh → request **antre FIFO maksimal `queue_timeout_ms`** (default 30000) → lewat itu ditolak 429 JSON.
- **Streaming**: SSE di-passthrough byte-per-byte; inflight dilepas & usage dicatat saat stream selesai (scan best-effort field `usage` di chunk SSE).
- Gateway key format: `zrp_` + 48 hex. Disimpan plaintext (perlu ditampilkan lagi di dashboard).
- Retensi `request_log`: 7 hari (prune tiap 10 menit).

## Endpoint client (OpenAI-compatible)
- `POST/GET/... /v1/*` → diteruskan ke `ZRO_BASE_URL` + path yang sama, dengan `Authorization: Bearer <upstream key>`.
- Body diteruskan **byte-identik** (jangan re-serialize) — penting untuk prefix cache.
- `GET /healthz` → `{ok:true, uptime}` (tanpa auth).
- Auth: `Authorization: Bearer zrp_...` (gateway key, cek enabled).
- Error JSON client: 401 key invalid; 429 `{error:{message, type:"rate_limit_error"}}` (antrean timeout); 502 semua upstream gagal.

## Admin API (semua JSON, cookie auth `zrp_admin`, HttpOnly SameSite=Lax)
Kecuali `login`/`logout`, semua butuh cookie valid (401 kalau tidak).

- `POST /admin/api/login` `{user, password}` → 200 `{ok:true}` + Set-Cookie; salah → 401 `{error}`. Rate limit login: 5 gagal per IP → kunci 60s (429).
- `POST /admin/api/logout` → `{ok:true}` (clear cookie)
- `GET  /admin/api/session` → `{user}` | 401
- `POST /admin/api/password` `{old_password, new_password}` (min 4 char) → `{ok:true}`
- `GET  /admin/api/keys` → `{keys:[{id, label, key_masked, enabled, status, concurrency_limit, inflight, cooldown_remaining_ms, last_error, error_count, total_requests, total_input_tokens, total_output_tokens, total_cached_tokens, cache_hit_rate, last_used_at}]}`
  - `key_masked`: `sk-abc...wxyz` (4 pertama + 4 terakhir)
  - `cache_hit_rate`: total_cached/total_input (0 kalau belum ada)
- `POST /admin/api/keys` `{keys:"baris1\nbaris2", label:""}` → `{added:N, duplicates:N}` (bulk add; abaikan duplikat)
- `PATCH /admin/api/keys/:id` `{concurrency_limit?, enabled?, label?}` → `{ok:true}` (validasi 1–100)
- `DELETE /admin/api/keys/:id` → `{ok:true}`
- `POST /admin/api/keys/:id/reset` → `{ok:true}` (status=active, cooldown=0, error dikosongkan)
- `GET  /admin/api/gateway-keys` → `{keys:[{id, key, name, enabled, total_requests, created_at}]}` (key FULL, bukan masked)
- `POST /admin/api/gateway-keys` `{name}` → `{id, key}` (generate `zrp_`+48hex)
- `PATCH /admin/api/gateway-keys/:id` `{enabled?, name?}` → `{ok:true}`
- `DELETE /admin/api/gateway-keys/:id` → `{ok:true}`
- `GET  /admin/api/settings` → `{routing_mode, queue_timeout_ms, failback, upstream_base_url, version}`
- `PATCH /admin/api/settings` `{routing_mode?, queue_timeout_ms?, failback?}` → `{ok:true}` (routing_mode enum, queue_timeout 1000–300000, failback bool)
- `GET  /admin/api/stats` →
```json
{
  "today":   {"requests":0,"input_tokens":0,"output_tokens":0,"cached_tokens":0,"errors":0},
  "last24h": {"requests":0,"input_tokens":0,"output_tokens":0,"cached_tokens":0,"errors":0},
  "totals":  {"requests":0,"input_tokens":0,"output_tokens":0,"cached_tokens":0},
  "cache_hit_rate_24h": 0.0,
  "hourly":  [{"hour":"2026-11-03T14:00:00.000Z","requests":0,"tokens":0}],
  "live":    {"inflight":0,"queued":0,"active_keys":0,"cooldown_keys":0,"dead_keys":0},
  "top_models": [{"model":"glm-5.3","requests":0,"tokens":0}]
}
```
  (`hourly` = 24 bucket terakhir, `tokens` = input+output)

## Static dashboard
- `GET /admin` → `public/index.html`; `GET /admin/app.js`, `/admin/style.css` (content-type benar, no-cache). 404 kalau file lain.

## Mock upstream (`test/mock-upstream.js`) — node:http ONLY, port `MOCK_PORT` (default 3700)
`POST /v1/chat/completions`, Bearer key (perilaku berdasarkan isi key):
- mengandung `ratelimit` → 429 + header `Retry-After: 1`, body `{"error":{"message":"rate limited"}}`
- mengandung `unauth` → 401
- mengandung `flaky` → 500 pada hit ke-1,2; 200 pada hit ke-3 dst (counter global per key)
- mengandung `slow` → delay 1200ms lalu 200
- mengandung `warm` → 200 dengan `usage.prompt_tokens_details.cached_tokens = 80`
- lainnya → 200 `{"id":"chatcmpl-mock","choices":[{"message":{"role":"assistant","content":"halo dari <4 char akhir key>"}}],"usage":{"prompt_tokens":100,"completion_tokens":20}}`
- `stream:true` (dari body JSON) → `text/event-stream`: beberapa chunk `data: {"choices":[{"delta":{"content:"..."}}]}` lalu `data: {"usage":{...}}` (shape OpenAI) lalu `data: [DONE]`
- `GET /v1/models` → `{"object":"list","data":[{"id":"glm-5.3"},{"id":"glm-5.3-air"}]}`

## E2E test (`test/e2e.mjs`) — node builtins ONLY
Spawn `node test/mock-upstream.js` (MOCK_PORT=3701) + `node server.js` (PORT=3601, ZRO_BASE_URL=http://127.0.0.1:3701, DB_PATH=./data/test-e2e.db — hapus dulu file db lama, ADMIN_PASSWORD=admin), jalankan skenario, kill children di akhir (exit code 0 = semua pass):
1. Login salah → 401; `admin/admin` → 200 + cookie
2. Bulk add 5 key mock: `sk-normal-aaa`, `sk-normal-bbb`, `sk-ratelimit-ccc`, `sk-unauth-ddd`, `sk-warm-eee` → added 5
3. Create gateway key → mulai `zrp_`
4. 8x POST /v1/chat/completions non-stream → semua 200; tidak pernah konten dari key `unauth`/`ratelimit`
5. GET /admin/api/keys: key unauth status `dead`; ratelimit pernah cooldown; distribution: normal-aaa & normal-bbb keduanya dapat request
6. 1x stream (curl-style fetch, baca sampai `[DONE]`) → dapet SSE + setelah itu stats last24h.requests bertambah & token tercatat
7. Set concurrency `sk-normal-aaa` = 1 dan `sk-normal-bbb` = 1; POST 6x paralel dengan body `slow` key? (buat key `sk-slow-fff` dulu, limit 2) → semua selesai < 10s, dan saat berjalan `/admin/api/stats` live.queued >= 1 minimal sekali
8. PATCH settings routing_mode → `round_robin` lalu balik `affinity` → ok
9. POST /admin/api/password (admin→baru123) → password lama gagal login, baru sukses; kembalikan ke admin
10. GET /healthz → 200

## Kepemilikan file (jangan sentuh milik orang lain!)
- Backend (ditulis pemilik proyek): `server.js`, `lib/*.js`, `routes/*.js`, `package.json`, `.gitignore`
- Subagent A: `public/index.html`, `public/app.js`, `public/style.css`
- Subagent B: `test/mock-upstream.js`, `test/e2e.mjs`
- Subagent C: `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `.env.example`, `README.md`, `deploy/zro-pool.service`, `deploy/Caddyfile`
