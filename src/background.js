// Background worker (Chrome service worker / Firefox event page).
// Owns the API key and every hub call; content scripts and the popup talk to it by message.

import { hub, limits, ApiError, CLIENT_SOURCE } from './lib/api.js';
import { ext, getConfig, saveSettings, DEFAULT_SETTINGS, VERDICTS, REASON_CODES } from './lib/settings.js';
import { walletVolume, usdPrices, addUsd, hasActivity, SUPPORTED as VOLUME_CHAINS } from './lib/volume.js';
import './lib/wallets.js';

const W = globalThis.BBWallets;

const DOMAIN_TTL = 10 * 60 * 1000;
const WALLET_TTL = 30 * 60 * 1000;
const MAX_WALLET_LOOKUPS = 40;   // per page, to stay well inside the per-minute key limit
const MAX_HTML_CHARS = 2_000_000;
const VOLUME_TTL = 30 * 60 * 1000;
const VOLUME_ERROR_TTL = 2 * 60 * 1000; // retry a failed explorer lookup soon
const PRICE_TTL = 10 * 60 * 1000;
const MAX_VOLUME_WALLETS = 20;   // per page

const session = ext.storage.session;
const EXT_ORIGIN = ext.runtime.getURL('');

// Keep the key out of reach of content scripts where the browser supports it (Chrome).
try { ext.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* not supported */ }
try { session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }); } catch { /* not supported */ }

// ---------- host helpers ----------

function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.hostname.toLowerCase().replace(/\.$/, '');
  } catch { return null; }
}

function canonical(host) {
  return host.startsWith('www.') ? host.slice(4) : host;
}

function isCheckable(host) {
  if (!host || !host.includes('.')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host.startsWith('[')) return false;
  if (/\.(local|localhost|internal|lan|home|test|invalid|example)$/.test(host)) return false;
  return true;
}

function isIgnored(host, ignore) {
  return ignore.some(d => host === d || host.endsWith('.' + d));
}

// ---------- session cache ----------

async function cacheGet(key, ttl) {
  const v = (await session.get(key))[key];
  return v && Date.now() - v.at < ttl ? v.data : undefined;
}
async function cacheSet(key, data) {
  await session.set({ [key]: { at: Date.now(), data } });
}
async function cacheDrop(keys) {
  await session.remove(keys);
}

const tabKey = id => 'tab:' + id;
async function getTab(tabId) {
  return (await session.get(tabKey(tabId)))[tabKey(tabId)] || null;
}
async function setTab(tabId, state) {
  await session.set({ [tabKey(tabId)]: state });
}

