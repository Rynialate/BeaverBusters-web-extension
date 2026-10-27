import { ext, REASON_CODES, HUB_ORIGIN, ACCESS_ORIGINS } from '../lib/settings.js';
import { i4gChain, i4gDefaultEvmChain, i4gSiteUrl, I4G_EVM_CHAINS, I4G_KEY_RE, I4G_MAX_WALLETS, I4G_KEY_DAYS } from '../lib/i4g.js';
import '../lib/wallets.js';

const W = globalThis.BBWallets;

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let tabId;
let state = null;

async function call(msg) {
  const res = await ext.runtime.sendMessage(msg);
  if (res?.error) throw Object.assign(new Error(res.error.message), res.error);
  return res;
}

function setMsg(el, text, kind = '') {
  el.textContent = text;
  el.className = 'msg ' + kind;
}

function friendly(e) {
  if (e.code === 'no_host_access' || /^(i4g_|no_i4g)/.test(e.code || '')) return e.message;
  if (/Receiving end does not exist|Could not establish connection/i.test(e.message || '')) {
    return "The extension's background part is not running, so nothing reached the hub. Reload the extension (chrome://extensions or about:debugging) and try again.";
  }
  if (e.status === 401 || e.code === 'unauthorized') return 'The hub refused the key: ' + e.message;
  if (e.status === 403) return 'Your key is not allowed to do that: ' + e.message;
  if (e.status === 429) return 'Rate limit reached; try again shortly.';
  return e.message || 'Something went wrong';
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } finally { btn.disabled = false; }
}

// ---------- site access ----------

async function checkAccess() {
  let hub = true, sites = true;
  try {
    hub = await ext.permissions.contains({ origins: [HUB_ORIGIN] });
    sites = await ext.permissions.contains({ origins: ['<all_urls>'] });
  } catch { /* no permissions API: nothing to ask for */ }
  const banner = $('accessBanner');
  if (hub && sites) { banner.hidden = true; return { hub, sites }; }
  $('accessText').textContent = !hub
    ? 'The browser has not given BeaverBusters access to sdb.netherportal3.com, so it cannot check your key or any site. Allow access, then accept the browser\'s prompt.'
    : 'Page scanning is off: the browser has not given BeaverBusters access to websites. Allow access to find wallets on pages.';
  banner.classList.toggle('warn', !hub);
  const view = [$('keyView'), $('mainView')].find(v => !v.hidden);
  if (view) view.querySelector('.bar').after(banner);
  banner.hidden = false;
  return { hub, sites };
}

// Must run straight from a click: browsers only show the permission prompt for a user action.
// Resolves at once, without a prompt, when access is already granted.
const requestAccess = () => ext.permissions.request({ origins: ACCESS_ORIGINS }).catch(() => false);

$('accessBtn').onclick = () => { requestAccess().then(() => checkAccess()).then(() => load()); };

// ---------- key prompt ----------

function showKeyView(message) {
  $('mainView').hidden = true;
  $('newKeyView').hidden = true;
  $('keyView').hidden = false;
  checkAccess();
  if (message) setMsg($('keyMsg'), message, 'err');
  $('keyInput').focus();
}

$('keyShow').onchange = e => { $('keyInput').type = e.target.checked ? 'text' : 'password'; };

$('keyForm').onsubmit = e => {
  e.preventDefault();
  const access = requestAccess(); // first, while this still counts as a user action
  setMsg($('keyMsg'), 'Checking key with the hub…');
  busy($('keySave'), async () => {
    await access;
    if (!(await checkAccess()).hub) {
      setMsg($('keyMsg'), 'BeaverBusters needs access to sdb.netherportal3.com to check the key. Click "Allow access" and accept the browser\'s prompt.', 'err');
      return;
    }
    try {
      const { me } = await call({ type: 'key:set', key: $('keyInput').value });
      $('keyInput').value = '';
      $('keyRaw').hidden = true;
      $('keyRaw').textContent = '';
      setMsg($('keyMsg'), `Welcome, ${me.handle}.`, 'ok');
      await load();
    } catch (err) {
      setMsg($('keyMsg'), friendly(err), 'err');
    }
  });
};

$('changeKey').onclick = async () => {
  if (!confirm('Remove the saved API key from this browser? The extension stops working until a key is entered again.')) return;
  await call({ type: 'key:clear' });
  showKeyView();
};

// ---------- main view ----------

const VERDICT_TEXT = {
  scam: 'Known scam', suspected: 'Suspected scam', not_scam: 'Not a scam', out_of_scope: 'Out of scope',
  unknown: 'In hub, unrated', not_in_hub: 'Not in the hub',
};

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? '' : d.toLocaleString();
}

