import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { getSetting, setSetting } from './db.js';

const COOKIE_NAME = 'zrp_admin';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sessionSecret() {
  let s = getSetting('session_secret');
  if (!s) {
    s = randomBytes(32).toString('hex');
    setSetting('session_secret', s);
  }
  return s;
}

// ---- password hashing (scrypt) ------------------------------------------
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const candidate = scryptSync(String(password), salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

// ---- signed session tokens ----------------------------------------------
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export function issueSession(user) {
  const payload = b64u(JSON.stringify({ u: user, exp: Date.now() + SESSION_TTL_MS }));
  const sig = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.exp || data.exp < Date.now()) return null;
    return data.u;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  const secure = process.env.TRUST_PROXY === '1' ? '; Secure' : ''; // HTTPS via reverse proxy
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}

export function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readAdminUser(request) {
  const cookies = parseCookies(request.headers.cookie);
  return verifySession(cookies[COOKIE_NAME]);
}

// ---- tiny login rate limiter (per IP, in-memory) -------------------------
const fails = new Map(); // ip -> { count, until }

export function loginAllowed(ip) {
  const rec = fails.get(ip);
  if (rec && rec.until > Date.now()) return false;
  return true;
}

export function recordLoginFailure(ip) {
  const rec = fails.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  if (rec.count >= 5) {
    rec.until = Date.now() + 60_000;
    rec.count = 0;
  }
  fails.set(ip, rec);
}

export function clearLoginFailures(ip) {
  fails.delete(ip);
}
