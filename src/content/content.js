/*
 * Content script: finds wallet address candidates on the page, sends them to
 * the background for checking, highlights flagged ones and shows warnings.
 * UI lives in a closed shadow root so page styles cannot interfere.
 */
(function () {
  'use strict';
  if (window.__beaverBustersLoaded) return;
  window.__beaverBustersLoaded = true;

  const { ext, wallets } = globalThis.BB;
  const MAX_RESCANS = 10;
  const MAX_SERVER_SCANS = 3;
  const TEXT_LIMIT = 200000;
  const MIN_WALLET_LEN = 25;

  let config = null;
  let rescans = 0;
  let serverScans = 0;
  let observer = null;
  let rescanTimer = null;
  const sent = new Set();
  const flagged = new Map();
  let ui = null;

  // ---------------------------------------------------------------------------
  // Text collection
  // ---------------------------------------------------------------------------

  const SKIP_TAGS = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|PATH)$/;

  function collectText(minLen) {
    const rootEl = document.body || document.documentElement;
    if (!rootEl) return '';
    const parts = [];
    let total = 0;
    const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.test(p.tagName)) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.trim().length >= minLen ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      parts.push(n.nodeValue);
      total += n.nodeValue.length + 1;
      if (total > TEXT_LIMIT) break;
    }
    // Addresses also hide in links (explorer URLs, ethereum:/bitcoin: URIs) and copy buttons.
    const attrs = document.querySelectorAll('a[href], input[value], [data-address], [data-wallet], [data-clipboard-text], [data-copy], [data-value]');
    for (let i = 0; i < attrs.length && i < 4000 && total < TEXT_LIMIT * 1.2; i++) {
      const el = attrs[i];
      for (const name of ['href', 'value', 'data-address', 'data-wallet', 'data-clipboard-text', 'data-copy', 'data-value']) {
        const v = el.getAttribute(name);
        if (v && v.length >= MIN_WALLET_LEN && !v.startsWith('data:')) {
          let decoded = v;
          try {
            decoded = decodeURIComponent(v);
          } catch (e) {
            /* keep raw */
          }
          parts.push(decoded);
          total += decoded.length + 1;
        }
      }
    }
    return parts.join('\n');
  }

  // ---------------------------------------------------------------------------
  // Scanning
  // ---------------------------------------------------------------------------

  async function scan(manual) {
    if (!config || !config.enabled) return [];
    if (!manual && !config.scan.auto) return [];
    const useServer = !!config.scan.server && (manual || serverScans < MAX_SERVER_SCANS);
    const text = collectText(useServer ? 1 : MIN_WALLET_LEN);
    const found = wallets.findWallets(text, { limit: 60 });
    const fresh = found.filter((w) => !sent.has(w.address));
    if (!manual && !fresh.length && !(useServer && serverScans === 0)) return [];
    fresh.forEach((w) => sent.add(w.address));

    const payload = { type: 'bb:walletsFound', candidates: manual ? found : fresh, url: location.href, manual: !!manual };
    if (useServer) {
      payload.text = text;
      serverScans++;
    }
    let reply;
    try {
      reply = await ext.runtime.sendMessage(payload);
    } catch (e) {
      return [];
    }
    if (!reply || !reply.ok) return [];
    applyResults(reply.results || []);
    return reply.results || [];
  }

  function applyResults(results) {
    const newlyFlagged = [];
    for (const r of results) {
      const level = r.verdict && r.verdict.level;
      if ((level === 'scam' || level === 'suspicious') && !flagged.has(r.address)) {
        flagged.set(r.address, r);
        newlyFlagged.push(r);
      }
    }
    if (!newlyFlagged.length) return;
    if (config.scan.highlight) highlight(newlyFlagged);
    const worst = newlyFlagged.some((r) => r.verdict.level === 'scam') ? 'scam' : 'suspicious';
    showToast({
      level: worst,
      title: newlyFlagged.length + ' flagged wallet address' + (newlyFlagged.length === 1 ? '' : 'es') + ' on this page',
      message: 'Do not send funds to: ',
      list: newlyFlagged.slice(0, 5).map((r) => r.address + ' (' + r.verdict.label + ')'),
      sticky: worst === 'scam',
    });
  }

  function observe() {
    if (observer || !document.body) return;
    observer = new MutationObserver((mutations) => {
      if (mutations.every((m) => isOwnNode(m.target))) return;
      if (rescans >= MAX_RESCANS) {
        observer.disconnect();
        return;
      }
      clearTimeout(rescanTimer);
      rescanTimer = setTimeout(() => {
        rescans++;
        scan(false).catch(() => {});
      }, 2500);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function isOwnNode(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return !!(el && (el.id === 'bb-ext-root' || (el.classList && el.classList.contains('bb-wallet-flag'))));
  }

  // ---------------------------------------------------------------------------
  // Highlighting
  // ---------------------------------------------------------------------------

  function highlight(items) {
    if (!document.body || !items.length) return;
    const needles = items.map((r) => ({ lower: r.address.toLowerCase(), level: r.verdict ? r.verdict.level : 'scam', label: r.verdict ? r.verdict.label : 'Flagged' }));
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p || SKIP_TAGS.test(p.tagName) || p.tagName === 'TEXTAREA' || p.isContentEditable || p.classList.contains('bb-wallet-flag')) return NodeFilter.FILTER_REJECT;
        return node.nodeValue.length >= MIN_WALLET_LEN ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      },
    });
    const targets = [];
    let n;
    while ((n = walker.nextNode()) && targets.length < 200) {
      const lower = n.nodeValue.toLowerCase();
      if (needles.some((x) => lower.includes(x.lower))) targets.push(n);
    }
    if (observer) observer.disconnect();
    for (const node of targets) wrapMatches(node, needles);
    if (observer) observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function wrapMatches(node, needles) {
    const text = node.nodeValue;
    const lower = text.toLowerCase();
    const ranges = [];
    for (const nd of needles) {
      let i = lower.indexOf(nd.lower);
      while (i !== -1) {
        ranges.push([i, i + nd.lower.length, nd]);
        i = lower.indexOf(nd.lower, i + nd.lower.length);
      }
    }
    if (!ranges.length || !node.parentNode) return;
    ranges.sort((a, b) => a[0] - b[0]);
    const frag = document.createDocumentFragment();
    let pos = 0;
    for (const [s, e, nd] of ranges) {
      if (s < pos) continue;
      if (s > pos) frag.appendChild(document.createTextNode(text.slice(pos, s)));
      const mark = document.createElement('mark');
      mark.className = 'bb-wallet-flag bb-level-' + nd.level;
      mark.title = 'BeaverBusters: ' + nd.label + '. Do not send funds to this address.';
      mark.textContent = text.slice(s, e);
      frag.appendChild(mark);
      pos = e;
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.parentNode.replaceChild(frag, node);
  }

  // ---------------------------------------------------------------------------
  // In-page UI (shadow DOM)
  // ---------------------------------------------------------------------------

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .toasts { position: fixed; right: 16px; bottom: 16px; display: flex; flex-direction: column; gap: 8px; z-index: 2147483647; max-width: min(380px, calc(100vw - 32px)); }
    .toast { background: #fff; color: #1f1f1f; border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.25); border-left: 6px solid #5f6368; padding: 12px 36px 12px 14px; position: relative; font-size: 13px; line-height: 1.4; }
    .toast.scam, .banner.scam { border-color: #c5221f; }
    .toast.suspicious, .banner.suspicious { border-color: #e37400; }
    .toast.safe { border-color: #188038; }
    .title { font-weight: 650; font-size: 14px; margin-bottom: 2px; }
    .brand { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: #5f6368; margin-bottom: 4px; }
    .msg { word-break: break-all; }
    ul { margin: 6px 0 0; padding-left: 18px; }
    li { word-break: break-all; margin: 2px 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
    .close { position: absolute; top: 6px; right: 6px; border: 0; background: transparent; font-size: 18px; line-height: 1; cursor: pointer; color: #5f6368; padding: 4px 6px; border-radius: 6px; }
    .close:hover { background: rgba(0,0,0,.08); }
    .banner { position: fixed; top: 0; left: 0; right: 0; z-index: 2147483647; display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: #fff4e5; color: #1f1f1f; border-bottom: 3px solid #e37400; font-size: 14px; box-shadow: 0 2px 12px rgba(0,0,0,.2); }
    .banner.scam { background: #fce8e6; border-bottom-color: #c5221f; }
    .banner .text { flex: 1; min-width: 0; }
    .banner button { border: 1px solid rgba(0,0,0,.2); background: #fff; color: #1f1f1f; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 13px; }
    @media (prefers-color-scheme: dark) {
      .toast { background: #2a2a2a; color: #eee; }
      .brand, .close { color: #aaa; }
      .banner { background: #3a2a10; color: #eee; }
      .banner.scam { background: #3d1614; }
      .banner button { background: #222; color: #eee; border-color: rgba(255,255,255,.25); }
    }
  `;

  function getUi() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = 'bb-ext-root';
    host.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const toasts = document.createElement('div');
    toasts.className = 'toasts';
    shadow.append(style, toasts);
    (document.body || document.documentElement).appendChild(host);
    ui = { host, shadow, toasts, ctxToast: null };
    return ui;
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function showToast(opts) {
    const u = getUi();
    const t = el('div', 'toast ' + (opts.level || ''));
    t.setAttribute('role', opts.level === 'scam' ? 'alert' : 'status');
    t.append(el('div', 'brand', 'BeaverBusters'), el('div', 'title', opts.title || ''));
    if (opts.message) t.append(el('div', 'msg', opts.message));
    const items = (opts.list || []).concat(opts.reasons || []);
    if (items.length) {
      const ul = el('ul');
      items.forEach((x) => ul.append(el('li', '', x)));
      t.append(ul);
    }
    const close = el('button', 'close', '×');
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => t.remove());
    t.append(close);
    if (opts.replace && u.ctxToast) u.ctxToast.remove();
    if (opts.replace) u.ctxToast = t;
    u.toasts.append(t);
    if (!opts.sticky && opts.level !== 'checking') setTimeout(() => t.remove(), opts.level === 'scam' ? 20000 : 9000);
  }

  function showBanner(b) {
    const u = getUi();
    const bar = el('div', 'banner ' + b.level);
    bar.setAttribute('role', 'alert');
    const text = el('div', 'text');
    const strong = el('strong', '', b.level === 'scam' ? 'Known scam site: ' : 'Suspicious site: ');
    text.append(strong, document.createTextNode(b.host + ' (' + b.label + ')' + (b.reasons && b.reasons.length ? '. ' + b.reasons.join('; ') : '') + '. Do not enter wallet keys, seed phrases or send funds.'));
    const dismiss = el('button', '', 'Dismiss');
    dismiss.addEventListener('click', () => bar.remove());
    bar.append(text, dismiss);
    u.shadow.append(bar);
  }

  // ---------------------------------------------------------------------------
  // Messages from the background
  // ---------------------------------------------------------------------------

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return false;
    if (msg.type === 'bb:ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'bb:toast') {
      showToast(Object.assign({}, msg, { replace: true, sticky: msg.level === 'scam' }));
      if (msg.highlight) highlight([{ address: msg.highlight, verdict: { level: msg.level, label: msg.title } }]);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.type === 'bb:rescan') {
      (async () => {
        if (!config) await init(true);
        return scan(true);
      })().then(
        (results) => sendResponse({ ok: true, results }),
        () => sendResponse({ ok: false, results: [] })
      );
      return true;
    }
    return false;
  });

  async function init(skipAutoScan) {
    try {
      config = await ext.runtime.sendMessage({ type: 'bb:pageInit', url: location.href });
    } catch (e) {
      config = null;
      return;
    }
    if (!config || !config.ok || !config.enabled) return;
    if (config.banner) showBanner(config.banner);
    if (!skipAutoScan && config.scan.auto) {
      await scan(false);
      observe();
    }
  }

  init(false);
})();
