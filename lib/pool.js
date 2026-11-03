import { stmt, getSetting } from './db.js';
import { db } from './db.js';

// Failover classification for upstream statuses.
export const COOLDOWN_MS = { rate_limit: 60_000, account: 300_000, server: 15_000 };

export class QueueTimeoutError extends Error {
  constructor() {
    super('semua key upstream sedang sibuk (antrean timeout)');
    this.name = 'QueueTimeoutError';
  }
}

class KeyState {
  constructor(row) {
    Object.assign(this, row);
    this.inflight = 0; // live in-memory counter
  }
  get effectiveStatus() {
    const now = Date.now();
    if (!this.enabled) return 'paused';
    if (this.status === 'dead') return 'dead';
    if (this.cooldown_until > now) return 'cooldown';
    return 'active';
  }
  isEligible() {
    const now = Date.now();
    return this.enabled && this.status !== 'dead' && this.cooldown_until <= now && this.inflight < this.concurrency_limit;
  }
}

const persistFailure = db.prepare(`
  UPDATE upstream_keys SET status = ?, cooldown_until = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?`);

export class KeyPool {
  constructor() {
    this.keys = new Map(); // id -> KeyState
    this.rrCursor = 0; // next start index for round_robin
    this.stickyPrimaryId = null; // no_rotate + failback=false
    this.waiters = []; // FIFO: {resolve, timer}
    this._load();
  }

  _load() {
    for (const row of stmt.listUpstream.all()) this.keys.set(row.id, new KeyState(row));
  }

  _notify() {
    // Wake FIFO waiters; each re-checks eligibility itself.
    for (const w of this.waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  _wait(timeoutMs) {
    return new Promise((resolve, reject) => {
      const w = { resolve, timer: setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new QueueTimeoutError());
      }, timeoutMs) };
      this.waiters.push(w);
    });
  }

  get orderedIds() {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  /** True when at least one key is enabled and not dead (cooldown is fine). */
  anyUsable() {
    for (const k of this.keys.values()) {
      if (k.enabled && k.status !== 'dead') return true;
    }
    return false;
  }

  /** Ordered candidate list per routing mode (eligible check happens later). */
  _candidates(mode, sessionHash) {
    const all = this.orderedIds.map((id) => this.keys.get(id));

    if (mode === 'no_rotate') {
      // sticky primary only applies when auto-failback is disabled
      const failbackOn = getSetting('failback', '1') === '1';
      if (!failbackOn && this.stickyPrimaryId != null && this.keys.has(this.stickyPrimaryId)) {
        const sticky = this.keys.get(this.stickyPrimaryId);
        return [sticky, ...all.filter((k) => k.id !== sticky.id)];
      }
      return all; // ascending id = primary first
    }

    if (mode === 'round_robin') {
      const n = all.length;
      if (!n) return [];
      const start = ((this.rrCursor % n) + n) % n;
      return all.slice(start).concat(all.slice(0, start));
    }

    // affinity: pinned key first, then least-busy / oldest-used
    if (sessionHash) {
      const pin = stmt.getSession.get(sessionHash);
      if (pin && this.keys.has(pin.key_id)) {
        const pinned = this.keys.get(pin.key_id);
        const rest = this._leastBusy(all.filter((k) => k.id !== pinned.id));
        return [pinned, ...rest];
      }
    }
    return this._leastBusy(all);
  }

  _leastBusy(list) {
    return [...list].sort((a, b) => (a.inflight - b.inflight) || (a.last_used_at - b.last_used_at));
  }

  /**
   * Acquire a key lease. FIFO-queues up to queueTimeoutMs when every key is at
   * its concurrency cap. Throws QueueTimeoutError on timeout.
   */
  async acquire({ sessionHash = null, mode = 'affinity', queueTimeoutMs = 30_000 } = {}) {
    const deadline = Date.now() + queueTimeoutMs;
    for (;;) {
      const candidates = this._candidates(mode, sessionHash);
      for (let i = 0; i < candidates.length; i++) {
        const key = candidates[i];
        if (key.isEligible()) {
          key.inflight += 1;
          if (mode === 'round_robin') {
            const ids = this.orderedIds;
            this.rrCursor = (ids.indexOf(key.id) + 1) % Math.max(1, ids.length);
          }
          if (mode === 'no_rotate' && getSetting('failback', '1') !== '1') {
            this.stickyPrimaryId = key.id;
          }
          return this._lease(key, mode, sessionHash);
        }
      }
      if (!this.anyUsable()) throw new QueueTimeoutError(); // no usable key at all — fail fast
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new QueueTimeoutError();
      await this._wait(Math.min(remaining, 5_000));
    }
  }

  _lease(key, mode, sessionHash) {
    let released = false;
    return {
      key,
      release() {
        if (released) return;
        released = true;
        key.inflight = Math.max(0, key.inflight - 1);
        pool._notify();
      },
      commitSession() {
        if (mode === 'affinity' && sessionHash) {
          const now = Date.now();
          stmt.upsertSession.run(sessionHash, key.id, now, now);
        }
      },
    };
  }

  /** kind: 'rate_limit' | 'account' (409/402) | 'auth' (401/403) | 'server' (5xx/network) */
  markFailure(keyId, kind, message, retryAfterSec = null) {
    const key = this.keys.get(keyId);
    if (!key) return;
    const msg = String(message || kind).slice(0, 300);
    if (kind === 'auth') {
      key.status = 'dead';
      key.cooldown_until = 0;
    } else {
      const base = kind === 'rate_limit'
        ? (retryAfterSec ? retryAfterSec * 1000 : COOLDOWN_MS.rate_limit)
        : (COOLDOWN_MS[kind] ?? COOLDOWN_MS.server);
      key.status = 'active';
      key.cooldown_until = Date.now() + base;
    }
    key.last_error = msg;
    key.error_count += 1;
    persistFailure.run(key.status, key.cooldown_until, msg, keyId);
    this._notify();
  }

  /** Keep in-memory counters fresh so least-busy/affinity sorting spreads. */
  markSuccess(keyId, usage) {
    const key = this.keys.get(keyId);
    if (!key) return;
    key.last_used_at = Date.now();
    key.total_requests += 1;
    if (usage) {
      key.total_input_tokens += usage.input || 0;
      key.total_output_tokens += usage.output || 0;
      key.total_cached_tokens += usage.cached || 0;
    }
  }

  liveSnapshot() {
    let active = 0, cooldown = 0, dead = 0, paused = 0, inflight = 0;
    for (const k of this.keys.values()) {
      inflight += k.inflight;
      const s = k.effectiveStatus;
      if (s === 'active') active++;
      else if (s === 'cooldown') cooldown++;
      else if (s === 'dead') dead++;
      else paused++;
    }
    return { inflight, queued: this.waiters.length, active_keys: active, cooldown_keys: cooldown, dead_keys: dead, paused_keys: paused };
  }

  /** Sync user edits (add/remove/patch) from db without losing live counters. */
  reloadKeys() {
    const seen = new Set();
    for (const row of stmt.listUpstream.all()) {
      seen.add(row.id);
      const existing = this.keys.get(row.id);
      if (existing) Object.assign(existing, row, { inflight: existing.inflight });
      else this.keys.set(row.id, new KeyState(row));
    }
    for (const id of [...this.keys.keys()]) if (!seen.has(id)) this.keys.delete(id);
    this._notify();
  }

  pruneSessions() {
    stmt.pruneSessions.run(Date.now() - 24 * 60 * 60 * 1000);
  }
}

export const pool = new KeyPool();