function renderStatus() {
  const tab = state.tab;
  const box = $('status');
  $('hostName').textContent = tab?.host || 'No page';
  const disable = !tab?.checkable;
  for (const id of ['scopeBtn', 'claimBtn', 'submitBtn', 'recheck']) $(id).disabled = disable;

  if (!tab || !tab.checkable) {
    box.innerHTML = `<span class="verdict v-none">Not checkable</span><p class="muted small">Only public http(s) sites can be checked.</p>`;
    return;
  }
  if (tab.error) {
    const fromI4g = /^(i4g_|no_i4g)/.test(tab.error.code || '');
    box.innerHTML = `<span class="verdict v-none">${fromI4g ? 'I4G error' : 'Hub error'}</span><p class="small">${esc(friendly(tab.error))}</p>`;
    if (tab.error.code === 'no_i4g_key') $('i4gKeyForm').hidden = false;
    else if (tab.error.status === 401 && !fromI4g) showKeyView('Your saved key stopped working. Enter a new one.');
    return;
  }
  const c = tab.check;
  if (!c) {
    box.innerHTML = `<span class="verdict v-none">Not checked</span><p class="muted small">Automatic checks are off. Press ↻ to check this site.</p>`;
    return;
  }
  const eff = state.effective;
  if (c.source === 'i4g') return renderI4gStatus(tab, c, eff);
  const rec = c.known ? c : c.parent;
  let html = `<span class="verdict v-${esc(eff.verdict)}">${esc(VERDICT_TEXT[eff.verdict] || eff.verdict)}</span>`;
  if (eff.parent) html += ` <span class="small">via parent <b>${esc(eff.via)}</b></span>`;
  if (tab.ignored) html += ` <span class="small muted">· ignored site</span>`;
  if (rec) {
    html += `<dl>
      <dt>Submitted</dt><dd>${rec.submitted ? `Yes — ${esc((rec.submitted_by || []).join(', ') || 'unknown')}${rec.first_submitted_at ? ' · ' + esc(fmtDate(rec.first_submitted_at)) : ''}` : '<b>No</b>'}</dd>
      <dt>Status</dt><dd>${esc(rec.status || '—')}</dd>
      <dt>Wallets</dt><dd>${esc(rec.wallet_count ?? 0)} on record</dd>
      <dt>Points</dt><dd>${esc(rec.points_total ?? 0)}</dd>
      <dt>Claimed</dt><dd>${rec.claimed_by ? `${esc(rec.claimed_by)} until ${esc(fmtDate(rec.claim_expires_at))}` : 'No'}</dd>
      <dt>Last check</dt><dd>${esc(fmtDate(rec.last_checked_at) || '—')}</dd>
    </dl>`;
    const mine = rec.claimed_by && state.me && rec.claimed_by === state.me.handle;
    $('claimBtn').textContent = mine ? 'Release claim' : 'Claim 24 h';
    $('claimBtn').dataset.release = mine ? '1' : '';
  } else {
    html += `<p class="small muted">Nobody has added this site yet. If it is a scam, submit it below.</p>`;
    $('claimBtn').textContent = 'Claim 24 h';
    $('claimBtn').dataset.release = '';
  }
  if (tab.autoSubmitted?.count) html += `<p class="small muted">Auto-added ${tab.autoSubmitted.count} wallet(s) ${esc(fmtDate(tab.autoSubmitted.at))}.</p>`;
  box.innerHTML = html;
  if (tab.scope) renderScope(tab.scope);
}

// Site status from I4G's /api/check (Check & submit with: I4G).
function renderI4gStatus(tab, c, eff) {
  let html = `<span class="verdict v-${esc(eff.verdict)}">${esc(eff.label)}</span>`;
  if (tab.ignored) html += ` <span class="small muted">· ignored site</span>`;
  if (c.known) {
    html += `<dl>
      <dt>Status</dt><dd>${esc(c.status)}</dd>
      <dt>Wallets</dt><dd>${c.hasWallets ? `On record${c.latestWallet ? ' · newest ' + esc(fmtDate(c.latestWallet)) : ''}` : 'None collected yet'}</dd>
      <dt>Site key</dt><dd>${esc(c.domain)}</dd>
    </dl>`;
    if (c.stale) html += `<p class="small">The newest wallet on record is over 30 days old. Scammers rotate wallets, so fresh ones are worth submitting.</p>`;
  } else {
    html += `<p class="small muted">I4G has never received this site. If it is a scam, submit it below.</p>`;
  }
  $('status').innerHTML = html;
  if (tab.scope) renderScope(tab.scope);
}

function walletTags(w) {
  const r = w.result;
  if (!r) return `<span class="tag t-grey">${esc(w.error?.code || 'pending')}</span>` + insightTags(w.volume);
  if (!r.known) return `<span class="tag t-info">NEW</span>` + insightTags(w.volume);
  let t = r.scamDomains ? `<span class="tag t-scam">${r.scamDomains} scam site(s)</span>` : `<span class="tag t-grey">${r.domainCount} site(s)</span>`;
  if (r.onThisDomain) t += `<span class="tag t-grey">on this site</span>`;
  if (r.submitted) t += `<span class="tag t-warn">submitted</span>`;
  if (r.excluded) t += `<span class="tag t-grey" title="${esc(r.excludeReason || '')}">excluded</span>`;
  return t + insightTags(w.volume);
}

// Chips from the on-chain analysis (see volumeHtml for the details).
function insightTags(v) {
  if (!v || v.loading) return '';
  let t = '';
  if (v.txCount > 0) t += `<span class="tag t-grey" title="${esc(txBreakdown(v))}">${esc(fmtCount(v.txCount))}${v.txCountPartial ? '+' : ''} txs</span>`;
  if (v.service) t += `<span class="tag t-info" title="${esc(serviceText(v.service))}">likely exchange</span>`;
  if (v.tags?.some(x => x.risky)) t += `<span class="tag t-scam">explorer: ${esc(v.tags.find(x => x.risky).label)}</span>`;
  if (v.poisoning?.length) t += `<span class="tag t-warn">address poisoning</span>`;
  return t;
}

// ---------- on-chain volume ----------

function fmtAmount(n) {
  if (n === null || n === undefined) return '—';
  const a = Math.abs(n);
  const digits = a >= 1000 ? 0 : a >= 1 ? 4 : 8;
  return Number(n.toFixed(digits)).toLocaleString(undefined, { maximumFractionDigits: digits });
}
const fmtUsd = n => '$' + Math.round(n).toLocaleString();
const fmtUsdShort = n => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : fmtUsd(n));
const shortAddr = a => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
const fmtCount = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

// "Ethereum: 14 · BNB Chain: 100+ transactions"
function txBreakdown(v) {
  return v.networks.filter(n => Number.isFinite(n.txCount)).map(n => `${n.network}: ${n.txCount.toLocaleString()}${n.txCountPartial ? '+' : ''}`).join(' · ') + ' transactions';
}

