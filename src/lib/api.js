// Thin client for the BeaverBusters hub API (https://sdb.netherportal3.com/api/v1).
// The key travels only in the X-Api-Key header, never in a URL, as the API requires.
// All calls run in the background context so the key is never exposed to web pages.

export const API_BASE = 'https://sdb.netherportal3.com/api/v1';
export const CLIENT_SOURCE = 'beaverbusters-ext@' + (globalThis.chrome?.runtime?.getManifest?.().version || 'dev');

export class ApiError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message || code || `HTTP ${status}`);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

// Rate-limit bookkeeping from the X-RateLimit-* headers so callers can back off
// before the server starts refusing (default key: 120/min, 50k/day).
export const limits = { minute: null, day: null, blockedUntil: 0 };

const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];

async function slot() {
  if (active < MAX_CONCURRENT) { active++; return; }
  await new Promise(resolve => waiting.push(resolve));
  active++;
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) next();
}

export async function request(key, method, path, { query, body, timeoutMs = 20000 } = {}) {
  if (!key) throw new ApiError(401, 'no_key', 'No API key set');
  const wait = limits.blockedUntil - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, Math.min(wait, 60000)));

  let url = API_BASE + path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += '?' + s;
  }

  await slot();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-Api-Key': key,
        'Accept': 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
    const m = res.headers.get('x-ratelimit-remaining-minute');
    const d = res.headers.get('x-ratelimit-remaining-day');
    if (m !== null) limits.minute = Number(m);
    if (d !== null) limits.day = Number(d);

    let json = null;
    const text = await res.text();
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }

    if (!res.ok) {
      const retryAfter = Number(res.headers.get('retry-after')) || 0;
      if (res.status === 429) limits.blockedUntil = Date.now() + (retryAfter || 30) * 1000;
      throw new ApiError(res.status, json?.error?.code, json?.error?.message || text.slice(0, 200), retryAfter);
    }
    return json;
  } catch (e) {
    if (e.name === 'AbortError') throw new ApiError(0, 'timeout', 'The hub did not answer in time');
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'network', `Could not reach sdb.netherportal3.com (${e.message || 'network error'})`);
  } finally {
    clearTimeout(timer);
    release();
  }
}

const enc = encodeURIComponent;

export const hub = {
  me: key => request(key, 'GET', '/me'),
  rotate: key => request(key, 'POST', '/me/rotate'),
  check: (key, domain) => request(key, 'GET', '/check', { query: { domain } }),
  domain: (key, domain) => request(key, 'GET', `/domains/${enc(domain)}`, { query: { include: 'wallets,reasons,submissions' } }),
  wallet: (key, address) => request(key, 'GET', `/wallets/${enc(address)}`),
  lookup: (key, q) => request(key, 'GET', '/lookup', { query: { q } }),
  scope: (key, payload) => request(key, 'POST', '/scope', { body: payload, timeoutMs: 45000 }),
  ingest: (key, bundle) => request(key, 'POST', '/ingest', { body: bundle, timeoutMs: 45000 }),
  claim: (key, domain, hours = 24) => request(key, 'POST', `/domains/${enc(domain)}/claim`, { query: { hours }, body: { hours } }),
  release: (key, domain) => request(key, 'DELETE', `/domains/${enc(domain)}/claim`),
};
