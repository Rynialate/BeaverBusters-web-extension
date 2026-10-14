/*
 * Background script (Chrome service worker / Firefox event page).
 *
 *  - Live domain checking on every top-level navigation, with a per-tab badge
 *    and an interstitial warning page for known scam sites.
 *  - Checks wallet addresses found by the content script.
 *  - Context menu actions (check / report selection, link or page).
 *  - Message hub for the popup, options and warning pages. All API traffic
 *    goes through here so the API key never leaves the background context.
 *
 * Nothing runs until an API key has been saved.
 */
if (typeof importScripts === 'function') {
  importScripts('lib/compat.js', 'lib/config.js', 'lib/storage.js', 'lib/wallets.js', 'lib/openapi.js', 'lib/verdict.js', 'lib/api.js');
}

(function () {
  'use strict';
  const { ext, config, store, api, wallets } = globalThis.BB;
  const WARNING_PAGE = ext.runtime.getURL('warning/warning.html');
  const COLORS = { scam: '#c5221f', suspicious: '#e37400', safe: '#188038', unknown: '#5f6368', error: '#5f6368', key: '#5f6368' };

  // ---------------------------------------------------------------------------
  // Per-tab state (kept in storage.session so it survives worker restarts)
  // ---------------------------------------------------------------------------

  const tabLocks = new Map();
  const tabKey = (tabId) => 'tab:' + tabId;

  async function getTab(tabId) {
    return (await store.session.get(tabKey(tabId))) || {};
  }

  /** Serialised read-modify-write of a tab's state. */
  function updateTab(tabId, fn) {
    const prev = tabLocks.get(tabId) || Promise.resolve();
    const next = prev.then(async () => {
      const cur = (await store.session.get(tabKey(tabId))) || {};
      const out = fn(cur) || cur;
      await store.session.set(tabKey(tabId), out);
      return out;
    });
    tabLocks.set(tabId, next.catch(() => {}));
    return next;
  }

  ext.tabs.onRemoved.addListener((tabId) => {
    tabLocks.delete(tabId);
    store.session.remove(tabKey(tabId));
  });

  async function getAllowedHosts() {
    return (await store.session.get('allowedHosts')) || {};
  }

  function slim(v) {
    if (!v) return v;
    return { level: v.level, label: v.label, score: v.score, reasons: (v.reasons || []).slice(0, 5), fields: (v.fields || []).slice(0, 12), op: v.op, error: v.error, checkedAt: v.checkedAt };
  }

  // ---------------------------------------------------------------------------
  // Badge
  // ---------------------------------------------------------------------------

  async function refreshKeyBadge() {
    const key = await store.getApiKey();
    await ext.action.setBadgeText({ text: key ? '' : 'KEY' });
    await ext.action.setBadgeBackgroundColor({ color: COLORS.key });
    await ext.action.setTitle({ title: key ? 'BeaverBusters' : 'BeaverBusters: API key required, click to set up' });
  }

  async function refreshBadge(tabId) {
    if (!(await store.getApiKey())) return;
    const st = await getTab(tabId);
    const flagged = Object.values(st.wallets || {}).filter((w) => w.verdict && (w.verdict.level === 'scam' || w.verdict.level === 'suspicious'));
    const d = st.domain;
    let text = '';
    let color = COLORS.unknown;
    let title = 'BeaverBusters';
    if (st.checking) {
      text = '…';
      title = 'BeaverBusters: checking ' + st.host;
    } else if (d && d.level === 'scam') {
      text = '!';
      color = COLORS.scam;
      title = 'BeaverBusters: ' + st.host + ' is a known scam site';
    } else if (flagged.length) {
      text = String(flagged.length);
      color = flagged.some((w) => w.verdict.level === 'scam') ? COLORS.scam : COLORS.suspicious;
      title = 'BeaverBusters: ' + flagged.length + ' flagged wallet address' + (flagged.length === 1 ? '' : 'es') + ' on this page';
    } else if (d && d.level === 'suspicious') {
      text = '?';
      color = COLORS.suspicious;
      title = 'BeaverBusters: ' + st.host + ' is suspicious';
    } else if (d && d.level === 'safe') {
      text = '✓';
      color = COLORS.safe;
      title = 'BeaverBusters: no threats found for ' + st.host;
    } else if (d && d.level === 'unknown') {
      title = 'BeaverBusters: ' + st.host + ' is not in the database';
    } else if (d && d.level === 'error') {
      text = '×';
      title = 'BeaverBusters: check failed (' + (d.error || 'error') + ')';
    }
    try {
      await ext.action.setBadgeText({ tabId, text });
      await ext.action.setBadgeBackgroundColor({ tabId, color });
      await ext.action.setTitle({ tabId, title });
    } catch (e) {
      /* tab closed */
    }
  }

  // ---------------------------------------------------------------------------
  // Live domain checking
  // ---------------------------------------------------------------------------

  /** Hosts that are never sent to the API. */
  function skipReason(host, settings) {
    if (wallets.isPrivateHost(host)) return 'Local or private address';
    if ((settings.trustedDomains || []).some((d) => wallets.hostMatches(host, d))) return 'On your trusted list';
    const apiHost = api.apiHost();
    if (apiHost && wallets.hostMatches(host, apiHost)) return 'BeaverBusters API';
    return '';
  }

  async function onNavigation(details, phase) {
    if (details.frameId !== 0 || details.tabId < 0) return;
    const tabId = details.tabId;
    let u;
    try {
      u = new URL(details.url);
    } catch (e) {
      return;
    }
    const isWeb = u.protocol === 'http:' || u.protocol === 'https:';
    const host = isWeb ? u.hostname.toLowerCase() : '';

    if (phase === 'committed') {
      await updateTab(tabId, (cur) => ({
        host,
        url: details.url,
        nav: host,
        domain: cur.host === host && cur.domain && cur.domain.level !== 'error' ? cur.domain : null,
        wallets: {},
        checking: false,
        lastSafeUrl: cur.lastSafeUrl,
        // Once the warning page is showing, a later visit to the same URL (Back, a link) must redirect again.
        redirectedFor: details.url.startsWith(WARNING_PAGE) ? null : cur.redirectedFor,
        redirectedAt: cur.redirectedAt,
      }));
    } else {
      await updateTab(tabId, (cur) => Object.assign(cur, { nav: host }));
    }
    if (!isWeb) return refreshBadge(tabId);

    const settings = await store.getSettings();
    if (!(await store.getApiKey())) return;
    if (!settings.liveDomainCheck) return refreshBadge(tabId);

    const skip = skipReason(host, settings);
    if (skip) {
      if (phase === 'committed') {
        await updateTab(tabId, (cur) => Object.assign(cur, { domain: { level: 'skipped', label: 'Not checked', reasons: [skip] }, lastSafeUrl: details.url }));
        await refreshBadge(tabId);
      }
      return;
    }

    if (phase === 'committed') {
      await updateTab(tabId, (cur) => Object.assign(cur, { checking: !cur.domain }));
      await refreshBadge(tabId);
    }

    let verdict;
    try {
      verdict = await api.checkDomain(host, { url: details.url });
    } catch (err) {
      verdict = { level: 'error', label: 'Check failed', error: err.message, code: err.code, reasons: [], fields: [] };
    }

    const st = await updateTab(tabId, (cur) => {
      if (cur.host === host) {
        cur.domain = slim(verdict);
        cur.checking = false;
        if (verdict.level !== 'scam') cur.lastSafeUrl = cur.url;
      }
      return cur;
    });
    await refreshBadge(tabId);

    if (verdict.level === 'scam' && settings.blockScamSites && (st.nav === host || st.host === host)) {
      const allowed = await getAllowedHosts();
      if (allowed[host]) return;
      // Both the before-navigate and committed handlers get here for the same
      // navigation; decide inside the tab lock so only one of them redirects.
      let redirect = false;
      await updateTab(tabId, (cur) => {
        const recent = cur.redirectedFor === details.url && Date.now() - (cur.redirectedAt || 0) < 10000;
        if (!recent && (cur.nav === host || cur.host === host)) {
          cur.redirectedFor = details.url;
          cur.redirectedAt = Date.now();
          redirect = true;
        }
        return cur;
      });
      if (!redirect) return;
      try {
        await ext.tabs.update(tabId, { url: WARNING_PAGE + '?url=' + encodeURIComponent(details.url) });
      } catch (e) {
        /* tab closed */
      }
    }
  }

  ext.webNavigation.onBeforeNavigate.addListener((d) => onNavigation(d, 'before').catch(logError));
  ext.webNavigation.onCommitted.addListener((d) => onNavigation(d, 'committed').catch(logError));

  function logError(err) {
    console.warn('[BeaverBusters]', err && err.message ? err.message : err);
  }

  // ---------------------------------------------------------------------------
  // Wallets found on pages
  // ---------------------------------------------------------------------------

  function originOf(url) {
    try {
      return new URL(url).origin + '/';
    } catch (e) {
      return '';
    }
  }

  async function handleWallets(tabId, msg) {
    const settings = await store.getSettings();
    if (!msg.manual && !settings.autoWalletScan) return { results: [] };
    let list = Array.isArray(msg.candidates) ? msg.candidates.slice() : [];

    if (settings.serverWalletExtraction && msg.text && (await api.hasFeature('extractWallets'))) {
      try {
        const found = await api.extractWallets(String(msg.text).slice(0, config.MAX_PAGE_TEXT_CHARS), settings.sendFullUrl ? msg.url : originOf(msg.url));
        const seen = new Set(list.map((w) => w.address.toLowerCase()));
        for (const w of found) if (!seen.has(w.address.toLowerCase())) list.push(w);
      } catch (err) {
        if (err.code === 'AUTH' || err.code === 'NO_API_KEY') throw err;
        logError(err);
      }
    }

    list = list.filter((w) => w && typeof w.address === 'string').slice(0, config.MAX_WALLETS_PER_PAGE);
    if (!list.length) return { results: [] };
    const verdicts = await api.checkWallets(list);
    const results = list.map((w) => Object.assign({}, w, { verdict: slim(verdicts.get(w.address)) || null }));
    if (tabId >= 0) {
      await updateTab(tabId, (cur) => {
        cur.wallets = cur.wallets || {};
        for (const r of results) cur.wallets[r.address] = r;
        return cur;
      });
      await refreshBadge(tabId);
    }
    return { results };
  }

  // ---------------------------------------------------------------------------
  // Context menus
  // ---------------------------------------------------------------------------

  async function setupMenus() {
    await ext.contextMenus.removeAll();
    ext.contextMenus.create({ id: 'bb-check-selection', title: 'Check “%s” with BeaverBusters', contexts: ['selection'] });
    ext.contextMenus.create({ id: 'bb-report-selection', title: 'Report “%s” to BeaverBusters', contexts: ['selection'] });
    ext.contextMenus.create({ id: 'bb-check-link', title: 'Check this link with BeaverBusters', contexts: ['link'] });
    ext.contextMenus.create({ id: 'bb-report-page', title: 'Report this site to BeaverBusters', contexts: ['page'] });
  }

  async function openPopupWindow(params) {
    const url = ext.runtime.getURL('popup/popup.html') + '?' + new URLSearchParams(params).toString();
    if (ext.windows && ext.windows.create) {
      try {
        await ext.windows.create({ url, type: 'popup', width: 440, height: 680 });
        return;
      } catch (e) {
        /* fall through */
      }
    }
    await ext.tabs.create({ url });
  }

  async function toast(tabId, payload, fallbackParams) {
    try {
      await ext.tabs.sendMessage(tabId, Object.assign({ type: 'bb:toast' }, payload), { frameId: 0 });
    } catch (e) {
      if (fallbackParams) await openPopupWindow(fallbackParams);
    }
  }

  ext.contextMenus.onClicked.addListener((info, tab) => {
    handleMenu(info, tab).catch(logError);
  });

  async function handleMenu(info, tab) {
    if (!(await store.getApiKey())) {
      await ext.runtime.openOptionsPage();
      return;
    }
    const tabId = tab && tab.id !== undefined ? tab.id : -1;
    const pageUrl = info.pageUrl || (tab && tab.url) || '';

    if (info.menuItemId === 'bb-report-page') {
      const domain = wallets.normalizeDomain(pageUrl);
      return openPopupWindow({ view: 'report', kind: 'domain', value: domain, url: pageUrl, tabId });
    }
    if (info.menuItemId === 'bb-report-selection') {
      const q = wallets.detectQuery(info.selectionText);
      return openPopupWindow({ view: 'report', kind: q.kind === 'wallet' ? 'wallet' : 'domain', value: q.value, url: q.url || '', page: pageUrl, tabId });
    }

    const text = info.menuItemId === 'bb-check-link' ? info.linkUrl : info.selectionText;
    const q = wallets.detectQuery(text);
    const fallback = { view: 'lookup', q: q.value || text || '', tabId };
    if (q.kind !== 'wallet' && q.kind !== 'domain') {
      return toast(tabId, { level: 'unknown', title: 'Nothing to check', message: 'Select a wallet address or a domain / URL.' }, fallback);
    }
    await toast(tabId, { level: 'checking', title: 'Checking…', message: q.value });
    try {
      const v = q.kind === 'wallet' ? await api.checkWallet({ address: q.value, chain: q.chain }) : await api.checkDomain(q.value, { url: q.url });
      await toast(tabId, { level: v.level, title: v.label, message: q.value, reasons: (v.reasons || []).slice(0, 3), highlight: q.kind === 'wallet' && (v.level === 'scam' || v.level === 'suspicious') ? q.value : '' }, fallback);
    } catch (err) {
      await toast(tabId, { level: 'error', title: 'Check failed', message: err.message }, fallback);
    }
  }

  // ---------------------------------------------------------------------------
  // Messaging
  // ---------------------------------------------------------------------------

  async function status() {
    const [apiKey, keyStatus, settings] = await Promise.all([store.getApiKey(), store.getKeyStatus(), store.getSettings()]);
    const out = { hasKey: !!apiKey, keyStatus, docsUrl: config.DOCS_URL, settings, spec: null, features: {} };
    if (apiKey) {
      const st = await api.loadSpec();
      out.spec = { ok: !st.error, error: st.error || null, warning: st.warning || null, title: st.info ? st.info.title : '', version: st.info ? st.info.version : '', specUrl: st.specUrl };
      for (const name of Object.keys(st.features || {})) out.features[name] = !!st.features[name].op;
    }
    return out;
  }

  async function ensureContentScript(tabId) {
    try {
      await ext.tabs.sendMessage(tabId, { type: 'bb:ping' }, { frameId: 0 });
      return true;
    } catch (e) {
      try {
        await ext.scripting.executeScript({ target: { tabId }, files: ['lib/compat.js', 'lib/wallets.js', 'content/content.js'] });
        await ext.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  async function tabInfo(tabId) {
    let st = await getTab(tabId);
    let tab = null;
    try {
      tab = await ext.tabs.get(tabId);
    } catch (e) {
      /* ignore */
    }
    const url = (tab && tab.url) || st.url || '';
    let host = '';
    try {
      const u = new URL(url);
      if (u.protocol === 'http:' || u.protocol === 'https:') host = u.hostname.toLowerCase();
    } catch (e) {
      /* ignore */
    }
    if (host && (!st.domain || st.host !== host)) {
      const settings = await store.getSettings();
      const skip = skipReason(host, settings);
      let domain;
      if (skip) domain = { level: 'skipped', label: 'Not checked', reasons: [skip] };
      else {
        try {
          domain = slim(await api.checkDomain(host, { url }));
        } catch (err) {
          domain = { level: 'error', label: 'Check failed', error: err.message, code: err.code };
        }
      }
      st = await updateTab(tabId, (cur) => Object.assign(cur, { host, url, domain, wallets: cur.host === host ? cur.wallets || {} : {} }));
      await refreshBadge(tabId);
    }
    const allowed = await getAllowedHosts();
    return { tabId, url, host, title: (tab && tab.title) || '', domain: st.domain || null, wallets: Object.values(st.wallets || {}), allowed: !!allowed[host] };
  }

  async function lookup(query) {
    const q = wallets.detectQuery(query);
    const out = { query: q, verdict: null, submissions: null };
    const jobs = [];
    if (q.kind === 'wallet') jobs.push(api.checkWallet({ address: q.value, chain: q.chain }, { force: true }).then((v) => (out.verdict = v)));
    if (q.kind === 'domain') jobs.push(api.checkDomain(q.value, { url: q.url, force: true }).then((v) => (out.verdict = v)));
    if (q.kind !== 'empty' && (await api.hasFeature('submissionStatus'))) {
      jobs.push(
        api.submissionStatus(q).then(
          (s) => (out.submissions = s),
          (err) => (out.submissions = { ok: false, error: err.message, code: err.code })
        )
      );
    }
    const settled = await Promise.allSettled(jobs);
    const failed = settled.find((s) => s.status === 'rejected');
    if (failed && !out.verdict) out.verdictError = failed.reason.message;
    if (!jobs.length) out.verdictError = q.kind === 'submission' ? 'The API has no submission status endpoint.' : 'Enter a domain, URL, wallet address or submission ID.';
    return out;
  }

  async function saveSettings(patch) {
    const before = await store.getSettings();
    if (patch && Array.isArray(patch.trustedDomains)) {
      patch.trustedDomains = patch.trustedDomains.map((d) => wallets.normalizeDomain(d) || String(d).trim().toLowerCase()).filter(Boolean);
    }
    const after = await store.saveSettings(patch);
    if (before.baseUrl !== after.baseUrl || before.specUrl !== after.specUrl || JSON.stringify(before.endpointOverrides) !== JSON.stringify(after.endpointOverrides)) {
      api.invalidateSpec();
    }
    return after;
  }

  const handlers = {
    'bb:ping': async () => ({ ok: true }),
    'bb:status': status,

    'bb:setApiKey': async (msg) => {
      const key = String(msg.key || '').trim();
      if (!key) return { ok: false, error: 'Enter an API key.' };
      if (!msg.skipVerify) {
        const r = await api.verifyKey(key);
        if (r.valid === false) return { ok: false, error: r.message };
        if (r.valid === null) return { ok: false, canSkip: true, error: r.message };
        await store.setApiKey(key, { state: 'ok', message: r.message });
      } else {
        await store.setApiKey(key, { state: 'unverified', message: 'Saved without verification' });
      }
      api.invalidateSpec();
      await refreshKeyBadge();
      return { ok: true };
    },
    'bb:clearApiKey': async () => {
      await store.clearApiKey();
      await api.clearCache();
      await refreshKeyBadge();
      const tabs = await ext.tabs.query({});
      await Promise.all(tabs.map((t) => ext.action.setBadgeText({ tabId: t.id, text: null }).catch(() => {})));
      return { ok: true };
    },

    'bb:getSettings': async () => ({ ok: true, settings: await store.getSettings() }),
    'bb:saveSettings': async (msg) => ({ ok: true, settings: await saveSettings(msg.patch || {}) }),
    'bb:trustDomain': async (msg) => {
      const s = await store.getSettings();
      const d = wallets.normalizeDomain(msg.domain);
      if (!d) return { ok: false, error: 'Not a domain' };
      await saveSettings({ trustedDomains: Array.from(new Set((s.trustedDomains || []).concat(d))) });
      return { ok: true };
    },

    'bb:specInfo': async (msg) => ({ ok: true, info: await api.getSpecInfo(msg.force) }),
    'bb:importSpec': async (msg) => {
      await api.importSpec(msg.text);
      return { ok: true, info: await api.getSpecInfo() };
    },
    'bb:clearImportedSpec': async () => {
      await api.clearImportedSpec();
      return { ok: true, info: await api.getSpecInfo(true) };
    },
    'bb:clearCache': async () => {
      await api.clearCache();
      return { ok: true };
    },

    'bb:getTabInfo': async (msg) => ({ ok: true, info: await tabInfo(msg.tabId) }),
    'bb:checkDomain': async (msg) => {
      const domain = wallets.normalizeDomain(msg.domain);
      if (!domain) return { ok: false, error: 'That is not a valid domain.' };
      const v = await api.checkDomain(domain, { force: !!msg.force, url: msg.url });
      if (msg.tabId !== undefined && msg.tabId >= 0) {
        await updateTab(msg.tabId, (cur) => {
          if (cur.host === domain) cur.domain = slim(v);
          return cur;
        });
        await refreshBadge(msg.tabId);
      }
      return { ok: true, verdict: v };
    },
    'bb:checkWallet': async (msg) => {
      const info = wallets.classifyAddress(msg.address);
      if (!info) return { ok: false, error: 'That does not look like a wallet address.' };
      return { ok: true, verdict: await api.checkWallet({ address: info.address, chain: msg.chain || info.chain, ambiguous: msg.chain ? false : info.ambiguous }, { force: !!msg.force }) };
    },
    'bb:lookup': async (msg) => ({ ok: true, result: await lookup(msg.query) }),
    'bb:submissionStatus': async (msg) => ({ ok: true, result: await api.submissionStatus(msg.query) }),
    'bb:listSubmissions': async () => {
      const history = await store.getHistory();
      let server = null;
      if (await api.hasFeature('listSubmissions')) {
        try {
          server = await api.listSubmissions();
        } catch (err) {
          server = { ok: false, error: err.message };
        }
      }
      return { ok: true, history, server, canCheckStatus: await api.hasFeature('submissionStatus') };
    },
    'bb:getSubmitForm': async (msg) => ({ ok: true, form: await api.getSubmitForm(msg.kind, msg.context) }),
    'bb:submit': async (msg) => ({ ok: true, result: await api.submit(msg.kind, msg.values, msg.target) }),
    'bb:rescanTab': async (msg) => {
      const ok = await ensureContentScript(msg.tabId);
      if (!ok) return { ok: false, error: 'This page cannot be scanned.' };
      const reply = await ext.tabs.sendMessage(msg.tabId, { type: 'bb:rescan' }, { frameId: 0 });
      return { ok: true, results: (reply && reply.results) || [] };
    },
    'bb:openReport': async (msg) => {
      await openPopupWindow({ view: 'report', kind: msg.kind || 'domain', value: msg.value || '', url: msg.url || '' });
      return { ok: true };
    },

    // Content script
    'bb:pageInit': async (msg, sender) => {
      const settings = await store.getSettings();
      const hasKey = !!(await store.getApiKey());
      const scan = { auto: settings.autoWalletScan, server: settings.serverWalletExtraction, highlight: settings.highlightWallets };
      if (!hasKey) return { ok: true, enabled: false, scan };
      let banner = null;
      const host = wallets.normalizeDomain(msg.url);
      if (host && settings.liveDomainCheck && !skipReason(host, settings)) {
        try {
          const v = await Promise.race([api.checkDomain(host, { url: msg.url }), new Promise((r) => setTimeout(() => r(null), 8000))]);
          const allowed = (await getAllowedHosts())[host];
          if (v && v.level === 'scam' && (allowed || !settings.blockScamSites)) banner = { level: 'scam', host, label: v.label, reasons: (v.reasons || []).slice(0, 3) };
          else if (v && v.level === 'suspicious' && settings.warnSuspicious) banner = { level: 'suspicious', host, label: v.label, reasons: (v.reasons || []).slice(0, 3) };
        } catch (err) {
          /* the badge shows the error */
        }
      }
      return { ok: true, enabled: true, scan, banner };
    },
    'bb:walletsFound': async (msg, sender) => {
      const tabId = sender.tab ? sender.tab.id : -1;
      return Object.assign({ ok: true }, await handleWallets(tabId, msg));
    },

    // Warning page
    'bb:warningInfo': async (msg) => {
      const host = wallets.normalizeDomain(msg.url);
      let v = host ? await api.peekDomain(host) : null;
      if (!v && host) {
        try {
          v = await api.checkDomain(host, { url: msg.url });
        } catch (err) {
          v = null;
        }
      }
      return { ok: true, host, verdict: v };
    },
    'bb:allowHost': async (msg, sender) => {
      const host = wallets.normalizeDomain(msg.url);
      if (!host || !/^https?:/i.test(msg.url)) return { ok: false, error: 'Invalid URL' };
      const allowed = await getAllowedHosts();
      allowed[host] = Date.now();
      await store.session.set('allowedHosts', allowed);
      if (sender.tab) await ext.tabs.update(sender.tab.id, { url: msg.url });
      return { ok: true };
    },
    'bb:leave': async (msg, sender) => {
      if (!sender.tab) return { ok: false };
      const st = await getTab(sender.tab.id);
      if (st.lastSafeUrl && /^https?:/i.test(st.lastSafeUrl)) {
        await ext.tabs.update(sender.tab.id, { url: st.lastSafeUrl });
      } else {
        await ext.tabs.create({ windowId: sender.tab.windowId, active: true });
        await ext.tabs.remove(sender.tab.id);
      }
      return { ok: true };
    },
  };

  // Only extension pages may use these; content scripts get the page subset.
  const CONTENT_ALLOWED = new Set(['bb:ping', 'bb:pageInit', 'bb:walletsFound', 'bb:openReport']);

  function isExtensionPage(sender) {
    const origin = ext.runtime.getURL('');
    return !!sender.url && sender.url.startsWith(origin);
  }

  ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string' || !handlers[msg.type]) return false;
    if (sender.id !== ext.runtime.id) return false;
    if (!isExtensionPage(sender) && !CONTENT_ALLOWED.has(msg.type)) {
      sendResponse({ ok: false, error: 'Not allowed' });
      return false;
    }
    handlers[msg.type](msg, sender).then(
      (res) => sendResponse(res),
      (err) => sendResponse({ ok: false, error: (err && err.message) || String(err), code: err && err.code })
    );
    return true;
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  ext.runtime.onInstalled.addListener(async (details) => {
    await setupMenus().catch(logError);
    await refreshKeyBadge().catch(logError);
    if (details.reason === 'install' && !(await store.getApiKey())) {
      await ext.runtime.openOptionsPage();
    }
  });
  ext.runtime.onStartup.addListener(() => {
    refreshKeyBadge().catch(logError);
  });
  ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.apiKey) refreshKeyBadge().catch(logError);
  });

  refreshKeyBadge().catch(logError);
})();
