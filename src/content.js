// Content script: finds wallet addresses on the page and shows a small corner widget.
// It never talks to the hub directly; the background does every API call.
(() => {
  if (window.__sbExtLoaded) return;
  window.__sbExtLoaded = true;

  const ext = globalThis.browser ?? globalThis.chrome;
  const B58 = '1-9A-HJ-NP-Za-km-z';
  const B32 = '02-9ac-hj-np-z';

  // Candidate shapes. The hub re-checks every address per chain on write, so these only need
  // to find candidates; `check` upgrades base58check-valid ones to high confidence.
  const PATTERNS = [
    { guess: 'eth/evm', re: /\b0x[a-fA-F0-9]{40}\b/g, confidence: 'high' },
    { guess: 'btc', re: new RegExp(`\\bbc1[${B32}]{11,71}\\b`, 'gi'), confidence: 'high' },
    { guess: 'ltc', re: new RegExp(`\\bltc1[${B32}]{11,71}\\b`, 'gi'), confidence: 'high' },
    { guess: 'bch', re: new RegExp(`\\b(?:bitcoincash:)?[qp][${B32}]{41}\\b`, 'g'), confidence: 'high', strip: /^bitcoincash:/ },
    { guess: 'ada', re: new RegExp(`\\baddr1[${B32}]{50,110}\\b`, 'g'), confidence: 'high' },
    { guess: 'ton', re: /\b(?:EQ|UQ)[A-Za-z0-9_-]{46}(?![A-Za-z0-9_-])/g, confidence: 'high' },
    { guess: 'trx', re: new RegExp(`\\bT[${B58}]{33}\\b`, 'g'), confidence: 'medium', check: true },
    { guess: 'btc', re: new RegExp(`\\b[13][${B58}]{25,34}\\b`, 'g'), confidence: 'medium', check: true },
    { guess: 'ltc', re: new RegExp(`\\b[LM][${B58}]{26,33}\\b`, 'g'), confidence: 'medium', check: true },
    { guess: 'doge', re: new RegExp(`\\bD[5-9A-HJ-NP-U][${B58}]{32}\\b`, 'g'), confidence: 'medium', check: true },
    { guess: 'dash', re: new RegExp(`\\bX[${B58}]{33}\\b`, 'g'), confidence: 'medium', check: true },
    { guess: 'xrp', re: /\br[1-9A-HJ-NP-Za-km-z]{24,34}\b/g, confidence: 'medium' },
    { guess: 'sol', re: new RegExp(`\\b[${B58}]{32,44}\\b`, 'g'), confidence: 'low', sol: true },
  ];

  const ATTRS = ['value', 'data-clipboard-text', 'data-address', 'data-wallet', 'data-copy', 'data-text', 'data-value', 'title', 'aria-label', 'alt', 'placeholder'];
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG']);
  const MAX_TEXT = 1_500_000;

  // ---------- base58check (BTC/LTC/DOGE/DASH/TRX legacy addresses) ----------

  const ALPHA = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  function b58decode(s) {
    const bytes = [0];
    for (const ch of s) {
      let carry = ALPHA.indexOf(ch);
      if (carry < 0) return null;
      for (let i = 0; i < bytes.length; i++) {
        carry += bytes[i] * 58;
        bytes[i] = carry & 0xff;
        carry >>= 8;
      }
      while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
    }
    for (const ch of s) { if (ch === '1') bytes.push(0); else break; }
    return new Uint8Array(bytes.reverse());
  }
  async function b58checkOk(s) {
    const raw = b58decode(s);
    if (!raw || raw.length < 5) return false;
    const payload = raw.slice(0, -4);
    const h1 = await crypto.subtle.digest('SHA-256', payload);
    const h2 = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
    return raw.slice(-4).every((b, i) => b === h2[i]);
  }

  function looksLikeSol(s) {
    return /\d/.test(s) && /[A-Z]/.test(s) && /[a-z]/.test(s) && !/^[0-9a-fA-F]+$/.test(s);
  }

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

  async function extract(sources) {
    const found = new Map();
    const failed = new Set(); // right shape for a checksummed chain but a bad checksum: not an address
    for (const { where, text } of sources) {
      if (!text) continue;
      for (const p of PATTERNS) {
        p.re.lastIndex = 0;
        for (const m of text.matchAll(p.re)) {
          let addr = m[0];
          if (p.strip) addr = addr.replace(p.strip, '');
          if (p.guess === 'bch') addr = addr.toLowerCase();
          if (found.has(addr) || failed.has(addr) || [...found.keys()].some(k => k.includes(addr))) continue;
          if (p.sol && !looksLikeSol(addr)) continue;
          let confidence = p.confidence;
          if (p.check) {
            if (!(await b58checkOk(addr))) { failed.add(addr); continue; }
            confidence = 'high';
          }
          found.set(addr, { address: addr, guess: p.guess, confidence, where });
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
        wallets = res.wallets || wallets;
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
        if (res && !res.error) { wallets = res.wallets || wallets; render(); }
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
    .head button { background: rgba(255,255,255,.2); color: #fff; border: 0; border-radius: 4px; width: 22px; height: 22px; cursor: pointer; font-size: 13px; line-height: 1; }
    .body { padding: 8px 10px; }
    .row { margin: 0 0 6px; }
    .muted { color: #636e72; }
    ul { list-style: none; margin: 4px 0 0; padding: 0; }
    li { padding: 5px 0; border-top: 1px solid #f1f2f6; }
    code { font: 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
    .tag { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10px; font-weight: 600; margin-right: 4px; color: #fff; }
    .scam { background: #d63031; } .suspected { background: #e17055; } .not_scam { background: #00b894; }
    .neutral { background: #636e72; } .info { background: #0984e3; }
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
    return `<li>${tags}<span class="muted">${esc(w.guess)}${w.confidence !== 'high' ? ' ?' : ''}</span><br><code>${esc(w.address)}</code></li>`;
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
    const color = { scam: '#d63031', suspected: '#e17055', not_scam: '#00b894', not_in_hub: '#0984e3' }[v] || '#636e72';
    const label = VERDICT_LABEL[v] || v;

    if (collapsed) {
      const n = wallets.length ? ` · ${wallets.length} wallet${wallets.length > 1 ? 's' : ''}` : '';
      root.innerHTML = `<style>${CSS}</style><div class="wrap"><button class="pill" style="background:${color}" title="BeaverBusters checker">🛡 ${esc(label)}${n}</button></div>`;
      root.querySelector('.pill').onclick = () => { collapsed = false; render(); };
      return;
    }

    const lines = [];
    if (effective?.parent) lines.push(`<p class="row">Parent domain <b>${esc(effective.via)}</b> is flagged.</p>`);
    if (check?.known || check?.parent?.known) {
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
