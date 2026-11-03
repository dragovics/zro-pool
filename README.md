# zro-pool — Zro API Key Pool Gateway

**zro-pool** menggabungkan banyak API key [zro.moonmath.ai](https://zro.moonmath.ai) (misal 20 key) menjadi **satu endpoint OpenAI-compatible** yang dipanggil dengan **satu gateway key** (`zrp_...`). Semua key upstream dirotasi, dijaga dari rate limit, dan dipantau lewat **dashboard admin** berbahasa Indonesia. Tersedia **3 mode routing** — `affinity` (default), `no_rotate`, dan `round_robin` — dan default-nya adalah *affinity* karena **prompt cache di Zro bersifat per-akun**: sesi yang menempel konsisten ke satu key akan mendapat cache hit jauh lebih tinggi (lebih murah & cepat) dibanding pindah-pindah key yang selalu cache-miss.

> ⚠️ **Peringatan penting:** pooling / multi-akun key berpotensi melanggar Terms of Service Zro. Lihat bagian [Keamanan & Catatan](#-keamanan--catatan).

## ✨ Fitur

- 🔄 **Rotasi & failover otomatis** — key kena 429/409/402/5xx langsung di-cooldown dan request dicoba ke key berikutnya; 401/403 menandai key `dead` (revive manual dari dashboard).
- 🔢 **Concurrency limit per key** 1–100 (default 5) — jaga kuota tiap akun.
- ⏳ **Antrean FIFO** kalau semua key penuh (timeout default 30 detik → 429), bukan langsung error.
- 🧲 **Affinity hashing** — sesi (model + system prompt + pesan pertama) dipin ke satu key; cache-friendly, sesi idle > 24 jam otomatis di-prune.
- 🌊 **Streaming SSE passthrough** byte-per-byte (`stream: true` tetap mulus).
- 📊 **Dashboard** `/admin` — login, ganti password, bulk add key, atur concurrency/enable, lihat stats harian, grafik per jam, dan **cache hit rate** per key.
- 🔑 **Bulk add keys** — tempel banyak key sekaligus (baris per key), duplikat otomatis dilewati.
- 📈 **Stats & usage** — requests, token input/output/cached, error, top models, live inflight/queued.
- 🐳 **Docker & systemd** siap pakai (`docker-compose.yml`, `deploy/zro-pool.service`, `deploy/Caddyfile`).

## 🚀 Quickstart (lokal)

Prasyarat: **Node.js >= 20**.

```bash
node -v          # harus >= 20
npm install
npm start
```

Lalu:

1. Buka dashboard: **http://localhost:3600/admin**
2. Login `admin` / `admin` → **WAJIB ganti password segera** (menu ganti password di dashboard).
3. Tab **Keys** → bulk add API key Zro Anda (satu key per baris).
4. Tab **Gateway Keys** → buat gateway key baru (format `zrp_...`).
5. Point klien/tool Anda ke endpoint (lihat bawah). Selesai.

Cek kesehatan service: `curl http://localhost:3600/healthz` → `{"ok":true,...}`.

## 🔌 Cara Pakai Endpoint

Endpoint client kompatibel OpenAI: semua `METHOD /v1/*` diteruskan ke `ZRO_BASE_URL` dengan key upstream yang dipilih pool. Auth pakai **gateway key** (`Authorization: Bearer zrp_...`).

```bash
# Chat completion (non-stream)
curl http://localhost:3600/v1/chat/completions \
  -H "Authorization: Bearer zrp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "glm-5.3",
    "messages": [{"role": "user", "content": "Halo, apa kabar?"}]
  }'

# Streaming (SSE)
curl http://localhost:3600/v1/chat/completions \
  -H "Authorization: Bearer zrp_..." \
  -H "Content-Type: application/json" \
  -d '{"model":"glm-5.3","stream":true,"messages":[{"role":"user","content":"Halo"}]}'

# Daftar model
curl http://localhost:3600/v1/models -H "Authorization: Bearer zrp_..."
```

Di VPS, ganti `localhost` dengan IP VPS. Contoh lewat OpenAI SDK (Node.js):

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://VPS-IP:3600/v1",   // titik akhir zro-pool
  apiKey: "zrp_xxxxxxxxxxxxxxxx",      // gateway key, BUKAN key Zro
});

const res = await client.chat.completions.create({
  model: "glm-5.3",
  messages: [{ role: "user", content: "Halo!" }],
});
console.log(res.choices[0].message.content);
```

Di tool lain (LibreChat, Cherry Studio, SillyTavern, dsb.) isikan:

| Setting | Nilai |
|---|---|
| Base URL | `http://VPS-IP:3600/v1` (atau `https://your-domain.com/v1` jika pakai Caddy) |
| API Key | `zrp_...` (gateway key) |
| Model | mis. `glm-5.3` |

## 🖥️ Deploy di VPS

### Docker (rekomendasi)

```bash
git clone <repo-anda> zro-pool && cd zro-pool   # atau rsync kode ke VPS
cp .env.example .env
nano .env                # WAJIB: ganti ADMIN_PASSWORD
docker compose up -d --build
```