function serviceText(s) {
  return s.reasons.map(r => (r.kind === 'tag' ? `tagged “${r.label}” on ${r.source}`
    : r.kind === 'tx_count' ? `${r.value.toLocaleString()}${r.partial ? '+' : ''} transactions`
    : r.kind === 'balance_usd' ? `holds ≈ ${fmtUsdShort(r.value)}` : `≈ ${fmtUsdShort(r.value)} received`)).join(' · ');
}

// One example in full, then the totals: "0x8cbdb5…1dc0 imitates 0x8cbd37…1dc0 (Ethereum); 7 look-alikes of 4 addresses in all".
function poisoningText(list) {
  const reals = new Set(list.map(p => `${p.real}|${p.network}`));
  const p = list[0];
  let t = `${shortAddr(p.fake)} imitates ${shortAddr(p.real)} (${p.network})`;
  if (list.length > 1) t += `; ${list.length} look-alikes of ${reals.size} address${reals.size === 1 ? '' : 'es'} in all`;
  return t;
}

function ago(when) {
  const s = (Date.now() - new Date(when).getTime()) / 1000;
  if (!isFinite(s)) return '';
  if (s < 3600) return 'within the hour';
  if (s < 86400) return Math.floor(s / 3600) + ' h ago';
  if (s < 86400 * 60) return Math.floor(s / 86400) + ' days ago';
  if (s < 86400 * 730) return Math.floor(s / (86400 * 30)) + ' months ago';
  return Math.floor(s / (86400 * 365)) + ' years ago';
}

// "EVM" is a property of the 0x form (Avalanche X-Chain addresses are bech32, not EVM).
const chainText = w => (/^0x/i.test(w.address || '') ? 'EVM (0x)' : W.chainLabel(w.chain));