// De-duplicates concurrent requests for the same thing.
const inflight = new Map();
function once(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

function errInfo(e) {
  return { status: e.status ?? 0, code: e.code || 'error', message: e.message || String(e) };
}

// ---------- domain checks ----------

async function checkDomain(apiKey, host, { fresh = false } = {}) {
  const domain = canonical(host);
  const ck = 'dc:' + domain;
  if (!fresh) {
    const hit = await cacheGet(ck, DOMAIN_TTL);
    if (hit) return hit;
  }
  return once(ck, async () => {
    const res = await hub.check(apiKey, domain);
    let data = { ...res.data, checked: domain };
    // A subdomain the hub does not know may sit on a parent it does.
    const labels = domain.split('.');
    if (!data.known && labels.length >= 3) {
      const parent = labels.slice(1).join('.');
      try {
        const p = (await hub.check(apiKey, parent)).data;
        if (p?.known) data = { ...data, parent: p };
      } catch { /* parent lookup is best-effort */ }
    }
    await cacheSet(ck, data);
    return data;
  });
}

// The verdict that drives warnings: the domain's own, else a flagged parent's.
function effective(check) {
  if (!check) return null;
  if (check.known) return { verdict: check.verdict, via: check.domain, submitted: check.submitted };
  if (check.parent?.known) return { verdict: check.parent.verdict, via: check.parent.domain, submitted: check.parent.submitted, parent: true };
  return { verdict: 'not_in_hub', via: check.domain, submitted: false };
}

// ---------- wallet checks ----------

function summariseWallet(address, rows, host) {
  if (!rows || !rows.length) return { address, known: false };
  const domains = rows.flatMap(r => r.domains || []);
  const here = canonical(host || '');
  return {
    address,
    known: true,
    chain: rows[0].chain,
    excluded: rows.some(r => r.excluded),
    excludeReason: rows.find(r => r.excluded)?.exclude_reason || null,
    firstSeenBy: rows[0].first_seen_by,
    domainCount: new Set(domains.map(d => d.domain)).size,
    scamDomains: domains.filter(d => d.verdict === 'scam' || d.verdict === 'suspected').length,
    submitted: domains.some(d => d.submitted),
    onThisDomain: domains.some(d => d.domain === here),
    sampleDomains: [...new Set(domains.map(d => d.domain))].filter(d => d !== here).slice(0, 5),
  };
}

async function lookupWallet(apiKey, address) {
  const ck = 'wc:' + address;
  const hit = await cacheGet(ck, WALLET_TTL);
  if (hit !== undefined) return hit;
  return once(ck, async () => {
    let rows = [];
    try {
      rows = (await hub.wallet(apiKey, address)).data || [];
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    await cacheSet(ck, rows);
    return rows;
  });
}

async function checkWallets(apiKey, host, wallets) {
  const out = [];
  for (const w of wallets.slice(0, MAX_WALLET_LOOKUPS)) {
    // Leave headroom for the user's own lookups if the per-minute budget runs low.
    if (limits.minute !== null && limits.minute < 8) {
      out.push({ ...w, result: null, error: { code: 'rate_limited', message: 'Paused to stay within the key rate limit' } });
      continue;
    }
    try {
      const rows = await lookupWallet(apiKey, w.address);
      out.push({ ...w, result: summariseWallet(w.address, rows, host) });
    } catch (e) {
      out.push({ ...w, result: null, error: errInfo(e) });
    }
  }
  for (const w of wallets.slice(MAX_WALLET_LOOKUPS)) out.push({ ...w, result: null, error: { code: 'skipped', message: 'Too many addresses on this page' } });
  return out;
}

// ---------- wallet validation (lib/wallets.js) ----------

// Checksum-verified, or EVM without checksum casing; Solana keys have no checksum at all.
const confidenceOf = c => (c.checksum || W.EVM_CHAINS.includes(c.chain) ? 'high' : 'low');

// A page- or user-supplied string -> validated wallet record, or null if it is not a real address.
function describeWallet(raw, where) {
  const c = W.checkDetected(String(raw || '').trim());
  if (!c) return null;
  return { address: W.hubAddress(c), chain: c.chain, format: c.format, checksum: c.checksum, confidence: confidenceOf(c), where: String(where || 'manual').slice(0, 20) };
}

// Why a string was refused, in the validator's own words.
function whyInvalid(raw) {
  const s = String(raw || '').trim();
  const det = W.detectChain(s);
  if (!det.chain) return `${s.slice(0, 60)}: not a recognised wallet address.`;
  return W.validateWallet(det.chain, s).errors[0] || `${s.slice(0, 60)}: invalid.`;
}

// ---------- on-chain volume (lib/volume.js) ----------

async function prices(assets) {
  const v = (await session.get('prices')).prices;
  const have = v && Date.now() - v.at < PRICE_TTL ? v.data : {};
  const missing = [...new Set(assets)].filter(a => !(a in have));
  if (!missing.length) return have;
  const got = await usdPrices([...new Set([...Object.keys(have), ...missing])]);
  const data = { ...have, ...got };
  await session.set({ prices: { at: Date.now(), data } });
  return data;
}

async function volumeFor(w) {
  const ck = 'vol:' + w.address;
  const v = (await session.get(ck))[ck];
  if (v) {
    // Any explorer error, or a missing USD price, is retried after a short while.
    const retrySoon = v.data.errors.length > 0 || (v.data.networks.length > 0 && !v.data.pricesAt);
    if (Date.now() - v.at < (retrySoon ? VOLUME_ERROR_TTL : VOLUME_TTL)) return v.data;
  }
  return once(ck, async () => {
    const vol = await walletVolume(w.chain, w.address);
    try { addUsd(vol, await prices(vol.networks.map(n => n.asset))); } catch { vol.usdReceived = null; vol.pricesAt = null; } // the USD estimate is optional
    await cacheSet(ck, vol);
    return vol;
  });
}

// Fetch on-chain figures for a tab's wallets, store them on the tab, and push them to its widget.
async function volumesForTab(tabId) {
  const state = await getTab(tabId);
  const todo = (state?.wallets || []).filter(w => VOLUME_CHAINS.has(w.chain)).slice(0, MAX_VOLUME_WALLETS);
  const vols = {};
  const queue = [...todo];
  await Promise.all([0, 1, 2].map(async () => {
    for (let w = queue.shift(); w; w = queue.shift()) vols[w.address] = await volumeFor(w);
  }));
  // Re-read: the page may have reported more wallets meanwhile.
  const now = await getTab(tabId);
  if (now) {
    now.wallets = (now.wallets || []).map(w => (vols[w.address] ? { ...w, volume: vols[w.address] } : w));
    await setTab(tabId, now);
  }
  ext.tabs.sendMessage(tabId, { type: 'page:volumes', volumes: vols }).catch(() => null);
  return now?.wallets || [];
}

// ---------- badge ----------

const BADGE = {
  scam: ['SCAM', '#d52a2b'],
  suspected: ['SUS', '#b45309'],
  not_scam: ['OK', '#007e65'],
  out_of_scope: ['OOS', '#636e72'],
  unknown: ['?', '#636e72'],
};

async function paintBadge(tabId, state) {
  const eff = effective(state?.check);
  let text = '', color = '#0871c3', title = 'BeaverBusters checker';
  if (eff && BADGE[eff.verdict]) {
    [text, color] = BADGE[eff.verdict];
    title = `${eff.via}: ${eff.verdict.replace('_', ' ')}${eff.submitted ? ' (submitted)' : ''}${eff.parent ? ' — parent domain' : ''}`;
  } else if (state?.wallets?.length) {
    text = String(state.wallets.length);
    title = `${state.wallets.length} wallet address(es) on this page; site not in the hub`;
  } else if (eff) {
    title = `${eff.via}: not in the hub`;
  }
  if (state?.error) { text = 'ERR'; color = '#636e72'; title = 'Hub error: ' + state.error.message; }
  try {
    await ext.action.setBadgeText({ tabId, text });
    await ext.action.setBadgeBackgroundColor({ tabId, color });
    await ext.action.setTitle({ tabId, title });
  } catch { /* tab closed */ }
}

async function paintNoKey() {
  await ext.action.setBadgeText({ text: 'KEY' });
  await ext.action.setBadgeBackgroundColor({ color: '#636e72' });
  await ext.action.setTitle({ title: 'BeaverBusters checker — enter your API key to start' });
}

async function paintReady() {
  await ext.action.setBadgeText({ text: '' });
  await ext.action.setTitle({ title: 'BeaverBusters checker' });
}

// ---------- tab lifecycle ----------

async function refreshTab(tabId, url, { fresh = false } = {}) {
  const { apiKey, settings } = await getConfig();
  const host = hostOf(url);
  const prev = await getTab(tabId);
  const sameHost = prev && prev.host === host;
  const state = {
    url, host,
    check: sameHost && !fresh ? prev.check : null,
    wallets: sameHost && prev.url === url ? prev.wallets : [],
    scope: sameHost ? prev.scope : null,
    autoSubmitted: sameHost ? prev.autoSubmitted : null,
    ignored: host ? isIgnored(host, settings.ignore) : false,
    checkable: isCheckable(host),
    error: null,
  };
  if (!apiKey || !state.checkable) { await setTab(tabId, state); await paintBadge(tabId, state); return state; }

  if (settings.autoCheck || fresh) {
    try {
      state.check = await checkDomain(apiKey, host, { fresh });
    } catch (e) {
      state.error = errInfo(e);
    }
  }
  await setTab(tabId, state);
  await paintBadge(tabId, state);
  return state;
}

ext.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url || (info.status === 'loading' && tab.url)) refreshTab(tabId, info.url || tab.url);
});
ext.tabs.onRemoved.addListener(tabId => session.remove(tabKey(tabId)));

