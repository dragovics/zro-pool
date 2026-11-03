import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const dbPath = process.env.DB_PATH || './data/zro-pool.db';
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS upstream_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  concurrency_limit INTEGER NOT NULL DEFAULT 5,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  error_count INTEGER NOT NULL DEFAULT 0,
  total_requests INTEGER NOT NULL DEFAULT 0,
  total_input_tokens INTEGER NOT NULL DEFAULT 0,
  total_output_tokens INTEGER NOT NULL DEFAULT 0,
  total_cached_tokens INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gateway_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  total_requests INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  hash TEXT PRIMARY KEY,
  key_id INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  gw_key_id INTEGER,
  upstream_key_id INTEGER,
  model TEXT NOT NULL DEFAULT '',
  status INTEGER,
  upstream_status INTEGER,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_log_ts ON request_log(ts);
CREATE INDEX IF NOT EXISTS idx_sessions_last ON sessions(last_used_at);
`);

export const stmt = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  listUpstream: db.prepare('SELECT * FROM upstream_keys ORDER BY id'),
  getUpstream: db.prepare('SELECT * FROM upstream_keys WHERE id = ?'),
  insertUpstream: db.prepare('INSERT OR IGNORE INTO upstream_keys (key, label, created_at) VALUES (?, ?, ?)'),
  updateUpstreamPatch: db.prepare(`
    UPDATE upstream_keys SET
      label = COALESCE(?, label),
      enabled = COALESCE(?, enabled),
      concurrency_limit = COALESCE(?, concurrency_limit)
    WHERE id = ?`),
  resetUpstream: db.prepare(`UPDATE upstream_keys SET status = 'active', cooldown_until = 0, last_error = '', error_count = 0 WHERE id = ?`),
  deleteUpstream: db.prepare('DELETE FROM upstream_keys WHERE id = ?'),
  bumpUpstreamUsage: db.prepare(`
    UPDATE upstream_keys SET
      total_requests = total_requests + 1,
      total_input_tokens = total_input_tokens + ?,
      total_output_tokens = total_output_tokens + ?,
      total_cached_tokens = total_cached_tokens + ?,
      last_used_at = ?
    WHERE id = ?`),
  listGateway: db.prepare('SELECT * FROM gateway_keys ORDER BY id'),
  getGatewayByKey: db.prepare('SELECT * FROM gateway_keys WHERE key = ?'),
  insertGateway: db.prepare('INSERT INTO gateway_keys (key, name, created_at) VALUES (?, ?, ?)'),
  patchGateway: db.prepare('UPDATE gateway_keys SET name = COALESCE(?, name), enabled = COALESCE(?, enabled) WHERE id = ?'),
  deleteGateway: db.prepare('DELETE FROM gateway_keys WHERE id = ?'),
  bumpGatewayUsage: db.prepare('UPDATE gateway_keys SET total_requests = total_requests + 1 WHERE id = ?'),
  getSession: db.prepare('SELECT * FROM sessions WHERE hash = ?'),
  upsertSession: db.prepare(`
    INSERT INTO sessions (hash, key_id, last_used_at, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET key_id = excluded.key_id, last_used_at = excluded.last_used_at`),
  pruneSessions: db.prepare('DELETE FROM sessions WHERE last_used_at < ?'),
  insertLog: db.prepare(`
    INSERT INTO request_log (ts, gw_key_id, upstream_key_id, model, status, upstream_status, input_tokens, output_tokens, cached_tokens, duration_ms, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  pruneLogs: db.prepare('DELETE FROM request_log WHERE ts < ?'),
};

// ---- stats aggregates ----------------------------------------------------
const aggCols = `COUNT(*) AS requests,
  COALESCE(SUM(input_tokens),0) AS input_tokens,
  COALESCE(SUM(output_tokens),0) AS output_tokens,
  COALESCE(SUM(cached_tokens),0) AS cached_tokens,
  COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END),0) AS errors`;

export const statsQuery = {
  range: db.prepare(`SELECT ${aggCols} FROM request_log WHERE ts >= ?`),
  totals: db.prepare(`SELECT ${aggCols} FROM request_log`),
  hourly: db.prepare(`
    SELECT (ts / 3600000) * 3600000 AS bucket,
           COUNT(*) AS requests,
           COALESCE(SUM(input_tokens + output_tokens),0) AS tokens
    FROM request_log WHERE ts >= ?
    GROUP BY bucket ORDER BY bucket`),
  topModels: db.prepare(`
    SELECT model, COUNT(*) AS requests, COALESCE(SUM(input_tokens + output_tokens),0) AS tokens
    FROM request_log WHERE ts >= ? AND model != ''
    GROUP BY model ORDER BY requests DESC LIMIT 5`),
};

export function getSetting(name, fallback = null) {
  const row = stmt.getSetting.get(name);
  return row ? row.value : fallback;
}

export function setSetting(name, value) {
  stmt.setSetting.run(name, String(value));
}

export function startOfDayUtc() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}
