// Client for the I4G ScamBusters API (https://scambuster.intelligenceforgood.org): check a site,
// submit a site with its wallets, and the key holder's own submission history. Used instead of the
// hub for those three things when Settings → API is set to I4G. The key travels only in the
// Authorization header, from the background context.

import { ApiError } from './api.js';

export const I4G_BASE = 'https://scambuster.intelligenceforgood.org';
export const I4G_HOST = 'scambuster.intelligenceforgood.org';
export const I4G_ORIGIN = I4G_BASE + '/*';
export const I4G_KEY_RE = /^sb_[0-9a-f]{32}$/;
export const I4G_MAX_WALLETS = 30;
export const I4G_KEY_DAYS = 30; // keys expire 30 days after they are issued
// Networks a 0x address can be submitted under (I4G has no Base code).
export const I4G_EVM_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'avax', 'op'];
// Our chain ids that I4G takes as they are. Avalanche X-Chain (X-avax1…) and TON are not accepted.
const SAME_CODE = new Set(['btc', 'ltc', 'doge', 'dash', 'bch', 'trx', 'xrp', 'sol', 'ada']);
// On-chain volume network names -> I4G codes, to preselect a 0x address's network.
const NETWORK_CODE = { Ethereum: 'eth', 'BNB Chain': 'bsc', Polygon: 'matic', Arbitrum: 'arb', Optimism: 'op' };

// The I4G chain code for a wallet, or null when I4G does not accept it. A 0x address takes the
// network the user picked (default Ethereum).
export function i4gChain(wallet, picked) {
  if (/^0x[0-9a-f]{40}$/i.test(wallet?.address || '')) return I4G_EVM_CHAINS.includes(picked) ? picked : 'eth';
  return SAME_CODE.has(wallet?.chain) ? wallet.chain : null;
}

// Where a 0x wallet most likely belongs: the network with the most money in, from on-chain volume.
export function i4gDefaultEvmChain(volume) {
  const nets = (volume?.networks || []).filter(n => NETWORK_CODE[n.network]);
  const best = nets.sort((a, b) => (b.usdReceived || 0) - (a.usdReceived || 0) || (b.txCount || 0) - (a.txCount || 0))[0];
  return best ? NETWORK_CODE[best.network] : 'eth';
}

// The page URL I4G gets: scheme, host and path only, so query strings (sessions, referral codes)
// are not sent.
export function i4gSiteUrl(pageUrl) {
  const u = new URL(pageUrl);
  return u.origin + u.pathname;
}

// I4G's /api/check answer, in the shape the rest of the extension uses for a site check.
export function i4gCheck(raw, domain) {
  const status = ['active', 'dead', 'pending', 'unknown'].includes(raw?.site_status) ? raw.site_status : 'unknown';
  return {
    source: 'i4g',
    checked: domain,
    domain: typeof raw?.site_key === 'string' && raw.site_key ? raw.site_key : domain,
    known: raw?.is_reported === true,
    status,
    hasWallets: raw?.has_wallets === true,
    latestWallet: typeof raw?.latest_wallet_collected_utc === 'string' ? raw.latest_wallet_collected_utc : null,
    stale: raw?.stale === true,
  };
}

// Colour and label for an I4G check: a reported live site warns like a known scam, a pending one
// like a suspected one; a dead one does not warn.
export function i4gVerdict(check) {
  if (!check?.known) return { verdict: 'not_in_hub', label: 'Not reported to I4G' };
  if (check.status === 'pending') return { verdict: 'suspected', label: 'Reported to I4G · pending' };
  if (check.status === 'dead') return { verdict: 'unknown', label: 'Reported to I4G · site dead' };
  return { verdict: 'scam', label: 'Reported to I4G' };
}