// ---------- automatic work driven by a page's wallets ----------

async function maybeAutoSubmit(apiKey, settings, tabId, state) {
  const eff = effective(state.check);
  if (!settings.autoSubmitWallets || !state.check?.known) return;
  if (eff.verdict !== 'scam' && eff.verdict !== 'suspected') return;
  const fresh = state.wallets.filter(w => w.confidence === 'high' && w.result && !w.result.onThisDomain && !w.result.excluded);
  if (!fresh.length) return;
  const sent = (await cacheGet('as:' + state.check.domain, 24 * 3600 * 1000)) || [];
  const todo = fresh.filter(w => !sent.includes(w.address));
  if (!todo.length) return;
  const now = new Date().toISOString();
  try {
    const res = await hub.ingest(apiKey, {
      domain: state.check.domain,
      source: CLIENT_SOURCE,
      wallets: todo.map(w => ({ address: w.address, source_url: state.url, method: 'extension:auto:' + w.where, seen_at: now })),
    });
    await cacheSet('as:' + state.check.domain, [...sent, ...todo.map(w => w.address)]);
    await cacheDrop(todo.map(w => 'wc:' + w.address));
    state.autoSubmitted = { at: now, count: todo.length, rejected: res?.rejected || null };
  } catch (e) {
    state.autoSubmitted = { at: now, count: 0, error: errInfo(e) };
  }
  await setTab(tabId, state);
}

