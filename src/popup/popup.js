import { ext, REASON_CODES, HUB_ORIGIN, ACCESS_ORIGINS } from '../lib/settings.js';
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
  if (e.code === 'no_host_access') return e.message;
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
    box.innerHTML = `<span class="verdict v-none">Hub error</span><p class="small">${esc(friendly(tab.error))}</p>`;
    if (tab.error.status === 401) showKeyView('Your saved key stopped working. Enter a new one.');
    return;
  }
  const c = tab.check;
  if (!c) {
    box.innerHTML = `<span class="verdict v-none">Not checked</span><p class="muted small">Automatic checks are off. Press ↻ to check this site.</p>`;
    return;
  }
  const eff = state.effective;
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

function walletTags(w) {
  const r = w.result;
  if (!r) return `<span class="tag t-grey">${esc(w.error?.code || 'pending')}</span>`;
  if (!r.known) return `<span class="tag t-info">NEW</span>`;
  let t = r.scamDomains ? `<span class="tag t-scam">${r.scamDomains} scam site(s)</span>` : `<span class="tag t-grey">${r.domainCount} site(s)</span>`;
  if (r.onThisDomain) t += `<span class="tag t-grey">on this site</span>`;
  if (r.submitted) t += `<span class="tag t-warn">submitted</span>`;
  if (r.excluded) t += `<span class="tag t-grey" title="${esc(r.excludeReason || '')}">excluded</span>`;
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
  if (v.usdReceived || v.usdSent) {
    const plus = v.usdPartial || v.usdMissing?.length ? '+' : '';
    const parts = [v.usdReceived ? `${fmtUsd(v.usdReceived)}${plus} in` : null, v.usdSent ? `${fmtUsd(v.usdSent)}${plus} moved out` : null].filter(Boolean);
    const missing = v.usdMissing?.length ? `; ${v.usdMissing.join(', ')} not priced` : '';
    out.push(`<b>≈ ${esc(parts.join(' · '))}</b> <span class="muted">(at today's prices${v.usdPartial ? '; at least this much' : ''}${esc(missing)})</span>`);
  } else if (v.usdMissing?.length) {
    out.push(`<span class="muted">No USD estimate: prices for ${esc(v.usdMissing.join(', '))} could not be loaded.</span>`);
  }
  for (const n of v.networks) {
    const bits = [];
    if (n.received !== null) bits.push(`in ${fmtAmount(n.received)} ${n.asset}`);
    if (n.sent !== null) bits.push(`out ${fmtAmount(n.sent)}`);
    if (n.balance !== null) bits.push(`balance ${fmtAmount(n.balance)} ${n.asset}`);
    if (n.txCount !== null) bits.push(`${n.txCount.toLocaleString()}${n.partial ? '+' : ''} txs`);
    if (n.lastActivity) bits.push(`last active ${ago(n.lastActivity)}`);
    let line = `<b>${esc(n.network)}</b> ${esc(bits.join(' · '))}`;
    for (const t of n.tokens) {
      const tb = [];
      if (t.received !== null) tb.push(`in ${fmtAmount(t.received)}${n.partial ? '+' : ''}`);
      if (t.sent !== null) tb.push(`out ${fmtAmount(t.sent)}${n.partial ? '+' : ''}`);
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
      : e.code === 'network' ? 'explorer unreachable' : e.code === 'rate_limited' ? 'explorer rate limit, retrying shortly'
      : e.code === 'timeout' ? 'explorer timed out' : /^http_/.test(e.code) ? `explorer error ${e.code.slice(5)}` : 'explorer error');
    const groups = new Map();
    for (const e of v.errors) groups.set(why(e), [...(groups.get(why(e)) || []), W.chainLabel(e.network)]);
    for (const [reason, names] of groups) out.push(`<span class="muted">Not checked (${esc(reason)}): ${esc(names.join(', '))}</span>`);
  }
  return `<div class="vol">${out.join('<br>')}</div>`;
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

// Submit checklist: pre-tick confident addresses not already on record for this site.
// Choices the user already made are kept when the list is rebuilt.
function renderChecklist() {
  const ws = state.tab?.wallets || [];
  const prev = new Map([...document.querySelectorAll('#submitWallets input')].map(i => [i.dataset.addr, i.checked]));
  $('submitWallets').innerHTML = ws.map((w, i) => {
    const ticked = prev.has(w.address) ? prev.get(w.address) : w.confidence === 'high' && !w.result?.onThisDomain && !w.result?.excluded;
    return `<label class="inline"><input type="checkbox" data-addr="${esc(w.address)}" id="sw${i}" ${ticked ? 'checked' : ''}><code>${esc(w.address)}</code></label>`;
  }).join('');
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
  renderStatus();
  renderWallets();
  renderSettings();
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
$('verdict').addEventListener('change', () => { $('verdict').dataset.touched = '1'; });
$('recordSub').onchange = e => { $('subFields').hidden = !e.target.checked; };

// Extra addresses are validated as you type, with the same rules the background enforces on submit.
const extraTokens = () => $('extraWallets').value.split(/[\s,;]+/).filter(Boolean);
function checkExtra() {
  const lines = extraTokens().slice(0, 30).map(a => {
    const det = W.detectChain(a);
    const c = det.chain ? W.validateWallet(det.chain, a) : null;
    return c?.valid
      ? `<span class="ok-text">✓ ${esc(chainText({ chain: c.chain, address: c.canonical }))}</span> <span class="muted">${esc(c.format)}</span>`
      : `<span class="err-text">✗ ${esc(c ? c.errors[0] : `${a.slice(0, 24)}… is not a recognised wallet address.`)}</span>`;
  });
  $('extraCheck').innerHTML = lines.join('<br>');
  return lines.every(l => l.includes('ok-text'));
}
$('extraWallets').addEventListener('input', checkExtra);

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
  call({ type: 'lookup', q }).then(({ result, wallet, invalid, wantVolume }) => {
    if (seq !== lookupSeq) return; // a newer search replaced this one
    const head = [];
    if (invalid) head.push(`<p class="err-text">${esc(invalid)}</p>`);
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
    const value = el.type === 'checkbox' ? el.checked : el.value;
    try {
      state.settings = (await call({ type: 'settings:save', settings: { [el.dataset.set]: value } })).settings;
      syncVolumeOption();
      setMsg($('settingsMsg'), 'Saved. Applies to pages loaded from now on.', 'ok');
    } catch (e) { setMsg($('settingsMsg'), friendly(e), 'err'); }
  });
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
