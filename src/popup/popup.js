(function () {
  'use strict';
  const BB = globalThis.BB;
  const { ext, send, ui, wallets } = BB;
  const { h } = ui;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const state = { status: null, tabId: null, tab: null, info: null, reportKind: 'domain', reportContext: {}, form: null };

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  async function boot() {
    if (params.has('view')) document.body.classList.add('windowed');
    $('openOptions').addEventListener('click', () => ext.runtime.openOptionsPage());
    try {
      state.status = await send('bb:status');
    } catch (err) {
      $('loading').replaceChildren(ui.notice('error', 'Could not reach the extension background: ' + err.message));
      return;
    }
    $('loading').hidden = true;
    const ks = state.status.keyStatus;
    if (!state.status.hasKey || (ks && ks.state === 'invalid')) return showGate(ks);
    await showApp();
  }

  function showGate(keyStatus) {
    $('gate').hidden = false;
    $('app').hidden = true;
    if (keyStatus && keyStatus.state === 'invalid') {
      $('gateText').textContent = 'The API rejected your saved key' + (keyStatus.message ? ' (' + keyStatus.message + ')' : '') + '. Enter a new key to continue.';
    }
    BB.bindKeyForm($('gate').querySelector('form'), {
      docsUrl: state.status.docsUrl,
      onSaved: () => setTimeout(() => location.reload(), 600),
    });
    $('gateKey').focus();
  }

  async function showApp() {
    $('app').hidden = false;
    renderFooter();
    state.tabId = params.has('tabId') ? Number(params.get('tabId')) : null;
    if (state.tabId === null || isNaN(state.tabId) || state.tabId < 0) {
      const [tab] = await ext.tabs.query({ active: true, currentWindow: true });
      state.tabId = tab ? tab.id : null;
    }
    bindTabs();
    bindSite();
    bindWallets();
    bindLookup();
    bindReport();

    const view = params.get('view');
    if (view === 'lookup') {
      selectTab('lookup');
      if (params.get('q')) {
        $('lookupInput').value = params.get('q');
        runLookup();
      }
    } else if (view === 'report') {
      selectTab('report');
    }
    await loadTab();
  }

  function renderFooter() {
    const foot = $('foot');
    const spec = state.status.spec;
    foot.hidden = false;
    ui.clear(foot);
    if (!spec) return;
    const dot = h('span', { class: 'dot' + (spec.ok ? '' : ' bad') });
    const text = spec.ok ? 'Connected: ' + (spec.title || 'API') + (spec.version ? ' v' + spec.version : '') : 'API description unavailable: ' + spec.error;
    foot.append(dot, h('span', { class: 'grow', title: text, text }));
    if (!spec.ok) foot.append(h('button', { class: 'small', type: 'button', onclick: () => ext.runtime.openOptionsPage() }, 'Fix'));
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function bindTabs() {
    document.querySelectorAll('.tabs [role="tab"]').forEach((btn) => {
      btn.addEventListener('click', () => selectTab(btn.dataset.tab));
    });
  }

  function selectTab(name) {
    document.querySelectorAll('.tabs [role="tab"]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
    document.querySelectorAll('.pane').forEach((p) => (p.hidden = p.dataset.pane !== name));
    if (name === 'history') loadHistory();
    if (name === 'report' && !state.form) loadReportForm();
  }

  // ---------------------------------------------------------------------------
  // Site tab
  // ---------------------------------------------------------------------------

  async function loadTab() {
    const box = $('siteVerdict');
    if (state.tabId === null) {
      box.replaceChildren(ui.notice('', 'No active tab.'));
      return;
    }
    box.replaceChildren(ui.spinner('Checking this site…'));
    try {
      const res = await send('bb:getTabInfo', { tabId: state.tabId });
      if (!res.ok) throw new Error(res.error);
      state.info = res.info;
    } catch (err) {
      box.replaceChildren(ui.notice('error', err.message));
      return;
    }
    renderSite();
    renderWalletList();
    if (!state.form && !$('app').querySelector('[data-pane="report"]').hidden) loadReportForm();
  }

  function renderSite() {
    const info = state.info;
    const box = $('siteVerdict');
    if (!info.host) {
      box.replaceChildren(ui.notice('', 'BeaverBusters checks websites as you browse. This page is not a website it can check.'));
      $('siteActions').hidden = true;
      $('siteSubmittedCard').hidden = true;
      return;
    }
    const v = info.domain || { level: 'unknown', label: 'Not checked yet' };
    const card = v.level === 'skipped' ? ui.notice('', 'Not checked: ' + (v.reasons || []).join(', ')) : ui.verdictCard(v, info.host);
    box.replaceChildren(card);
    if (info.allowed && v.level === 'scam') box.append(h('div', { class: 'notice warn', style: 'margin-top:8px' }, 'You chose to continue to this site this session.'));
    $('siteActions').hidden = false;
    $('siteTrust').hidden = v.level === 'skipped';
    $('siteSubmittedCard').hidden = !state.status.features.submissionStatus;
  }

  function bindSite() {
    $('siteRecheck').addEventListener('click', async () => {
      if (!state.info || !state.info.host) return;
      $('siteVerdict').replaceChildren(ui.spinner('Rechecking…'));
      try {
        const res = await send('bb:checkDomain', { domain: state.info.host, url: state.info.url, force: true, tabId: state.tabId });
        if (!res.ok) throw new Error(res.error);
        state.info.domain = res.verdict;
        renderSite();
      } catch (err) {
        $('siteVerdict').replaceChildren(ui.notice('error', err.message));
      }
    });
    $('siteReport').addEventListener('click', () => {
      setReportKind('domain');
      selectTab('report');
    });
    $('siteTrust').addEventListener('click', async () => {
      if (!state.info || !state.info.host) return;
      if (!confirm('Never check ' + state.info.host + ' (and its subdomains)? You can undo this in Settings.')) return;
      await send('bb:trustDomain', { domain: state.info.host });
      state.info.domain = { level: 'skipped', label: 'Not checked', reasons: ['On your trusted list'] };
      renderSite();
    });
    $('siteSubmittedBtn').addEventListener('click', () => submittedCheck(state.info.host, $('siteSubmitted')));
  }

  async function submittedCheck(query, box) {
    box.replaceChildren(ui.spinner('Looking up submissions…'));
    try {
      const res = await send('bb:submissionStatus', { query });
      if (!res.ok) throw new Error(res.error);
      box.replaceChildren(renderSubmissions(res.result));
    } catch (err) {
      box.replaceChildren(ui.notice('error', err.message));
    }
  }

  function renderSubmissions(s) {
    if (!s) return ui.notice('', 'No submission data.');
    if (!s.ok) return ui.notice('error', s.error || 'Lookup failed.');
    const wrap = h('div', { class: 'stack', style: 'margin-top:8px' });
    wrap.append(s.found ? ui.notice('warn', 'Already submitted: ' + s.records.length + ' record' + (s.records.length === 1 ? '' : 's') + '.') : ui.notice('ok', 'No existing submissions found.'));
    if (s.found) wrap.append(ui.records(s.records));
    const raw = ui.raw(s.raw);
    if (raw) wrap.append(raw);
    return wrap;
  }

  // ---------------------------------------------------------------------------
  // Wallets tab
  // ---------------------------------------------------------------------------

  function bindWallets() {
    $('walletForm').addEventListener('submit', async (e) => {
      e.preventDefault();
      const value = $('walletInput').value.trim();
      const out = $('walletResult');
      const info = wallets.classifyAddress(value);
      if (!info) {
        out.replaceChildren(ui.notice('error', 'That does not look like a wallet address.'));
        return;
      }
      out.replaceChildren(ui.spinner('Checking wallet…'));
      try {
        const res = await send('bb:checkWallet', { address: info.address, force: true });
        if (!res.ok) throw new Error(res.error);
        out.replaceChildren(ui.verdictCard(res.verdict, info.address + ' · ' + info.label + (info.ambiguous ? ' (chain guessed)' : '')), walletTools(info.address));
      } catch (err) {
        out.replaceChildren(ui.notice('error', err.message));
      }
    });
    $('rescan').addEventListener('click', async () => {
      if (state.tabId === null) return;
      const list = $('walletList');
      list.replaceChildren(ui.spinner('Scanning page…'));
      try {
        const res = await send('bb:rescanTab', { tabId: state.tabId });
        if (!res.ok) throw new Error(res.error);
        const info = await send('bb:getTabInfo', { tabId: state.tabId });
        if (info.ok) state.info = info.info;
        renderWalletList();
      } catch (err) {
        list.replaceChildren(ui.notice('error', err.message));
      }
    });
  }

  function walletTools(address) {
    const box = h('div');
    const row = h(
      'div',
      { class: 'row', style: 'margin-top:8px' },
      h('button', { type: 'button', class: 'small', onclick: () => navigator.clipboard.writeText(address) }, 'Copy'),
      h('button', { type: 'button', class: 'small', onclick: () => reportWallet(address) }, 'Report'),
      state.status.features.submissionStatus ? h('button', { type: 'button', class: 'small', onclick: () => submittedCheck(address, box) }, 'Already reported?') : null
    );
    return h('div', null, row, box);
  }

  function reportWallet(address) {
    state.reportContext.address = address;
    setReportKind('wallet');
    selectTab('report');
  }

  function renderWalletList() {
    const list = $('walletList');
    const items = (state.info && state.info.wallets) || [];
    const flagged = items.filter((w) => w.verdict && (w.verdict.level === 'scam' || w.verdict.level === 'suspicious'));
    const count = $('walletCount');
    count.hidden = !items.length;
    count.textContent = String(flagged.length || items.length);
    count.className = 'count' + (flagged.length ? '' : ' ok');
    if (!items.length) {
      list.replaceChildren(ui.notice('', state.status.settings.autoWalletScan ? 'No wallet addresses found on this page.' : 'Automatic wallet scanning is off. Use Rescan to scan this page.'));
      return;
    }
    const order = { scam: 0, suspicious: 1, error: 2, unknown: 3, safe: 4 };
    items.sort((a, b) => (order[a.verdict && a.verdict.level] ?? 5) - (order[b.verdict && b.verdict.level] ?? 5));
    const ul = h('ul', { class: 'wallets' });
    for (const w of items) {
      const level = (w.verdict && w.verdict.level) || 'unknown';
      const li = h(
        'li',
        { class: 'wallet ' + level },
        h('div', { class: 'row' }, h('div', { class: 'grow addr', title: w.address, text: ui.middle(w.address, 12) }), ui.pill(level, w.verdict ? w.verdict.label : 'Not checked')),
        h('div', { class: 'hint', text: (w.label || w.chain || 'Wallet') + (w.ambiguous ? ' (chain guessed)' : '') + (w.verdict && w.verdict.error ? ' · ' + w.verdict.error : '') })
      );
      const tools = h('div', { class: 'tools' });
      const details = h('div');
      tools.append(
        h('button', {
          type: 'button',
          class: 'small',
          onclick: async () => {
            details.replaceChildren(ui.spinner());
            const res = await send('bb:checkWallet', { address: w.address, chain: w.ambiguous ? undefined : w.chain });
            details.replaceChildren(res.ok ? ui.verdictCard(res.verdict, w.address) : ui.notice('error', res.error));
          },
        }, 'Details'),
        h('button', { type: 'button', class: 'small', onclick: () => navigator.clipboard.writeText(w.address) }, 'Copy'),
        h('button', { type: 'button', class: 'small', onclick: () => reportWallet(w.address) }, 'Report')
      );
      li.append(tools, details);
      ul.append(li);
    }
    list.replaceChildren(ul);
  }

  // ---------------------------------------------------------------------------
  // Lookup tab
  // ---------------------------------------------------------------------------

  function bindLookup() {
    $('lookupForm').addEventListener('submit', (e) => {
      e.preventDefault();
      runLookup();
    });
    $('lookupInput').addEventListener('input', () => {
      const q = wallets.detectQuery($('lookupInput').value);
      const label = { wallet: 'Wallet address' + (q.label ? ' (' + q.label + ')' : ''), domain: 'Domain: ' + q.value, submission: 'Submission ID', unknown: 'Free-text query', empty: 'Checks the scam database and existing submissions.' }[q.kind];
      $('lookupHint').textContent = label;
    });
  }

  async function runLookup() {
    const query = $('lookupInput').value.trim();
    const out = $('lookupResult');
    if (!query) return;
    out.replaceChildren(ui.spinner('Looking up…'));
    try {
      const res = await send('bb:lookup', { query });
      if (!res.ok) throw new Error(res.error);
      const r = res.result;
      ui.clear(out);
      if (r.verdict) out.append(ui.verdictCard(r.verdict, r.query.value));
      else if (r.verdictError) out.append(ui.notice(r.query.kind === 'unknown' ? '' : 'error', r.verdictError));
      if (r.submissions) {
        out.append(h('h3', { class: 'sub', text: 'Submissions' }), renderSubmissions(r.submissions));
      }
      if (r.verdict && (r.query.kind === 'domain' || r.query.kind === 'wallet')) {
        out.append(
          h('div', { class: 'row' }, h('button', {
            type: 'button',
            onclick: () => {
              if (r.query.kind === 'wallet') reportWallet(r.query.value);
              else {
                state.reportContext.domain = r.query.value;
                state.reportContext.url = r.query.url || '';
                setReportKind('domain');
                selectTab('report');
              }
            },
          }, 'Report this ' + (r.query.kind === 'wallet' ? 'wallet' : 'site')))
        );
      }
    } catch (err) {
      out.replaceChildren(ui.notice('error', err.message));
    }
  }

  // ---------------------------------------------------------------------------
  // Report tab (form generated from the API's submission schema)
  // ---------------------------------------------------------------------------

  function bindReport() {
    document.querySelectorAll('input[name="kind"]').forEach((r) =>
      r.addEventListener('change', () => {
        state.reportKind = r.value;
        loadReportForm();
      })
    );
    if (params.get('view') === 'report') {
      const kind = params.get('kind') === 'wallet' ? 'wallet' : 'domain';
      if (kind === 'wallet') state.reportContext.address = params.get('value') || '';
      else {
        state.reportContext.domain = params.get('value') || '';
        state.reportContext.url = params.get('url') || '';
      }
      state.reportContext.pageUrl = params.get('page') || params.get('url') || '';
      setReportKind(kind, true);
    }
  }

  function setReportKind(kind, silent) {
    state.reportKind = kind;
    document.querySelectorAll('input[name="kind"]').forEach((r) => (r.checked = r.value === kind));
    state.form = null;
    if (!silent && !$('app').querySelector('[data-pane="report"]').hidden) loadReportForm();
  }

  function reportContext() {
    const c = Object.assign({}, state.reportContext);
    const info = state.info;
    if (state.reportKind === 'domain') {
      if (!c.domain && info && info.host) {
        c.domain = info.host;
        c.url = info.url;
      }
      if (!c.url && c.domain) c.url = 'https://' + c.domain + '/';
    } else {
      const addr = wallets.classifyAddress(c.address || '');
      if (addr) {
        c.address = addr.address;
        c.chainHint = addr.chain;
        if (!addr.ambiguous) c.chain = addr.chain;
      }
      if (!c.source && info && info.url) c.source = info.url;
    }
    if (!c.pageUrl && info && info.url) c.pageUrl = info.url;
    return c;
  }

  async function loadReportForm() {
    const form = $('reportForm');
    $('reportResult').replaceChildren();
    $('reportDuplicate').replaceChildren();
    form.replaceChildren(ui.spinner('Loading submission form…'));
    const ctx = reportContext();
    try {
      const res = await send('bb:getSubmitForm', { kind: state.reportKind, context: ctx });
      if (!res.ok) throw new Error(res.error);
      state.form = res.form;
      renderReportForm(res.form, ctx);
    } catch (err) {
      form.replaceChildren(ui.notice('error', err.message));
    }
  }

  function fieldControl(f) {
    const id = 'f_' + f.id.replace(/[^a-z0-9]/gi, '_');
    const val = f.value;
    let control;
    if (f.type === 'enum') {
      control = h('select', { id, name: f.id });
      if (!f.required || val === undefined) control.append(h('option', { value: '' }, f.required ? 'Choose…' : '—'));
      for (const o of f.options) control.append(h('option', { value: String(o), selected: val !== undefined && String(o) === String(val) }, String(o)));
    } else if (f.type === 'multienum') {
      control = h('div', { class: 'checks', id, 'data-multi': f.id });
      for (const o of f.options) control.append(h('label', null, h('input', { type: 'checkbox', value: String(o), checked: Array.isArray(val) && val.includes(o) }), String(o)));
    } else if (f.type === 'boolean') {
      return h('div', { class: 'field' }, h('label', { class: 'check-line' }, h('input', { type: 'checkbox', id, name: f.id, checked: !!val }), f.label), f.description ? h('div', { class: 'hint', text: f.description }) : null);
    } else if (f.type === 'text' || f.type === 'list' || f.type === 'json') {
      control = h('textarea', { id, name: f.id, class: f.type === 'json' ? 'mono-input' : '', placeholder: f.type === 'list' ? 'One per line' : f.type === 'json' ? '{ }' : '' });
      if (val !== undefined) control.value = Array.isArray(val) ? val.join('\n') : typeof val === 'object' ? JSON.stringify(val, null, 2) : String(val);
    } else {
      control = h('input', { id, name: f.id, type: f.type === 'number' ? 'number' : f.format === 'uri' || f.format === 'url' ? 'url' : 'text', spellcheck: 'false' });
      if (f.key === 'address') control.classList.add('mono-input');
      if (val !== undefined) control.value = String(val);
    }
    if (f.required) control.setAttribute('aria-required', 'true');
    return h('div', { class: 'field' }, h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null), control, f.description ? h('div', { class: 'hint', text: f.description }) : null);
  }

  function renderReportForm(form, ctx) {
    const el = $('reportForm');
    ui.clear(el);
    if (!form.available) {
      el.append(ui.notice('warn', form.error || 'Reporting is not available.'));
      return;
    }
    el.append(h('div', { class: 'hint op-hint', text: (form.op.summary || 'Submission') + ' · ' + form.op.id }));
    for (const f of form.fields) el.append(fieldControl(f));
    el.append(h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, 'Submit report')));
    el.onsubmit = (e) => {
      e.preventDefault();
      submitReport(form);
    };
    if (form.canCheckSubmitted) {
      const targetField = form.fields.find((f) => ['domain', 'url', 'address', 'value'].includes(f.key));
      const initial = state.reportKind === 'wallet' ? ctx.address : ctx.domain;
      if (initial) checkDuplicate(initial);
      if (targetField) {
        const input = el.querySelector('[name="' + CSS.escape(targetField.id) + '"]');
        let t;
        if (input) input.addEventListener('input', () => {
          clearTimeout(t);
          t = setTimeout(() => checkDuplicate(input.value.trim()), 700);
        });
      }
    }
  }

  async function checkDuplicate(target) {
    const box = $('reportDuplicate');
    if (!target) return box.replaceChildren();
    box.replaceChildren(ui.spinner('Checking whether this was already reported…'));
    try {
      const res = await send('bb:submissionStatus', { query: target });
      if (!res.ok) throw new Error(res.error);
      const s = res.result;
      if (!s.ok) box.replaceChildren(ui.notice('', 'Could not check for existing reports: ' + s.error));
      else if (s.found) {
        const statuses = Array.from(new Set(s.records.map((r) => r.status).filter(Boolean)));
        box.replaceChildren(ui.notice('warn', 'Already reported (' + s.records.length + ' record' + (s.records.length === 1 ? '' : 's') + (statuses.length ? ', status: ' + statuses.join(', ') : '') + '). You can still add a report with new evidence.'));
      } else box.replaceChildren(ui.notice('ok', 'No existing reports found.'));
    } catch (err) {
      box.replaceChildren(ui.notice('', 'Could not check for existing reports: ' + err.message));
    }
  }

  function collectValues(form) {
    const el = $('reportForm');
    const values = {};
    for (const f of form.fields) {
      if (f.type === 'multienum') {
        const box = el.querySelector('[data-multi="' + CSS.escape(f.id) + '"]');
        values[f.id] = Array.from(box.querySelectorAll('input:checked')).map((i) => i.value);
        if (!values[f.id].length) delete values[f.id];
        continue;
      }
      const input = el.querySelector('[name="' + CSS.escape(f.id) + '"]');
      if (!input) continue;
      if (f.type === 'boolean') values[f.id] = input.checked;
      else if (f.type === 'enum') {
        if (input.value === '') continue;
        const match = f.options.find((o) => String(o) === input.value);
        values[f.id] = match !== undefined ? match : input.value;
      } else values[f.id] = input.value;
    }
    return values;
  }

  async function submitReport(form) {
    const out = $('reportResult');
    const values = collectValues(form);
    const missing = form.fields.filter((f) => f.required && f.type !== 'boolean' && (values[f.id] === undefined || values[f.id] === '' || (Array.isArray(values[f.id]) && !values[f.id].length)));
    if (missing.length) {
      out.replaceChildren(ui.notice('error', 'Please fill in: ' + missing.map((f) => f.label).join(', ')));
      return;
    }
    const targetField = form.fields.find((f) => ['domain', 'url', 'address', 'value'].includes(f.key));
    let target = targetField ? String(values[targetField.id] || '') : '';
    if (targetField && targetField.key === 'url') target = wallets.normalizeDomain(target) || target;
    const btn = $('reportForm').querySelector('button[type="submit"]');
    btn.disabled = true;
    out.replaceChildren(ui.spinner('Submitting…'));
    try {
      const res = await send('bb:submit', { kind: state.reportKind, values, target });
      if (!res.ok) throw new Error(res.error);
      const r = res.result;
      if (r.ok) {
        out.replaceChildren(ui.notice('ok', 'Report submitted' + (r.id ? '. Submission ID: ' + r.id : '.') + ' Thank you.'), ui.raw(r.data) || '');
      } else {
        out.replaceChildren(ui.notice('error', 'The API did not accept the report: ' + r.error), ui.raw(r.data) || '');
      }
    } catch (err) {
      out.replaceChildren(ui.notice('error', err.message));
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------------------
  // History tab
  // ---------------------------------------------------------------------------

  async function loadHistory() {
    const server = $('historyServer');
    const local = $('historyLocal');
    server.replaceChildren(ui.spinner('Loading submissions…'));
    ui.clear(local);
    try {
      const res = await send('bb:listSubmissions');
      if (!res.ok) throw new Error(res.error);
      ui.clear(server);
      if (res.server) {
        server.append(h('h3', { class: 'sub', style: 'margin-top:0', text: 'Your submissions' }));
        server.append(res.server.ok ? ui.records(res.server.records, { empty: 'No submissions yet.', onStatus: res.canCheckStatus ? statusCheck : null }) : ui.notice('error', res.server.error));
      }
      const items = res.history.map((x) => ({ title: x.target || '(unknown)', status: x.status || '', date: x.at, id: x.id, kind: x.kind === 'wallet' ? 'Wallet' : 'Website' }));
      local.append(ui.records(items, { empty: 'Nothing submitted from this browser yet.', onStatus: res.canCheckStatus ? statusCheck : null }));
    } catch (err) {
      server.replaceChildren(ui.notice('error', err.message));
    }
  }

  async function statusCheck(record, li) {
    let box = li.querySelector('.status-box');
    if (!box) {
      box = h('div', { class: 'status-box' });
      li.append(box);
    }
    await submittedCheck(record.id, box);
  }

  boot();
})();