async function maybeAutoScope(apiKey, settings, tabId, state) {
  if (!settings.autoScope || state.scope || !state.check || state.check.known || state.check.parent?.known) return;
  if (!state.wallets.some(w => w.confidence === 'high')) return;
  if (await cacheGet('sc:' + canonical(state.host), DOMAIN_TTL)) return;
  try {
    await runScope(apiKey, tabId, state);
  } catch { /* shown when the user opens the popup and retries */ }
}

async function pageHtml(tabId) {
  const res = await ext.tabs.sendMessage(tabId, { type: 'page:html' });
  if (!res?.html) throw new ApiError(0, 'no_page', 'Could not read this page');
  return res.html.slice(0, MAX_HTML_CHARS);
}

async function runScope(apiKey, tabId, state) {
  const html = await pageHtml(tabId);
  const res = await hub.scope(apiKey, { url: state.url, html });
  const d = res.data || {};
  state.scope = {
    at: new Date().toISOString(),
    decision: d.decision,
    in_scope: d.in_scope,
    axis: d.axis,
    reason: d.reason,
    signals: d.signals,
  };
  await cacheSet('sc:' + canonical(state.host), state.scope);
  await setTab(tabId, state);
  return state.scope;
}

// ---------- submission ----------

async function gzipBase64(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const buf = new Uint8Array(await new Response(stream).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// On-chain figures for the submitted wallets, as one hub "check" on the domain.
function volumeReport(vols, now) {
  if (!vols.length) return null;
  const round = v => (v === null || v === undefined ? null : Math.round(v * 1e8) / 1e8);
  const wallets = vols.map(v => ({
    address: v.address,
    chain: v.chain,
    checked_networks: v.checked,
    usd_received: v.usdReceived === null || v.usdReceived === undefined ? null : Math.round(v.usdReceived),
    usd_partial: !!v.usdPartial,
    errors: v.errors.map(e => ({ network: e.network, code: e.code })),
    networks: v.networks.map(n => ({
      network: n.network, asset: n.asset,
      received: round(n.received), sent: round(n.sent), balance: round(n.balance),
      tx_count: n.txCount, token_transfers: n.tokenTransfers, first_seen: n.firstSeen, last_activity: n.lastActivity,
      usd_received: n.usdReceived === null || n.usdReceived === undefined ? null : Math.round(n.usdReceived),
      tokens: n.tokens.map(t => ({ symbol: t.symbol, received: round(t.received), sent: round(t.sent), balance: round(t.balance) })),
      partial: n.partial, source: n.source,
    })),
  }));
  // funded: activity seen; no_activity: checked and empty; unknown: no explorer answered.
  const active = vols.some(v => v.networks.some(hasActivity));
  const checked = vols.some(v => v.checked?.length);
  return {
    kind: 'wallet_volume',
    result: active ? 'funded' : checked ? 'no_activity' : 'unknown',
    checked_at: vols.map(v => v.at).sort()[0] || now,
    detail: { note: 'Lifetime on-chain totals from public explorers; UTXO "received" is gross (includes change); USD at the price when checked; usd_partial marks lower bounds.', wallets },
  };
}

async function submit(apiKey, tabId, form) {
  const state = await getTab(tabId);
  if (!state?.host || !isCheckable(state.host)) throw new ApiError(0, 'bad_page', 'This page cannot be submitted');
  const now = new Date().toISOString();
  const domain = canonical(state.host);
  const raw = [...new Set((form.wallets || []).map(a => String(a).trim()).filter(Boolean))].slice(0, 500);
  // Hard gate, as in the reference validator: every address must decode and pass its checksum.
  const bad = raw.filter(a => !describeWallet(a));
  if (bad.length) throw new ApiError(0, 'invalid_wallet', bad.slice(0, 3).map(whyInvalid).join(' '));
  const byAddress = new Map((state.wallets || []).map(w => [w.address, w]));
  const wallets = [...new Map(raw.map(a => describeWallet(a, byAddress.get(a)?.where)).map(w => [w.address, w])).values()];
  const addresses = wallets.map(w => w.address);

  const bundle = {
    domain,
    source: CLIENT_SOURCE,
    found_via: 'manual',
    found_via_detail: 'browser extension',
    status: 'live',
  };
  if (VERDICTS.includes(form.verdict)) bundle.verdict = form.verdict;
  if (form.title) bundle.title = String(form.title).slice(0, 500);
  if (form.comment?.trim()) bundle.comment = form.comment.trim();
  if (addresses.length) {
    bundle.wallets = wallets.map(w => ({
      address: w.address,
      // 0x addresses are the same on every EVM chain; let the hub apply its default rather than guess.
      chain: W.EVM_CHAINS.includes(w.chain) ? undefined : w.chain,
      source_url: state.url,
      method: 'extension:' + (byAddress.get(w.address)?.where || 'manual'),
      seen_at: now,
    }));
  }
  const reasons = (form.reasons || []).filter(c => REASON_CODES.includes(c) || /^[a-z0-9_]+$/.test(c));
  if (reasons.length) {
    bundle.reasons = reasons.map(code => ({ code, detail: form.reasonDetail?.trim() || undefined, evidence_url: state.url }));
  }
  bundle.checks = [];
  if (state.scope) {
    bundle.checks.push({ kind: 'scope', result: state.scope.decision, detail: { axis: state.scope.axis, reason: state.scope.reason }, checked_at: state.scope.at });
  }
  const volumeCheck = form.includeVolume ? volumeReport(wallets.map(w => byAddress.get(w.address)?.volume).filter(Boolean), now) : null;
  if (volumeCheck) bundle.checks.push(volumeCheck);
  if (!bundle.checks.length) delete bundle.checks;
  if (form.includeHtml) {
    try {
      const html = await pageHtml(tabId);
      bundle.html = [{ url: state.url, content_gzip_b64: await gzipBase64(html), content_type: 'text/html', captured_at: now }];
    } catch { /* evidence is optional; submit the rest */ }
  }
  if (form.recordSubmission) {
    bundle.submissions = [{
      platform: form.platform?.trim() || 'scambusters',
      external_id: form.externalId?.trim() || undefined,
      status: 'submitted',
      submitted_at: now,
      wallets: addresses,
    }];
  }

  const res = await hub.ingest(apiKey, bundle);
  await cacheDrop(['dc:' + domain, ...addresses.map(a => 'wc:' + a)]);
  const fresh = await refreshTab(tabId, state.url, { fresh: true });
  fresh.wallets = state.wallets;
  if (fresh.wallets?.length) fresh.wallets = await checkWallets(apiKey, fresh.host, fresh.wallets.map(({ result, error, ...w }) => w));
  await setTab(tabId, fresh);
  await paintBadge(tabId, fresh);
  return res;
}

// ---------- messaging ----------

async function popupState(tabId) {
  const { apiKey, me, settings } = await getConfig();
  if (!apiKey) return { hasKey: false };
  const { pendingKey } = await ext.storage.local.get('pendingKey');
  if (pendingKey) return { hasKey: true, newKey: apiKey, me };
  let tab = null;
  if (tabId !== undefined) {
    const t = await ext.tabs.get(tabId).catch(() => null);
    tab = await getTab(tabId);
    if (t?.url && (!tab || tab.url !== t.url || (!tab.check && tab.checkable))) tab = await refreshTab(tabId, t.url, { fresh: !settings.autoCheck });
    if (tab) tab.title = t?.title || '';
  }
  return { hasKey: true, me, settings, limits: { ...limits }, tab, effective: effective(tab?.check) };
}

async function handleContent(msg, sender) {
  const tabId = sender.tab.id;
  const { apiKey, settings } = await getConfig();
  if (!apiKey) return { enabled: false, reason: 'no_key' };
  // Trust the browser's view of the frame URL, not the page's.
  const url = sender.url || sender.tab.url;
  let state = await getTab(tabId);
  if (!state || state.url !== url) state = await refreshTab(tabId, url);
  if (!state.checkable) return { enabled: false, reason: 'not_checkable' };
  const base = { enabled: !state.ignored, settings: { widget: settings.widget, walletScan: settings.walletScan }, effective: effective(state.check), check: state.check };

  if (msg.type === 'page:hello') return base;

  if (msg.type === 'page:wallets') {
    if (state.ignored && !msg.forced) return base;
    // Re-validate: only structurally real addresses (checksum, version, prefix) are kept.
    const incoming = (msg.wallets || []).slice(0, 200)
      .map(w => (typeof w?.address === 'string' && w.address.length <= 140 ? describeWallet(w.address, w.where) : null))
      .filter(Boolean);
    const known = new Map((state.wallets || []).map(w => [w.address, w]));
    const merged = [...known.values()];
    for (const w of incoming) if (!known.has(w.address)) { known.set(w.address, w); merged.push(w); }
    const needs = merged.filter(w => !w.result);
    const checked = needs.length ? await checkWallets(apiKey, state.host, needs) : [];
    const byAddr = new Map(checked.map(w => [w.address, w]));
    state.wallets = merged.map(w => byAddr.get(w.address) || w);
    await setTab(tabId, state);
    await paintBadge(tabId, state);
    await maybeAutoSubmit(apiKey, settings, tabId, state);
    maybeAutoScope(apiKey, settings, tabId, state);
    if (settings.volume === 'auto' && !state.ignored && state.wallets.some(w => !w.volume)) volumesForTab(tabId);
    return { ...base, wallets: state.wallets, autoSubmitted: state.autoSubmitted };
  }
  return { error: { code: 'unknown_message', message: 'Unknown message' } };
}

async function handleExtension(msg) {
  const { apiKey } = await getConfig();
  switch (msg.type) {
    case 'key:set': {
      const key = String(msg.key || '').trim();
      if (!/^[\x21-\x7e]{8,200}$/.test(key)) throw new ApiError(0, 'bad_key', 'That does not look like an API key');
      const me = (await hub.me(key)).data;
      await ext.storage.local.set({ apiKey: key, me });
      await session.clear();
      await paintReady();
      return { me };
    }
    case 'key:rotate':
      return rotateKey(apiKey);
    case 'key:noticeDone':
      await ext.storage.local.remove('pendingKey');
      return { ok: true };
    case 'key:clear':
      await ext.storage.local.remove(['apiKey', 'me', 'pendingKey']);
      await session.clear();
      await paintNoKey();
      return { ok: true };
    case 'popup:state':
      return popupState(msg.tabId);
    case 'settings:save': {
      const patch = {};
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in msg.settings) patch[k] = msg.settings[k];
      return { settings: await saveSettings(patch) };
    }
  }
  if (!apiKey) throw new ApiError(401, 'no_key', 'Enter your API key first');
  switch (msg.type) {
    case 'tab:recheck': {
      const t = await ext.tabs.get(msg.tabId);
      const st = await getTab(msg.tabId);
      if (st?.host) await cacheDrop(['dc:' + canonical(st.host), ...(st.wallets || []).map(w => 'wc:' + w.address)]);
      const state = await refreshTab(msg.tabId, t.url, { fresh: true });
      await ensureContentScript(msg.tabId);
      await ext.tabs.sendMessage(msg.tabId, { type: 'page:rescan', forced: true }).catch(() => null);
      return { tab: state };
    }
    case 'tab:scope': {
      const state = await getTab(msg.tabId);
      await ensureContentScript(msg.tabId);
      return { scope: await runScope(apiKey, msg.tabId, state) };
    }
    case 'tab:submit':
      await ensureContentScript(msg.tabId);
      return { result: await submit(apiKey, msg.tabId, msg.form) };
    case 'tab:claim': {
      const state = await getTab(msg.tabId);
      const fn = msg.release ? hub.release : hub.claim;
      const res = await fn(apiKey, canonical(state.host));
      await cacheDrop(['dc:' + canonical(state.host)]);
      await refreshTab(msg.tabId, state.url, { fresh: true });
      return { result: res };
    }
    case 'lookup': {
      const q = String(msg.q || '').trim();
      const { settings } = await getConfig();
      const wallet = describeWallet(q);
      const invalid = !wallet && W.detectChain(q).chain ? whyInvalid(q) : null;
      const [result, volume] = await Promise.all([
        hub.lookup(apiKey, wallet ? wallet.address : q).then(r => r.data),
        wallet && settings.volume !== 'off' && VOLUME_CHAINS.has(wallet.chain) ? volumeFor(wallet).catch(() => null) : null,
      ]);
      return { result, wallet, invalid, volume };
    }
    case 'tab:volumes':
      return { wallets: await volumesForTab(msg.tabId) };
  }
  throw new ApiError(0, 'unknown_message', 'Unknown message');
}

// ---------- key rotation ----------

// The hub returns the new token once. Its exact field name is not documented, so accept the
// likely shapes; anything that looks like a key is taken.
function tokenFrom(res) {
  const d = res?.data ?? res;
  const cands = typeof d === 'string' ? [d] : [d?.token, d?.key, d?.api_key, d?.secret, d?.key?.token, res?.token];
  return cands.find(t => typeof t === 'string' && /^[\x21-\x7e]{16,200}$/.test(t)) || null;
}

async function rotateKey(apiKey) {
  if (!apiKey) throw new ApiError(401, 'no_key', 'Enter your API key first');
  const res = await hub.rotate(apiKey);
  // From here on the old key is dead, so never throw away the response.
  const token = tokenFrom(res);
  if (!token) {
    await ext.storage.local.remove(['apiKey', 'me', 'pendingKey']);
    await session.clear();
    await paintNoKey();
    return { rotated: true, token: null, raw: JSON.stringify(res).slice(0, 4000) };
  }
  // Keep the new key on screen until the user confirms they saved it; the popup can close any time.
  await ext.storage.local.set({ apiKey: token, pendingKey: true });
  await session.clear();
  let me = null;
  try {
    me = (await hub.me(token)).data;
    await ext.storage.local.set({ me });
  } catch (e) {
    return { rotated: true, token, me: null, verifyError: errInfo(e) };
  }
  await paintReady();
  return { rotated: true, token, me };
}

// Pages opened before install have no content script; inject on demand.
async function ensureContentScript(tabId) {
  const ok = await ext.tabs.sendMessage(tabId, { type: 'page:ping' }).catch(() => null);
  if (ok?.pong) return;
  await ext.scripting.executeScript({ target: { tabId }, files: ['lib/wallets.js', 'content.js'] }).catch(() => null);
}

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (sender.id !== ext.runtime.id) return false;
  // Extension pages (popup) have the extension's own URL; content scripts carry the web page's.
  const fromExtension = typeof sender.url === 'string' && sender.url.startsWith(EXT_ORIGIN);
  let work;
  if (msg.type.startsWith('page:') && sender.tab && !fromExtension) work = handleContent(msg, sender);
  else if (fromExtension) work = handleExtension(msg);
  else return false;
  work.then(sendResponse, e => sendResponse({ error: errInfo(e) }));
  return true;
});

// ---------- startup ----------

async function boot() {
  const { apiKey } = await getConfig();
  if (apiKey) await paintReady(); else await paintNoKey();
}
ext.runtime.onInstalled.addListener(boot);
ext.runtime.onStartup.addListener(boot);
boot();
