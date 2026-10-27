// Content script: finds wallet addresses on the page and shows a small corner widget.
// It never talks to the hub directly; the background does every API call.
(() => {
  if (window.__sbExtLoaded) return;
  window.__sbExtLoaded = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const W = globalThis.BBWallets; // lib/wallets.js, injected just before this script
  const B58 = '1-9A-HJ-NP-Za-km-z';

  // Candidate shapes only. Every candidate must then pass lib/wallets.js for its detected chain
  // (decode, checksum, version byte / prefix), so anything reported is a structurally real address.
  const CANDIDATES = [
    /\b0x[a-fA-F0-9]{40}\b/g, // EVM
    /\b(?:bc1|BC1|ltc1|LTC1)[a-zA-Z0-9]{11,87}\b/g, // SegWit / Taproot
    /\b(?:bitcoincash:)?[qp](?:[02-9ac-hj-np-z]{60}|[02-9ac-hj-np-z]{41})\b/gi, // CashAddr (P2PKH/P2SH, P2SH32)
    /\baddr1[02-9ac-hj-np-z]{50,120}\b/g, // Cardano
    /\bX-avax1[02-9ac-hj-np-z]{38}\b/gi, // Avalanche X-Chain
    /(?<![A-Za-z0-9_+-])[EU][Qf][A-Za-z0-9_+/-]{46}(?![A-Za-z0-9_+-])/g, // TON (EQ/UQ basechain, Ef/Uf masterchain); '/' may border it, as in ton://transfer/<addr>
    new RegExp(`\\b[${B58}]{25,44}\\b`, 'g'), // Base58: BTC/LTC/DOGE/DASH/TRX legacy, XRP, Solana
  ];

  const ATTRS = ['value', 'data-clipboard-text', 'data-address', 'data-wallet', 'data-copy', 'data-text', 'data-value', 'title', 'aria-label', 'alt', 'placeholder'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const INLINE = new Set(['SPAN', 'B', 'I', 'EM', 'STRONG', 'A', 'CODE', 'MARK', 'SMALL', 'SUB', 'SUP', 'FONT', 'ABBR', 'KBD', 'SAMP', 'TT', 'U', 'S', 'WBR']);
  const MAX_TEXT = 1_500_000;

  // ---------- scanning ----------

  function collectSources() {
    const out = [];
    let total = 0;
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || SKIP_TAGS.has(p.tagName) || p.closest('#sb-ext-host')) return NodeFilter.FILTER_REJECT;
        return n.nodeValue.length >= 25 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const parts = [];
    while (walker.nextNode() && total < MAX_TEXT) {
      parts.push(walker.currentNode.nodeValue);
      total += walker.currentNode.nodeValue.length;
    }
    out.push({ where: 'text', text: parts.join('\n') });

    // An address split across inline elements (<span>, <wbr>, highlighting) or with soft hyphens /
    // zero-width characters: join each block's inline text runs and scan that too.
    const runs = [];
    let run = '', block = null, joinedTotal = 0;
    const blockOf = el => { let e = el; while (e && INLINE.has(e.tagName)) e = e.parentElement; return e; };
    const all = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        return !p || SKIP_TAGS.has(p.tagName) || p.closest('#sb-ext-host') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      },
    });
    while (all.nextNode() && joinedTotal < MAX_TEXT) {
      const n = all.currentNode;
      const b = blockOf(n.parentElement);
      if (b !== block) { if (run.length >= 25) runs.push(run); run = ''; block = b; }
      run += n.nodeValue;
      joinedTotal += n.nodeValue.length;
    }
    if (run.length >= 25) runs.push(run);
    out.push({ where: 'text', text: runs.map(r => r.replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, '')).join('\n') });

    const vals = [];
    for (const el of document.querySelectorAll('input, textarea')) if (el.value && el.value.length >= 25) vals.push(el.value);
    out.push({ where: 'input', text: vals.join('\n') });

    const attrs = [];
    const sel = ATTRS.map(a => `[${a}]`).join(',');
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('#sb-ext-host')) continue;
      for (const a of ATTRS) { const v = el.getAttribute(a); if (v && v.length >= 25 && v.length < 600) attrs.push(v); }
    }
    out.push({ where: 'attr', text: attrs.join('\n') });

    // Payment links (bitcoin:, ethereum:, tron: ...) and QR-code image URLs that embed the address.
    const links = [];
    for (const a of document.querySelectorAll('a[href]')) {
      const h = a.getAttribute('href');
      if (h && /^[a-z]+:/i.test(h) && !/^(https?|mailto|tel|javascript|data):/i.test(h)) links.push(h.replace(/^[a-z]+:(\/\/)?/i, ''));
    }
    out.push({ where: 'link', text: links.join('\n') });
    const qrs = [];
    for (const img of document.querySelectorAll('img[src]')) {
      const src = img.getAttribute('src');
      if (src && /qr|chart|chl=|data=/i.test(src) && !src.startsWith('data:')) {
        try { qrs.push(decodeURIComponent(src).replace(/[a-z]+:(?=[A-Za-z0-9])/gi, ' ')); } catch { /* bad escape */ }
      }
    }
    out.push({ where: 'qr', text: qrs.join('\n') });
    return out;
  }

  // Checksum-verified addresses, and EVM ones without checksum casing, are confident enough to
  // pre-select for submission; Solana keys have no checksum at all.
  const confidenceOf = c => (c.checksum || W.EVM_CHAINS.includes(c.chain) ? 'high' : 'low');

  async function extract(sources) {
    const found = new Map(); // validated key (chain:address) -> wallet
    const tried = new Set();
    for (const { where, text } of sources) {
      if (!text) continue;
      for (const re of CANDIDATES) {
        re.lastIndex = 0;
        for (const m of text.matchAll(re)) {
          const raw = m[0];
          if (tried.has(raw)) continue;
          tried.add(raw);
          const c = W.checkDetected(raw) || (/^[qp][02-9ac-hj-np-z]{60}$/i.test(raw) ? W.checkDetected('bitcoincash:' + raw) : null);
          if (!c || found.has(c.key)) continue;
          if ([...found.values()].some(f => f.raw.includes(raw))) continue; // a fragment of a longer address
          found.set(c.key, { address: W.hubAddress(c), raw, chain: c.chain, format: c.format, checksum: c.checksum, confidence: confidenceOf(c), where });
          if (found.size >= 200) return [...found.values()];
        }
      }
    }
    return [...found.values()];
  }

  // ---------- state ----------

  let settings = null;
  let effective = null;
  let check = null;
  let wallets = [];
  let autoSubmitted = null;
  const sent = new Set();
  let lastHref = location.href;
  let scans = 0;
  let enabled = false;

  // Take the background's wallet list, keeping on-chain figures already shown for the same address.
  function adoptWallets(list) {
    if (!list) return;
    const shown = new Map(wallets.map(w => [w.address, w.volume]));
    wallets = list.map(w => (w.volume || !shown.get(w.address) ? w : { ...w, volume: shown.get(w.address) }));
  }

  async function send(msg) {
    try { return await ext.runtime.sendMessage(msg); } catch { return null; }
  }

  async function hello() {
    const res = await send({ type: 'page:hello' });
    if (!res || res.error) return false;
    enabled = !!res.enabled;
    settings = res.settings;
    effective = res.effective;
    check = res.check;
    return true;
  }

  async function scan(forced = false) {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sent.clear();
      wallets = [];
      await hello();
    }
    if (!forced && (!enabled || !settings?.walletScan)) { render(); return; }
    scans++;
    const found = await extract(collectSources());
    const fresh = found.filter(w => !sent.has(w.address));
    if (fresh.length || forced) {
      fresh.forEach(w => sent.add(w.address));
      const res = await send({ type: 'page:wallets', wallets: forced ? found : fresh, forced });
      if (res && !res.error) {
        adoptWallets(res.wallets);
        effective = res.effective;
        check = res.check;
        autoSubmitted = res.autoSubmitted || autoSubmitted;
      }
    }
    render();
  }

  // Deposit addresses are often revealed late (modals, SPA routes); rescan on change, throttled.
  let timer = null;
  const observer = new MutationObserver(muts => {
    if (muts.every(m => [...m.addedNodes, ...m.removedNodes].every(n => n === host))) return;
    if (scans > 40) { observer.disconnect(); return; }
    if (timer) return;
    timer = setTimeout(() => { timer = null; scan(); }, 1500);
  });

  // An address the user copies is a strong signal; check it even if it was hidden in the DOM.
  document.addEventListener('copy', () => {
    if (!enabled || !settings?.walletScan) return;
    const text = String(window.getSelection() || '').trim();
    if (text.length < 25 || text.length > 200) return;
    extract([{ where: 'copy', text }]).then(found => {
      const fresh = found.filter(w => !sent.has(w.address));
      if (!fresh.length) return;
      fresh.forEach(w => sent.add(w.address));
      send({ type: 'page:wallets', wallets: fresh }).then(res => {
        if (res && !res.error) { adoptWallets(res.wallets); render(); }
      });
    });
  }, true);

  ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'page:ping') { sendResponse({ pong: true }); return false; }
    if (msg?.type === 'page:html') {
      const dt = document.doctype ? `<!DOCTYPE ${document.doctype.name}>` : '';
      sendResponse({ html: dt + document.documentElement.outerHTML });
      return false;
    }
    if (msg?.type === 'page:volumes') {
      // On-chain figures arrive after the hub lookups; merge them in by address.
      const vols = msg.volumes || {};
      wallets = wallets.map(w => (vols[w.address] ? { ...w, volume: vols[w.address] } : w));
      render();
      return false;
    }
    if (msg?.type === 'page:rescan') {
      sent.clear();
      hello().then(() => scan(true)).then(() => sendResponse({ ok: true }));
      return true;
    }
    return false;
  });

  // ---------- corner widget ----------
  // Fixed to the top-right corner, never wider than 300px or taller than 40% of the viewport.

  let host = null, root = null;
  let collapsed = true;
  let dismissed = false;

  const CSS = `
    :host { all: initial; }
    .wrap { position: fixed; top: 10px; right: 10px; z-index: 2147483647; font: 12px/1.4 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; color: #1e272e; }
    .pill { display: flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border-radius: 14px; border: 0; cursor: pointer;
            color: #fff; font: 600 12px/1 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0,0,0,.25); }
    .panel { box-sizing: border-box; width: 300px; max-width: calc(100vw - 20px); max-height: 40vh; overflow: auto; background: #fff; border-radius: 10px;
             box-shadow: 0 4px 18px rgba(0,0,0,.28); border: 1px solid #dfe6e9; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; color: #fff; position: sticky; top: 0; }
    .head b { flex: 1; font-size: 13px; }
    .head button { background: rgba(0,0,0,.18); color: #fff; border: 0; border-radius: 4px; width: 22px; height: 22px; cursor: pointer; font-size: 13px; line-height: 1; }
    .body { padding: 8px 10px; }
    .row { margin: 0 0 6px; }
    .muted { color: #636e72; }
    ul { list-style: none; margin: 4px 0 0; padding: 0; }
    li { padding: 5px 0; border-top: 1px solid #f1f2f6; }
    code { font: 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .tag { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-right: 4px; color: #fff; }
    .scam { background: #d52a2b; } .suspected { background: #b45309; } .not_scam { background: #007e65; }
    .neutral { background: #636e72; } .info { background: #0871c3; } .flow { background: #4a5568; }
    @media (prefers-color-scheme: dark) {
      .panel { background: #1e272e; color: #dfe6e9; border-color: #2d3436; }
      li { border-color: #2d3436; } .muted { color: #b2bec3; }
    }
  `;

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const VERDICT_LABEL = { scam: 'Known scam', suspected: 'Suspected scam', not_scam: 'Marked not a scam', out_of_scope: 'Out of scope', unknown: 'In hub, unrated', not_in_hub: 'Not in the hub' };
  const tone = v => (v === 'scam' || v === 'suspected' || v === 'not_scam') ? v : (v === 'not_in_hub' ? 'info' : 'neutral');
  const alerting = () => effective && (effective.verdict === 'scam' || effective.verdict === 'suspected');

  function walletLine(w) {
    const r = w.result;
    let tags;
    if (!r) tags = `<span class="tag neutral">${esc(w.error?.code || 'pending')}</span>`;
    else if (!r.known) tags = `<span class="tag info">NEW</span>`;
    else {
      tags = r.scamDomains ? `<span class="tag scam">on ${r.scamDomains} scam site${r.scamDomains > 1 ? 's' : ''}</span>` : `<span class="tag neutral">in hub · ${r.domainCount} site(s)</span>`;
      if (r.submitted) tags += `<span class="tag suspected">submitted</span>`;
      if (r.excluded) tags += `<span class="tag neutral">excluded</span>`;
    }
    const v = w.volume;
    let flow = '';
    const lower = v?.usdPartial || v?.usdMissing?.length; // capped history, or a coin without a price
    const native = v?.networks?.find(n => n.received > 0);
    if (v?.usdReceived) flow = `<span class="tag flow" title="Lifetime received, at today's prices${lower ? ' (at least)' : ''}">≈ ${esc(fmtUsd(v.usdReceived))}${lower ? '+' : ''} in</span>`;
    else if (native) flow = `<span class="tag flow" title="Lifetime received (no USD price available)">${esc(fmtCoin(native.received))} ${esc(native.asset)}${native.partial ? '+' : ''} in</span>`;
    else if (v && !v.placeholder && !v.networks?.length && v.checked?.length && !v.errors?.length) flow = `<span class="tag neutral">no on-chain activity</span>`;
    if (v?.txCount > 0) flow += `<span class="tag neutral" title="Transactions on record">${esc(fmtCount(v.txCount))}${v.txCountPartial ? '+' : ''} txs</span>`;
    if (v?.service) flow += `<span class="tag info" title="Very busy or very large wallet, or tagged by an explorer as an exchange: probably not the scammer's own. Details in the toolbar popup.">likely exchange</span>`;
    if (v?.poisoning?.length) flow += `<span class="tag suspected" title="Look-alike addresses sent dust to this wallet's counterparties. Details in the toolbar popup.">address poisoning</span>`;
    const chain = /^0x/i.test(w.address) ? 'evm' : w.chain;
    return `<li>${tags}${flow}<span class="muted">${esc(chain)}${w.confidence !== 'high' ? ' (no checksum)' : ''}</span><br><code>${esc(w.address)}</code></li>`;
  }

  const fmtCoin = n => (n >= 1000 ? Math.round(n).toLocaleString() : Number(n.toPrecision(3)).toString());
  const fmtCount = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : n.toLocaleString());

  function fmtUsd(n) {
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
    return '$' + Math.round(n);
  }

  function render() {
    const mode = settings?.widget || 'alerts';
    const show = enabled && !dismissed && mode !== 'never' && (mode === 'always' || alerting() || wallets.length > 0);
    if (!show) { if (host) host.style.display = 'none'; return; }
    if (!host) {
      host = document.createElement('div');
      host.id = 'sb-ext-host';
      root = host.attachShadow({ mode: 'closed' });
      document.documentElement.appendChild(host);
      if (alerting()) collapsed = false;
    }
    host.style.display = '';
    const v = effective?.verdict || 'not_in_hub';
    const color = { scam: '#d52a2b', suspected: '#b45309', not_scam: '#007e65', not_in_hub: '#0871c3' }[v] || '#636e72';
    const label = effective?.label || VERDICT_LABEL[v] || v; // I4G checks bring their own label

    if (collapsed) {
      const n = wallets.length ? ` · ${wallets.length} wallet${wallets.length > 1 ? 's' : ''}` : '';
      root.innerHTML = `<style>${CSS}</style><div class="wrap"><button class="pill" style="background:${color}" title="BeaverBusters checker">🛡 ${esc(label)}${n}</button></div>`;
      root.querySelector('.pill').onclick = () => { collapsed = false; render(); };
      return;
    }

    const lines = [];
    if (effective?.parent) lines.push(`<p class="row">Parent domain <b>${esc(effective.via)}</b> is flagged.</p>`);
    if (check?.source === 'i4g') {
      if (check.known) {
        lines.push(`<p class="row">Status: ${esc(check.status)} · ${check.hasWallets ? 'wallets on record' : 'no wallets collected yet'}</p>`);
        if (check.stale) lines.push(`<p class="row muted">Newest wallet on record is over 30 days old.</p>`);
      } else {
        lines.push(`<p class="row"><b>Not reported to I4G yet</b></p>`);
      }
    } else if (check?.known || check?.parent?.known) {
      const c = check.known ? check : check.parent;
      lines.push(`<p class="row">${c.submitted ? `Submitted by ${esc((c.submitted_by || []).join(', ') || 'a contributor')}` : '<b>Not submitted yet</b>'}${c.claimed_by ? ` · claimed by ${esc(c.claimed_by)}` : ''}</p>`);
      lines.push(`<p class="row muted">${esc(c.wallet_count ?? 0)} wallet(s) on record${c.status ? ' · ' + esc(c.status) : ''}</p>`);
    }
    if (autoSubmitted?.count) lines.push(`<p class="row muted">Auto-added ${autoSubmitted.count} new wallet(s) to the hub.</p>`);
    if (wallets.length) lines.push(`<p class="row"><b>${wallets.length}</b> wallet address(es) on this page</p><ul>${wallets.slice(0, 25).map(walletLine).join('')}</ul>`);
    lines.push(`<p class="row muted" style="margin-top:6px">Open the toolbar icon to submit or classify.</p>`);

    root.innerHTML = `<style>${CSS}</style><div class="wrap"><div class="panel">
      <div class="head" style="background:${color}"><b>🛡 ${esc(label)}</b>
        <button class="min" title="Minimise">–</button><button class="x" title="Hide on this page">×</button></div>
      <div class="body">${lines.join('')}</div></div></div>`;
    root.querySelector('.min').onclick = () => { collapsed = true; render(); };
    root.querySelector('.x').onclick = () => { dismissed = true; render(); };
  }

  // ---------- start ----------

  (async () => {
    if (!(await hello())) return;
    render();
    if (!enabled) return;
    await scan();
    if (settings?.walletScan) observer.observe(document.documentElement, { childList: true, subtree: true });
  })();
})();