- Dashboard: `http://VPS-IP:3600/admin` (login `admin`/`admin` — **GANTI SEGERA**).
- Database SQLite tersimpan di named volume `zro_data`, aman walau container di-rebuild.
- Lihat log: `docker compose logs -f`.

### systemd + Caddy (HTTPS otomatis)

1. Ikuti langkah install di komentar atas [`deploy/zro-pool.service`](deploy/zro-pool.service) (ringkas: install Node 20, taruh kode di `/opt/zro-pool`, `npm install --omit=dev`, buat user `zro-pool`, salin `.env`, `systemctl enable --now zro-pool`).
2. Pasang Caddy, arahkan DNS domain ke VPS, lalu pakai [`deploy/Caddyfile`](deploy/Caddyfile):

   ```bash
   sudo apt install -y caddy
   sudo cp deploy/Caddyfile /etc/caddy/Caddyfile   # ganti your-domain.com
   sudo systemctl reload caddy
   ```

3. Pastikan `TRUST_PROXY=1` di `.env`, lalu `sudo systemctl restart zro-pool`.
4. Dashboard jadi `https://your-domain.com/admin` — Caddy mengurus sertifikat HTTPS otomatis.

## ⚙️ Environment Variables

| Var | Default | Keterangan |
|---|---|---|
| `PORT` | `3600` | Port HTTP |
| `ADMIN_USER` | `admin` | Username dashboard |
| `ADMIN_PASSWORD` | `admin` | Password awal (di-seed kalau settings kosong) |
| `ZRO_BASE_URL` | `https://zro.moonmath.ai` | Origin upstream, TANPA `/v1` |
| `DB_PATH` | `./data/zro-pool.db` | Lokasi file SQLite |
| `TRUST_PROXY` | (kosong) | Set `1` kalau di belakang reverse proxy |
| `LOG_LEVEL` | `info` | Log level pino |

Lihat [`.env.example`](.env.example) untuk contoh + komentar lengkap.

## 🧭 Mode Routing

Diatur dari dashboard (**Settings**), berlaku global.

| Mode | Cara kerja | Kapan dipakai |
|---|---|---|
| **`affinity`** (default) | Hash sesi (`model` + `messages[0]`/system + pesan non-system pertama, max 2000 char) dipin ke satu key upstream. Kalau key pin sedang cooldown/penuh → pilih key eligible lain & re-pin. | Workload chat/conversational yang berulang dengan prompt serupa. **Maksimalkan prompt cache** Zro (cache per akun) → token lebih murah & TTFB lebih cepat. Cocok untuk mayoritas pemakaian. |
| **`no_rotate`** | Selalu pakai key dengan id terkecil yang eligible (key "primary"). Kalau error → failover ke berikutnya; opsi `failback` (default on) otomatis balik ke primary setelah cooldown habis. | Mau "menguras" key satu per satu: jaga cache tetap hangat di satu akun selama mungkin, key lain hanya cadangan. |
| **`round_robin`** | Kursor berputar, tiap request ke key eligible berikutnya. | Mau sebar beban & kuota setara ke semua key, dan tidak peduli cache hit. |

Definisi **eligible**: enabled, status tidak `dead`, tidak sedang cooldown, dan `inflight < concurrency_limit`.

## 🧪 Testing

```bash
npm test
```

Suite e2e ini **spawn mock upstream sendiri** (`test/mock-upstream.js`, pure `node:http`) plus instance server sungguhan — **tanpa key asli, tanpa internet**. Skenario mencakup: login, bulk add, distribusi request, 429/401 handling (cooldown & dead), streaming SSE + pencatatan usage, antrean saat concurrency penuh, ganti mode routing, ganti password, dan `/healthz`. Exit code `0` = semua pass.

## 🔐 Keamanan & Catatan

- **Ganti password default segera.** `admin`/`admin` hanya untuk setup pertama. Login dibatasi 5 percobaan gagal per IP (kunci 60 detik).
- **Gateway key adalah rahasia** — perlakukan seperti password. Revoked/disable kapan saja dari dashboard.
- **Selalu pakai HTTPS di produksi** (contoh Caddy disertakan, sertifikat otomatis). Jangan expose `3600` polos ke internet kalau bisa; set `TRUST_PROXY=1` di belakang proxy.
- **Backup = salin file SQLite** di `DB_PATH` (default `./data/zro-pool.db`; volume `zro_data` di Docker). Request log di-prune otomatis 7 hari.
- ⚠️ **PERINGATAN ToS:** penggunaan banyak akun / pooling key Zro **berpotensi melanggar Terms of Service** Zro. Risiko terburuk: **semua akun di-banned massal** sekaligus. Pakai dengan sadar dan tanggung jawab resikonya.
- 📊 Semua **data usage per key** (total request, token input/output/cached, cache hit rate, jumlah error) kelihatan transparan di dashboard — berguna untuk memantau akun mana yang boros/mendekati batas.

---

License: MIT · Lihat [SPEC.md](SPEC.md) untuk kontrak teknis lengkap.