function volumeHtml(v) {
  if (!v) return '';
  if (v.loading) return `<div class="vol muted">Checking on-chain activity…</div>`;
  const out = [];
  const flags = [];
  for (const t of (v.tags || []).filter(x => x.risky)) flags.push(`<div class="flag f-scam">${esc(t.source)} tags this address “${esc(t.label)}”.</div>`);
  if (v.service) flags.push(`<div class="flag f-svc"><b>Likely an exchange or service wallet:</b> ${esc(serviceText(v.service))}. Probably not the scammer's own wallet: check before submitting it.</div>`);
  if (v.poisoning?.length) flags.push(`<div class="flag f-poison"><b>Address poisoning:</b> ${esc(poisoningText(v.poisoning))}. They send dust so the wrong address gets copied from the history.</div>`);
  if (v.usdReceived || v.usdSent) {
    const plus = v.usdPartial || v.usdMissing?.length ? '+' : '';
    const parts = [v.usdReceived ? `${fmtUsd(v.usdReceived)}${plus} in` : null, v.usdSent ? `${fmtUsd(v.usdSent)}${plus} moved out` : null].filter(Boolean);
    const missing = v.usdMissing?.length ? `; ${v.usdMissing.join(', ')} not priced` : '';
    out.push(`<b>≈ ${esc(parts.join(' · '))}</b> <span class="muted">(at today's prices${v.usdPartial ? '; at least this much' : ''}${esc(missing)})</span>`);
  } else if (v.usdMissing?.length) {
    out.push(`<span class="muted">No USD estimate: prices for ${esc(v.usdMissing.join(', '))} could not be loaded.</span>`);
  }
  const withSenders = v.networks.filter(n => n.senders > 0);
  if (withSenders.length > 1) out.push(`From ${v.senders.toLocaleString()}${v.sendersPartial ? '+' : ''} distinct senders <span class="muted">(non-dust payments in, summed over networks)</span>`);
  for (const n of v.networks) {
    const bits = [];
    const np = n.partial ? '+' : '';
    if (n.received !== null) bits.push(`in ${fmtAmount(n.received)}${np} ${n.asset}`);
    if (n.sent !== null) bits.push(`out ${fmtAmount(n.sent)}${np}`);
    if (n.balance !== null) bits.push(`balance ${fmtAmount(n.balance)} ${n.asset}`);
    if (n.txCount !== null) bits.push(`${n.txCount.toLocaleString()}${n.txCountPartial ? '+' : ''} txs`);
    if (n.tokenTransfers > 0) bits.push(`${n.tokenTransfers.toLocaleString()}${n.tokenTransfersPartial ? '+' : ''} token transfers`);
    if (n.senders > 0) bits.push(`${n.senders.toLocaleString()}${n.sendersPartial ? '+' : ''} sender${n.senders === 1 && !n.sendersPartial ? '' : 's'}`);
    if (n.lastActivity) bits.push(`last active ${ago(n.lastActivity)}`);
    let line = `<b>${esc(n.network)}</b> ${esc(bits.join(' · '))}`;
    for (const t of n.tokens) {
      const tb = [];
      if (t.received !== null) tb.push(`in ${fmtAmount(t.received)}${t.partial ? '+' : ''}`);
      if (t.sent !== null) tb.push(`out ${fmtAmount(t.sent)}${t.partial ? '+' : ''}`);
      if (t.balance !== null) tb.push(`balance ${fmtAmount(t.balance)}`);
      if (tb.length) line += `<br>${esc(t.symbol)} ${esc(tb.join(' · '))}`;
    }
    if (n.note) line += `<br><span class="muted">${esc(n.note)}</span>`;
    if (n.explorer && /^https:\/\//.test(n.explorer)) line += ` <a href="${esc(n.explorer)}" target="_blank" rel="noopener noreferrer">${esc(n.source || 'explorer')} ↗</a>`;
    out.push(line);
  }
  if (!v.networks.length && v.checked?.length) out.push(`No on-chain activity on ${esc(v.checked.join(', '))}.`);
  if (v.errors?.length) {
    // One line per kind of failure, naming the networks it affected.
    const why = e => (e.code === 'unsupported' ? 'no explorer for this chain' : e.code === 'skipped' ? 'too many addresses on this page'
      : e.code === 'etherscan_plan' ? 'not in your Etherscan plan' : e.code === 'etherscan_key' ? 'Etherscan refused the key'
      : e.code === 'etherscan_error' ? 'Etherscan error'
      : e.code === 'network' ? 'explorer unreachable' : e.code === 'rate_limited' ? 'explorer rate limit, retrying shortly'
      : e.code === 'timeout' ? 'explorer timed out' : /^http_/.test(e.code) ? `explorer error ${e.code.slice(5)}` : 'explorer error');
    const groups = new Map();
    for (const e of v.errors) groups.set(why(e), [...(groups.get(why(e)) || []), W.chainLabel(e.network)]);
    for (const [reason, names] of groups) out.push(`<span class="muted">Not checked (${esc(reason)}): ${esc(names.join(', '))}</span>`);
  }
  return `<div class="vol">${flags.join('')}${out.join('<br>')}</div>`;
}

async function loadVolumes() {
  const s = state;
  const ws = s.tab?.wallets || [];
  if (s.settings?.volume === 'off' || !ws.length) return;
  // Always ask: the background refreshes stale or failed entries and answers fresh ones from cache.
  let marked = false;
  ws.forEach(w => { if (!w.volume) { w.volume = { loading: true }; marked = true; } });
  if (marked) renderWalletList();
  let fresh = null;
  try { fresh = (await call({ type: 'tab:volumes', tabId })).wallets; } catch { /* keep what is shown */ }
  if (state !== s) return; // a newer load() has replaced this view
  const byAddr = new Map((fresh || []).map(w => [w.address, w]));
  for (const w of ws) {
    const v = byAddr.get(w.address)?.volume;
    if (v) w.volume = v;
    else if (w.volume?.loading) delete w.volume;
  }
  renderWalletList();
  renderChecklist(); // exchange-like wallets found now get unticked unless the user chose otherwise
}

// Sites a wallet is on beyond the sample shown (the current site is not counted).
const moreDomains = r => Math.max(0, r.domainCount - (r.onThisDomain ? 1 : 0) - r.sampleDomains.length);

function renderWallets() {
  renderWalletList();
  renderChecklist();
}

function renderWalletList() {
  const ws = state.tab?.wallets || [];
  $('walletCount').textContent = ws.length;
  $('walletList').innerHTML = ws.length
    ? ws.map(w => `<li>${walletTags(w)}<span class="muted" title="${esc(w.format || '')}">${esc(chainText(w))} · ${esc(w.where)}${w.checksum ? ' · checksum ✓' : w.confidence !== 'high' ? ' · no checksum exists' : ''}</span><br><code>${esc(w.address)}</code>${
        w.result?.sampleDomains?.length ? `<br><span class="muted">Also on: ${esc(w.result.sampleDomains.join(', '))}${moreDomains(w.result) ? ` +${moreDomains(w.result)} more` : ''}</span>` : ''}${volumeHtml(w.volume)}</li>`).join('')
    : `<li class="muted">None found. Press ↻ to rescan after revealing a deposit address.</li>`;
  if (ws.length && state.effective && ['scam', 'suspected', 'not_in_hub'].includes(state.effective.verdict)) $('walletBox').open = true;

}

// Submit checklist: pre-tick confident addresses not already on record for this site, leaving out
// wallets that look like an exchange or service. Choices the user made are kept when the list is rebuilt.
// With I4G selected: wallets I4G does not take are greyed out, and 0x addresses get a network picker
// (I4G needs one), preset from where the on-chain volume found money.
function renderChecklist() {
  const ws = state.tab?.wallets || [];
  const i4gOn = isI4g();
  const prev = new Map([...document.querySelectorAll('#submitWallets input[data-touched]')].map(i => [i.dataset.addr, i.checked]));
  const picks = touchedPicks('#submitWallets');
  $('submitWallets').innerHTML = ws.map((w, i) => {
    const accepted = !i4gOn || !!i4gChain(w);
    const touched = accepted && prev.has(w.address);
    const auto = i4gOn
      ? w.confidence === 'high' && !w.volume?.service
      : w.confidence === 'high' && !w.result?.onThisDomain && !w.result?.excluded && !w.volume?.service;
    const ticked = accepted && (touched ? prev.get(w.address) : auto);
    const notes = [];
    if (w.volume?.service) notes.push('likely exchange');
    if (!accepted) notes.push(`I4G does not take ${W.chainLabel(w.chain)} addresses`);
    const pick = i4gOn && /^0x/i.test(w.address) ? chainSelect(w.address, picks.get(w.address.toLowerCase()), i4gDefaultEvmChain(w.volume)) : '';
    return `<label class="inline"><input type="checkbox" data-addr="${esc(w.address)}" id="sw${i}" ${ticked ? 'checked' : ''}${accepted ? '' : ' disabled'}${touched ? ' data-touched="1"' : ''}><code>${esc(w.address)}</code>${pick}${notes.length ? ` <span class="muted">${esc(notes.join(' · '))}</span>` : ''}</label>`;
  }).join('');
}

const EVM_NAMES = { eth: 'Ethereum', bsc: 'BNB Chain', matic: 'Polygon', arb: 'Arbitrum', avax: 'Avalanche C', op: 'Optimism' };
// A user's pick is kept across re-renders; an untouched one follows the latest default.
function touchedPicks(scope) {
  return new Map([...document.querySelectorAll(`${scope} select.chainpick[data-touched]`)].map(s => [s.dataset.addr, s.value]));
}
function chainSelect(address, picked, fallback) {
  const value = picked || fallback || 'eth';
  return `<select class="chainpick" data-addr="${esc(address.toLowerCase())}"${picked ? ' data-touched="1"' : ''} title="Network to report this address on (I4G needs one)" aria-label="Network for ${esc(address)}">${
    I4G_EVM_CHAINS.map(c => `<option value="${c}"${c === value ? ' selected' : ''}>${EVM_NAMES[c]}</option>`).join('')}</select>`;
}

function renderScope(s) {
  const out = $('scopeOut');
  out.hidden = false;
  const tagClass = s.decision === 'in_scope' ? 't-scam' : s.decision === 'out_of_scope' ? 't-ok' : 't-grey';
  const sig = s.signals || {};
  const reason = (s.reason || '').replace(/^(in[ _]scope|out[ _]of[ _]scope|inconclusive)\s*:\s*/i, '');
  const list = [...(sig.unrealistic_returns || []).filter(t => !reason.includes(t)), ...(sig.blockers || []).filter(b => !reason.includes(b)).map(b => 'blocker: ' + b)];
  out.innerHTML = `<span class="tag ${tagClass}">${esc(s.decision || 'unknown')}</span>${esc(reason)}${list.length ? `<br><span class="muted">${esc(list.slice(0, 8).join(', '))}</span>` : ''}`;
  if (s.decision === 'in_scope' && $('verdict').dataset.touched !== '1') {
    $('verdict').value = 'scam';
    const box = document.querySelector('#reasons input[value="unrealistic_returns"]');
    if (box && !box.dataset.touched) box.checked = true;
  }
}

const isI4g = () => state?.settings?.api === 'i4g';
let keyFormOpen = false;

function renderApi() {
  const on = isI4g();
  document.body.classList.toggle('api-i4g', on);
  for (const r of document.querySelectorAll('input[name="api"]')) r.checked = r.value === (on ? 'i4g' : 'hub');
  $('i4gKeyForm').hidden = !keyFormOpen && !(on && !state.i4g?.hasKey);
  $('submitSummary').textContent = on ? 'Submit to I4G' : 'Submit to hub';
  $('submitBtn').textContent = on ? 'Submit to I4G' : 'Submit';
  $('claimBtn').hidden = on; // claims coordinate work on the hub's record
  let site = '';
  try { site = state.tab?.url ? i4gSiteUrl(state.tab.url) : ''; } catch { /* not a URL */ }
  $('i4gSiteUrl').textContent = site;
  const k = state.i4g;
  const age = k?.savedAt ? (Date.now() - new Date(k.savedAt).getTime()) / 86400000 : null;
  $('i4gKeyState').textContent = k?.hasKey
    ? `Saved (${k.hint})${k.savedAt ? `, ${ago(k.savedAt)}` : ''}. I4G keys expire ${I4G_KEY_DAYS} days after they are issued${age !== null && age > I4G_KEY_DAYS - 4 ? ', so this one may expire soon' : ''}.`
    : 'Not set. Needed only when I4G is selected at the top.';
  $('i4gKeyRemove').hidden = !k?.hasKey;
  if ($('extraWallets').value.trim()) checkExtra();
}

for (const r of document.querySelectorAll('input[name="api"]')) {
  r.addEventListener('change', async () => {
    if (!r.checked) return;
    try {
      state.settings = (await call({ type: 'settings:save', settings: { api: r.value } })).settings;
      await load();
      if (r.value === 'i4g' && !state.i4g?.hasKey) $('i4gKeyInput').focus();
    } catch (e) { setMsg($('settingsMsg'), friendly(e), 'err'); }
  });
}

$('i4gKeyForm').onsubmit = e => {
  e.preventDefault();
  busy($('i4gKeySave'), async () => {
    const key = $('i4gKeyInput').value.trim();
    if (!I4G_KEY_RE.test(key)) { setMsg($('i4gKeyMsg'), 'An I4G key is sb_ followed by 32 lowercase hex characters.', 'err'); return; }
    setMsg($('i4gKeyMsg'), 'Checking the key with I4G…');
    try {
      state.i4g = (await call({ type: 'i4g:setKey', key })).i4g;
      $('i4gKeyInput').value = '';
      keyFormOpen = false;
      setMsg($('i4gKeyMsg'), '');
      await load();
      setMsg($('settingsMsg'), 'I4G key saved.', 'ok');
    } catch (err) { setMsg($('i4gKeyMsg'), friendly(err), 'err'); }
  });
};
$('i4gKeyReplace').onclick = () => {
  keyFormOpen = true;
  $('i4gKeyForm').hidden = false;
  $('i4gKeyForm').scrollIntoView({ block: 'nearest' });
  $('i4gKeyInput').focus();
};
$('i4gKeyRemove').onclick = async () => {
  if (!confirm('Remove the I4G key from this browser?')) return;
  try {
    state.i4g = (await call({ type: 'i4g:clearKey' })).i4g;
    await load();
  } catch (e) { setMsg($('settingsMsg'), friendly(e), 'err'); }
};

// ---------- I4G submission history (one request a minute) ----------

let histPage = 1, histPages = 1;
$('historyBox').addEventListener('toggle', () => { if ($('historyBox').open && !$('histOut').dataset.loaded) loadHistory(1); });
$('histPrev').onclick = () => loadHistory(histPage - 1);
$('histNext').onclick = () => loadHistory(histPage + 1);

async function loadHistory(page) {
  if (page < 1 || page > histPages) return;
  $('histOut').textContent = 'Loading…';
  try {
    const { history: h } = await call({ type: 'i4g:history', page });
    histPage = Number(h.page) || page;
    histPages = Math.max(1, Number(h.total_pages) || 1);
    $('histOut').dataset.loaded = '1';
    $('histPage').textContent = `Page ${histPage} of ${histPages} · ${Number(h.total_submissions) || 0} submission(s)`;
    $('histPrev').disabled = histPage <= 1;
    $('histNext').disabled = histPage >= histPages;
    const items = Array.isArray(h.submissions) ? h.submissions : [];
    $('histOut').innerHTML = (items.length
      ? `<ul class="hist">${items.map(histItem).join('')}</ul>`
      : '<p class="muted">No scored submissions yet. They appear here after I4G has processed them.</p>')
      + `<p class="muted">I4G allows one history request a minute${h.cached ? '; this page was loaded in the last minute' : ''}.</p>`;
  } catch (e) { $('histOut').textContent = friendly(e); }
}

function histItem(s) {
  const pts = Number(s?.total_points);
  const valid = Array.isArray(s?.valid_wallets) ? s.valid_wallets : [];
  const invalid = Array.isArray(s?.invalid_wallets) ? s.invalid_wallets : [];
  const ptsText = Number.isFinite(pts) ? `${pts > 0 ? '+' : ''}${pts} pts` : '? pts';
  return `<li><b>${esc(s?.site_key || s?.site_url_original || '?')}</b> <span class="${pts < 0 ? 'pts-neg' : 'pts-pos'}">${esc(ptsText)}</span><br>`
    + `<span class="muted">${esc(fmtDate(s?.submitted_ts_utc) || '')} · ${valid.length} valid / ${invalid.length} invalid wallet(s)</span>`
    + (invalid.length ? `<br><span class="err-text">Invalid: ${esc(invalid.slice(0, 5).map(w => `${w?.chain || '?'} ${String(w?.address || '').slice(0, 14)}…`).join(', '))}</span>` : '')
    + '</li>';
}

function renderSettings() {
  const s = state.settings;
  for (const el of document.querySelectorAll('[data-set]')) {
    if (el.type === 'checkbox') el.checked = !!s[el.dataset.set];
    else el.value = s[el.dataset.set];
  }
  $('ignoreList').value = (s.ignore || []).join('\n');
  syncVolumeOption();
}

// The submit option only makes sense while on-chain lookups are on.
function syncVolumeOption() {
  $('includeVolume').closest('label').hidden = state.settings?.volume === 'off';
}

function renderFooter() {
  $('who').textContent = state.me ? `${state.me.handle} (${(state.me.key?.scopes || []).join(', ')})` : '';
  const l = state.limits;
  $('rate').textContent = l?.minute != null ? `${l.minute}/min · ${l.day}/day left` : '';
}

async function load() {
  // ?tabId= lets the popup page be opened against a specific tab (used by the automated tests).
  const forced = Number(new URLSearchParams(location.search).get('tabId'));
  if (forced) tabId = forced;
  else [{ id: tabId } = {}] = await ext.tabs.query({ active: true, currentWindow: true });
  state = await call({ type: 'popup:state', tabId });
  if (!state.hasKey) return showKeyView();
  if (state.newKey) return showNewKey(state.newKey);
  $('keyView').hidden = true;
  $('newKeyView').hidden = true;
  $('mainView').hidden = false;
  renderSettings();
  renderApi();
  renderStatus();
  renderWallets();
  renderFooter();
  checkAccess();
  loadVolumes();
  // Start the form from the hub's current verdict so a submit does not silently change it.
  const v = state.effective?.verdict;
  if (!state.effective?.parent && ['scam', 'suspected', 'not_scam', 'out_of_scope'].includes(v) && $('verdict').dataset.touched !== '1') $('verdict').value = v;
}

// ---------- actions ----------

$('recheck').onclick = () => busy($('recheck'), async () => {
  try {
    await call({ type: 'tab:recheck', tabId });
    await new Promise(r => setTimeout(r, 1200)); // give the page a moment to report its wallets
    await load();
  } catch (e) { $('status').innerHTML = `<p class="small">${esc(friendly(e))}</p>`; }
});

$('scopeBtn').onclick = () => busy($('scopeBtn'), async () => {
  $('scopeOut').hidden = false;
  $('scopeOut').textContent = 'Asking the hub classifier…';
  try {
    const { scope } = await call({ type: 'tab:scope', tabId });
    renderScope(scope);
  } catch (e) { $('scopeOut').textContent = friendly(e); }
});

$('claimBtn').onclick = () => busy($('claimBtn'), async () => {
  try {
    await call({ type: 'tab:claim', tabId, release: $('claimBtn').dataset.release === '1' });
    await load();
  } catch (e) {
    $('status').insertAdjacentHTML('beforeend', `<p class="small">${esc(e.status === 409 ? 'Someone else has claimed this domain.' : friendly(e))}</p>`);
  }
});

$('reasons').innerHTML = REASON_CODES.map(c => `<label><input type="checkbox" value="${c}">${c.replace(/_/g, ' ')}</label>`).join('');
$('reasons').addEventListener('change', e => { e.target.dataset.touched = '1'; });
$('submitWallets').addEventListener('change', e => { if (e.target.matches('input, select')) e.target.dataset.touched = '1'; });
$('extraCheck').addEventListener('change', e => { if (e.target.matches('select')) e.target.dataset.touched = '1'; });
$('verdict').addEventListener('change', () => { $('verdict').dataset.touched = '1'; });
$('recordSub').onchange = e => { $('subFields').hidden = !e.target.checked; };

// Extra addresses are validated as you type, with the same rules the background enforces on submit.
const extraTokens = () => $('extraWallets').value.split(/[\s,;]+/).filter(Boolean);
function checkExtra() {
  const i4gOn = isI4g();
  const picks = touchedPicks('#extraCheck');
  const lines = extraTokens().slice(0, 30).map(a => {
    const det = W.detectChain(a);
    const c = det.chain ? W.validateWallet(det.chain, a) : null;
    if (!c?.valid) return `<span class="err-text">✗ ${esc(c ? c.errors[0] : `${a.slice(0, 24)}… is not a recognised wallet address.`)}</span>`;
    if (i4gOn && !i4gChain({ address: c.canonical, chain: c.chain })) return `<span class="err-text">✗ I4G does not take ${esc(W.chainLabel(c.chain))} addresses: ${esc(a.slice(0, 24))}…</span>`;
    const pick = i4gOn && /^0x/i.test(c.canonical) ? chainSelect(c.canonical, picks.get(c.canonical.toLowerCase())) : '';
    return `<span class="ok-text">✓ ${esc(chainText({ chain: c.chain, address: c.canonical }))}</span> <span class="muted">${esc(c.format)}</span>${pick}`;
  });
  $('extraCheck').innerHTML = lines.join('<br>');
  return lines.every(l => l.includes('ok-text'));
}
$('extraWallets').addEventListener('input', () => {
  if (checkExtra() && $('submitMsg').classList.contains('err')) setMsg($('submitMsg'), ''); // the problem was fixed
});

$('submitForm').onsubmit = e => {
  e.preventDefault();
  busy($('submitBtn'), async () => {
    if (!checkExtra()) {
      setMsg($('submitMsg'), 'Fix or remove the invalid extra addresses first.', 'err');
      return;
    }
    const wallets = [
      ...[...document.querySelectorAll('#submitWallets input:checked')].map(i => i.dataset.addr),
      ...extraTokens(),
    ];
    if (isI4g()) {
      if (wallets.length > I4G_MAX_WALLETS) { setMsg($('submitMsg'), `I4G takes at most ${I4G_MAX_WALLETS} wallets per submission; ${wallets.length} are selected.`, 'err'); return; }
      const chains = Object.fromEntries([...document.querySelectorAll('#submitWallets select.chainpick, #extraCheck select.chainpick')].map(s => [s.dataset.addr, s.value]));
      setMsg($('submitMsg'), 'Submitting to I4G…');
      try {
        const { result } = await call({ type: 'tab:submit', tabId, form: { wallets, chains } });
        setMsg($('submitMsg'), result?.status === 'duplicate'
          ? 'I4G already has this exact submission (duplicate); nothing new was queued.'
          : `Queued at I4G: ${result?.wallet_count ?? wallets.length} wallet(s)${result?.submission_id ? `, submission ${String(result.submission_id).slice(0, 8)}…` : ''}. Points appear under "My I4G submissions" once it is processed.`, 'ok');
        $('extraWallets').value = '';
        $('extraCheck').innerHTML = '';
        await load();
      } catch (err) { setMsg($('submitMsg'), friendly(err), 'err'); }
      return;
    }
    const form = {
      verdict: $('verdict').value,
      reasons: [...document.querySelectorAll('#reasons input:checked')].map(i => i.value),
      reasonDetail: $('reasonDetail').value,
      wallets,
      comment: $('comment').value,
      title: state.tab?.title,
      includeHtml: $('includeHtml').checked,
      includeVolume: $('includeVolume').checked,
      recordSubmission: $('recordSub').checked,
      platform: $('platform').value,
      externalId: $('externalId').value,
    };
    if (!form.verdict && !wallets.length && !form.reasons.length && !form.comment.trim() && !form.recordSubmission) {
      setMsg($('submitMsg'), 'Nothing to submit: pick a verdict, reason, wallet or comment.', 'err');
      return;
    }
    setMsg($('submitMsg'), 'Submitting…');
    try {
      const { result } = await call({ type: 'tab:submit', tabId, form });
      const rej = result?.rejected && (Array.isArray(result.rejected) ? result.rejected.length : Object.keys(result.rejected).length);
      const volNote = form.includeVolume && !result?.volume_included ? ' No on-chain volume was available to include.' : '';
      setMsg($('submitMsg'), `${result?.created ? 'Added to the hub' : 'Merged into the hub record'}.${volNote}${rej ? ` ${rej} item(s) rejected: ${JSON.stringify(result.rejected).slice(0, 300)}` : ''}`, rej ? 'err' : 'ok');
      $('extraWallets').value = '';
      $('extraCheck').innerHTML = '';
      $('comment').value = '';
      await load();
    } catch (err) {
      setMsg($('submitMsg'), friendly(err), 'err');
    }
  });
};

let lookupSeq = 0;
$('lookupForm').onsubmit = e => {
  e.preventDefault();
  const q = $('lookupQ').value.trim();
  if (!q) return;
  const seq = ++lookupSeq;
  $('lookupOut').textContent = 'Searching…';
  call({ type: 'lookup', q }).then(({ result, wallet, invalid, wantVolume, i4g }) => {
    if (seq !== lookupSeq) return; // a newer search replaced this one
    const head = [];
    if (invalid) head.push(`<p class="err-text">${esc(invalid)}</p>`);
    if (i4g) head.push(i4g.error
      ? `<p class="small"><b>I4G:</b> ${esc(friendly(i4g.error))}</p>`
      : `<div class="lookup-i4g"><span class="verdict v-${esc(i4g.effective.verdict)}">${esc(i4g.effective.label)}</span> <span class="small">${esc(i4g.check.domain)}${i4g.check.known ? ` · ${esc(i4g.check.status)} · ${i4g.check.hasWallets ? 'wallets on record' : 'no wallets yet'}${i4g.check.stale ? ' (stale)' : ''}` : ''}</span></div>`);
    // <div>s, not <p>/<span>: volumeHtml returns a <div>, which a <p> cannot contain.
    if (wallet) head.push(`<div class="lookup-wallet"><span class="ok-text">✓ ${esc(chainText(wallet))}</span> <span class="muted">${esc(wallet.format)}</span><div id="lookupVol">${wantVolume ? volumeHtml({ loading: true }) : ''}</div></div>`);
    const groups = (Array.isArray(result) ? result : []).filter(g => g.results?.length);
    const body = groups.length
      ? groups.map(g => `<b>${esc(g.kind)}</b> · ${g.results.length} match(es)<ul class="wallets">${
        g.results.slice(0, 5).map(r => {
          const name = r.domain || r.address || r.ip || r.value || r.uuid || '';
          const verdict = r.verdict ? ` <span class="tag ${r.verdict === 'scam' ? 't-scam' : r.verdict === 'suspected' ? 't-warn' : 't-grey'}">${esc(r.verdict)}</span>` : '';
          const doms = r.domains?.length ? `<br><span class="muted">${r.domains.length} domain(s): ${esc(r.domains.slice(0, 5).map(d => d.domain).join(', '))}${r.domains.length > 5 ? ` +${r.domains.length - 5} more` : ''}</span>` : '';
          const sub = r.submitted !== undefined ? ` <span class="muted">${r.submitted ? 'submitted' : 'not submitted'}</span>` : '';
          return `<li><code>${esc(name)}</code>${verdict}${sub}${doms}</li>`;
        }).join('')}</ul>`).join('')
      : '<p class="muted">No match in the hub.</p>';
    $('lookupOut').innerHTML = head.join('') + body;
    if (wantVolume) {
      call({ type: 'lookup:volume', q }).then(({ volume }) => {
        if (seq === lookupSeq && $('lookupVol')) $('lookupVol').innerHTML = volumeHtml(volume) || '';
      }, () => { if (seq === lookupSeq && $('lookupVol')) $('lookupVol').innerHTML = ''; });
    }
  }, err => { if (seq === lookupSeq) $('lookupOut').textContent = friendly(err); });
};

for (const el of document.querySelectorAll('[data-set]')) {
  el.addEventListener('change', async () => {
    const key = el.dataset.set;
    const value = el.type === 'checkbox' ? el.checked : el.type === 'number' ? (el.value === '' ? 0 : Math.max(0, Number(el.value) || 0)) : el.value.trim();
    try {
      state.settings = (await call({ type: 'settings:save', settings: { [key]: value } })).settings;
      syncVolumeOption();
      if (key === 'etherscanKey') return etherscanSaved(value);
      if (key === 'exchangeTxs' || key === 'exchangeUsd') {
        setMsg($('limitsMsg'), 'Saved. Wallets are flagged with the new limits.', 'ok');
        return loadVolumes(); // the background re-applies the limits to the figures it has
      }
      setMsg($('settingsMsg'), 'Saved. Applies to pages loaded from now on.', 'ok');
    } catch (e) { setMsg($('settingsMsg'), friendly(e), 'err'); }
  });
}

// A new Etherscan key: check it, then read this page's 0x wallets again.
async function etherscanSaved(key) {
  const msg = $('etherscanMsg');
  if (!key) setMsg(msg, 'Etherscan key removed: 0x wallets use Ethplorer, Binplorer and Blockscout again.', 'ok');
  else {
    setMsg(msg, 'Checking the key with Etherscan…');
    try {
      await call({ type: 'etherscan:verify' });
      setMsg(msg, 'Etherscan accepted the key. 0x wallets are read from Etherscan where your plan covers the chain.', 'ok');
    } catch (e) {
      setMsg(msg, e.code === 'etherscan_key'
        ? 'Saved, but Etherscan did not accept this key. Check it on etherscan.io; a new key can take a few minutes to start working.'
        : `Saved, but the key could not be checked: ${friendly(e)}`, 'err');
    }
  }
  return loadVolumes();
}

$('saveIgnore').onclick = async () => {
  const ignore = [...new Set($('ignoreList').value.split(/\s+/).map(s => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')).filter(Boolean))];
  try {
    state.settings = (await call({ type: 'settings:save', settings: { ignore } })).settings;
    renderSettings();
    setMsg($('settingsMsg'), 'Ignored sites saved.', 'ok');
  } catch (e) { setMsg($('settingsMsg'), friendly(e), 'err'); }
};

// ---------- key rotation ----------

function showNewKey(token, note) {
  $('keyView').hidden = true;
  $('mainView').hidden = true;
  $('newKeyView').hidden = false;
  $('newKeyOut').value = token;
  setMsg($('newKeyMsg'), note || '', note ? 'err' : '');
}

$('newKeyCopy').onclick = async () => {
  try {
    await navigator.clipboard.writeText($('newKeyOut').value);
    setMsg($('newKeyMsg'), 'Copied.', 'ok');
  } catch {
    $('newKeyOut').select();
    setMsg($('newKeyMsg'), 'Copy blocked; the key is selected, press Ctrl+C / Cmd+C.', 'err');
  }
};

$('newKeyDone').onclick = async () => {
  if (!confirm('Have you stored the new key somewhere safe? It will not be shown again.')) return;
  $('newKeyOut').value = '';
  await call({ type: 'key:noticeDone' });
  await load();
};

$('rotateKey').onclick = () => {
  if (!confirm('Rotate your API key?\n\nThe current key stops working immediately, everywhere it is used (other tools, hub web sessions). The new key is shown once.')) return;
  busy($('rotateKey'), async () => {
    setMsg($('rotateMsg'), 'Rotating…');
    try {
      const res = await call({ type: 'key:rotate' });
      setMsg($('rotateMsg'), '');
      if (res.token) {
        showNewKey(res.token, res.verifyError ? 'Saved, but the hub did not accept the new key yet: ' + friendly(res.verifyError) : '');
      } else {
        // Rotated, but the reply had no recognisable key: show it so the key is not lost.
        showKeyView('The key was rotated but the reply was not understood. Copy the new key from below and paste it here.');
        $('keyRaw').hidden = false;
        $('keyRaw').textContent = res.raw;
      }
    } catch (e) {
      setMsg($('rotateMsg'), 'Not rotated: ' + friendly(e), 'err');
    }
  });
};

load().catch(e => showKeyView(friendly(e)));