// An I4G error answer -> ApiError with a code the popup can explain. `endpoint` is check|submit|history.
export function i4gError(status, json, endpoint) {
  const said = typeof json?.error === 'string' ? json.error : '';
  if (status === 400) {
    const list = Array.isArray(json?.errors) ? json.errors.filter(e => typeof e === 'string') : [];
    return new ApiError(400, 'i4g_invalid', 'I4G refused the request: ' + (list.join(' ') || said || 'invalid request'));
  }
  if (status === 401) return new ApiError(401, 'i4g_bad_key', 'I4G did not accept the key (invalid or revoked). Get a new one with /rotate-api-key in Discord.');
  if (status === 403) {
    if (endpoint === 'submit' && /not approved/i.test(said)) {
      return new ApiError(403, 'i4g_not_approved', 'Your I4G account is not approved to submit yet: ask the I4G maintainers for submit approval, as the I4G API instructions describe. Checks still work.');
    }
    return new ApiError(403, 'i4g_key_expired', 'Your I4G key has expired (keys last 30 days). Get a new one with /rotate-api-key in Discord.');
  }
  if (status === 429) return new ApiError(429, 'i4g_rate_limited', 'I4G rate limit reached' + (said ? `: ${said}` : '') + '. Nothing was sent; try again shortly.');
  if (status === 503) return new ApiError(503, 'i4g_unavailable', "I4G's approval check is temporarily unavailable, so nothing was submitted. Try again shortly.");
  return new ApiError(status, 'i4g_error', `I4G answered HTTP ${status}${said ? ': ' + said : ''}`);
}

// Rate-limit windows per endpoint (their counters are independent). I4G sends no Retry-After, so a
// 429 pauses that endpoint for a minute; history allows one request a minute anyway.
const blockedUntil = { check: 0, submit: 0, history: 0 };
const HISTORY_GAP_MS = 61 * 1000;
let lastHistoryAt = 0;

async function request(key, method, path, endpoint, { query, body, timeoutMs = 20000 } = {}) {
  if (!I4G_KEY_RE.test(key || '')) throw new ApiError(0, 'no_i4g_key', 'Add your I4G API key (Settings) first.');
  const wait = blockedUntil[endpoint] - Date.now();
  if (wait > 0) throw new ApiError(429, 'i4g_rate_limited', `I4G rate limit reached; try again in ${Math.ceil(wait / 1000)} s.`);
  let url = I4G_BASE + path;
  if (query) url += '?' + new URLSearchParams(query).toString();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    throw new ApiError(0, e.name === 'AbortError' ? 'i4g_timeout' : 'i4g_network', `Could not reach ${I4G_HOST} (${e.name === 'AbortError' ? 'timed out' : e.message})`);
  } finally {
    clearTimeout(timer);
  }
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.status === 429) blockedUntil[endpoint] = Date.now() + 60 * 1000;
  if (res.status !== 200 && res.status !== 201) throw i4gError(res.status, json, endpoint);
  if (!json || typeof json !== 'object') throw new ApiError(res.status, 'i4g_bad_answer', `${I4G_HOST} sent an unreadable answer`);
  return json;
}

const historyCache = new Map(); // page -> { at, data }

export const i4g = {
  check: (key, site) => request(key, 'GET', '/api/check', 'check', { query: { site_url: site } }),
  // 201 queued, or 200 with status "duplicate".
  submit: (key, payload) => request(key, 'POST', '/api/submit', 'submit', { body: payload }),
  // One request a minute: a page fetched in the last minute is served from memory, and another page
  // inside that minute is refused here instead of being spent on a 429.
  async history(key, page = 1) {
    const hit = historyCache.get(page);
    if (hit && Date.now() - hit.at < HISTORY_GAP_MS) return { ...hit.data, cached: true, nextAt: lastHistoryAt + HISTORY_GAP_MS };
    const wait = lastHistoryAt + HISTORY_GAP_MS - Date.now();
    if (wait > 0) throw new ApiError(429, 'i4g_rate_limited', `I4G allows one history request a minute; try again in ${Math.ceil(wait / 1000)} s.`);
    lastHistoryAt = Date.now();
    const data = await request(key, 'GET', '/api/submission_history', 'history', { query: { page: String(page) } });
    historyCache.set(page, { at: Date.now(), data });
    return { ...data, cached: false, nextAt: lastHistoryAt + HISTORY_GAP_MS };
  },
  forget() { historyCache.clear(); lastHistoryAt = 0; },
};
