(function () {
  'use strict';
  const BB = globalThis.BB;
  const { ext, send, ui } = BB;
  const { h } = ui;
  const $ = (id) => document.getElementById(id);

  let status = null;
  let settings = null;
  let toastTimer = null;

  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (t.hidden = true), 1800);
  }

  async function save(patch) {
    const res = await send('bb:saveSettings', { patch });
    if (!res.ok) throw new Error(res.error);
    settings = res.settings;
    return settings;
  }

  // ---------------------------------------------------------------------------
  // API key
  // ---------------------------------------------------------------------------

  function renderKeyState() {
    const ks = status.keyStatus;
    const el = $('keyState');
    ui.clear(el);
    if (!status.hasKey) el.append(ui.pill('unknown', 'Not set'));
    else if (ks && ks.state === 'invalid') el.append(ui.pill('scam', 'Rejected by API'));
    else if (ks && ks.state === 'unverified') el.append(ui.pill('suspicious', 'Saved, not verified'));
    else el.append(ui.pill('safe', 'Connected'));
    $('welcome').hidden = status.hasKey && location.hash !== '#welcome';
    $('removeKey').hidden = !status.hasKey;
    $('keyLabel').textContent = status.hasKey ? 'Replace API key' : 'API key';
    $('keyInput').placeholder = status.hasKey ? 'Enter a new key to replace the saved one' : 'Paste your key';
  }

  async function refreshStatus() {
    status = await send('bb:status');
    settings = status.settings;
    renderKeyState();
  }

  // Firefox can leave host permissions ungranted; checks and wallet scans need them.
  async function renderPermissions() {
    if (!ext.permissions || !ext.permissions.contains) return;
    const has = await ext.permissions.contains({ origins: ['<all_urls>'] });
    let box = $('permBox');
    if (has) {
      if (box) box.remove();
      return;
    }
    if (!box) {
      box = h(
        'div',
        { id: 'permBox', class: 'notice warn', style: 'margin-bottom:14px' },
        h('strong', null, 'Website access is needed. '),
        'BeaverBusters needs permission to read the address of the sites you visit and to contact the API. ',
        h('button', {
          type: 'button',
          class: 'small primary',
          onclick: async () => {
            await ext.permissions.request({ origins: ['<all_urls>'] });
            renderPermissions();
          },
        }, 'Grant access')
      );
      $('keySection').prepend(box);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function renderSettings() {
    document.querySelectorAll('[data-setting]').forEach((input) => {
      input.checked = !!settings[input.dataset.setting];
    });
    $('trusted').value = (settings.trustedDomains || []).join('\n');
    $('cacheMinutes').value = settings.cacheMinutes;
    $('baseUrl').value = settings.baseUrl;
    $('specUrl').value = settings.specUrl || '';
  }

  function bindSettings() {
    document.querySelectorAll('[data-setting]').forEach((input) => {
      input.addEventListener('change', async () => {
        // Firefox asks for consent before an extension sends page content anywhere.
        if (input.dataset.setting === 'serverWalletExtraction' && input.checked && BB.isFirefox) {
          let granted = true;
          try {
            granted = await ext.permissions.request({ data_collection: ['websiteContent'] });
          } catch (e) {
            granted = true; // browser without data-collection permissions
          }
          if (!granted) {
            input.checked = false;
            toast('Permission not granted');
            return;
          }
        }
        await save({ [input.dataset.setting]: input.checked });
        toast('Saved');
      });
    });
    $('saveTrusted').addEventListener('click', async () => {
      const list = $('trusted').value.split(/[\n,\s]+/).map((s) => s.trim()).filter(Boolean);
      const minutes = Math.min(1440, Math.max(1, Number($('cacheMinutes').value) || 30));
      await save({ trustedDomains: list, cacheMinutes: minutes });
      renderSettings();
      toast('Saved');
    });
    $('saveApi').addEventListener('click', async () => {
      const baseUrl = $('baseUrl').value.trim().replace(/\/+$/, '');
      const specUrl = $('specUrl').value.trim();
      for (const [name, v] of [['API base URL', baseUrl], ['OpenAPI URL', specUrl]]) {
        if (!v) continue;
        try {
          const u = new URL(v);
          if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error();
        } catch (e) {
          toast(name + ' is not a valid http(s) URL');
          return;
        }
      }
      if (!baseUrl) {
        toast('API base URL is required');
        return;
      }
      await save({ baseUrl, specUrl });
      toast('Saved');
      await loadSpecInfo(true);
    });
    $('reloadSpec').addEventListener('click', () => loadSpecInfo(true));
    $('importSpec').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const res = await send('bb:importSpec', { text: await file.text() });
        if (!res.ok) throw new Error(res.error);
        renderSpecInfo(res.info);
        toast('API description imported');
      } catch (err) {
        $('specStatus').replaceChildren(ui.notice('error', err.message));
      }
      e.target.value = '';
    });
    $('clearImport').addEventListener('click', async () => {
      const res = await send('bb:clearImportedSpec');
      if (res.ok) renderSpecInfo(res.info);
    });
    $('clearCache').addEventListener('click', async () => {
      await send('bb:clearCache');
      $('dataMsg').textContent = 'Cached results cleared.';
    });
    $('removeKey').addEventListener('click', async () => {
      if (!confirm('Remove the API key? Protection stops until a new key is saved.')) return;
      await send('bb:clearApiKey');
      await refreshStatus();
    });
  }

  // ---------------------------------------------------------------------------
  // API description + endpoint mapping
  // ---------------------------------------------------------------------------

  async function loadSpecInfo(force) {
    $('specStatus').replaceChildren(ui.spinner('Loading API description…'));
    try {
      const res = await send('bb:specInfo', { force: !!force });
      if (!res.ok) throw new Error(res.error);
      renderSpecInfo(res.info);
    } catch (err) {
      $('specStatus').replaceChildren(ui.notice('error', err.message));
    }
  }

  function renderSpecInfo(info) {
    const box = $('specStatus');
    ui.clear(box);
    $('clearImport').hidden = info.source !== 'imported';
    if (info.error) {
      box.append(ui.notice('error', 'Could not load the API description from ' + info.specUrl + ': ' + info.error));
      box.append(h('div', { class: 'hint' }, 'Check the URL and your network connection. If the server does not publish its description, download openapi.json and use "Import from file".'));
    } else {
      const sourceText = { network: 'downloaded', cache: 'cached', 'stale-cache': 'cached (refresh failed)', imported: 'imported from file' }[info.source] || info.source;
      box.append(
        ui.notice('ok', 'Loaded ' + (info.info.title || 'API') + (info.info.version ? ' v' + info.info.version : '') + ': ' + info.operations.length + ' endpoints, ' + sourceText + (info.fetchedAt ? ' ' + ui.fmtDate(info.fetchedAt) : '') + '.')
      );
      if (info.warning) box.append(ui.notice('warn', 'Refresh failed: ' + info.warning));
      box.append(ui.kv([{ key: 'Requests go to', value: info.base }, { key: 'Authentication', value: info.auth.length ? info.auth.join('; ') : 'Not declared (sending X-API-Key and Bearer headers)' }]));
    }
    renderMapping(info);
    const extract = info.features.find((f) => f.name === 'extractWallets');
    $('extractHint').textContent =
      'Send page text to the API to find addresses (the page text leaves your browser). ' +
      (extract && extract.op ? 'Uses ' + extract.op + '.' : 'Not available: the API description has no extraction endpoint, so addresses are found locally.');
  }

  function renderMapping(info) {
    const box = $('mapping');
    ui.clear(box);
    if (!info.operations.length) {
      box.append(ui.notice('', 'Load the API description to see endpoints.'));
      return;
    }
    const overrides = settings.endpointOverrides || {};
    const table = h('table', { class: 'map' });
    const tbody = h('tbody');
    table.append(tbody);
    for (const f of info.features) {
      const select = h('select', { 'aria-label': f.label });
      const autoText = f.auto && f.op ? 'Automatic: ' + f.op : f.candidates.length ? 'Automatic: ' + f.candidates[0] : 'Automatic: no match';
      select.append(h('option', { value: 'auto' }, autoText), h('option', { value: 'none' }, 'Disabled'));
      for (const op of info.operations) select.append(h('option', { value: op.id }, op.id + (op.summary ? ': ' + op.summary : '')));
      select.value = overrides[f.name] ? overrides[f.name] : 'auto';
      select.addEventListener('change', async () => {
        const next = Object.assign({}, settings.endpointOverrides || {});
        if (select.value === 'auto') delete next[f.name];
        else next[f.name] = select.value;
        await save({ endpointOverrides: next });
        toast('Mapping saved');
        loadSpecInfo(false);
      });
      const status = f.op ? h('div', { class: 'hint', text: 'Using ' + f.op }) : h('div', { class: 'hint', text: f.auto ? 'Not available in this API' : 'Disabled' });
      tbody.append(h('tr', null, h('th', null, f.label, status), h('td', null, select)));
    }
    box.append(table);
  }

  // ---------------------------------------------------------------------------

  async function boot() {
    await refreshStatus();
    BB.bindKeyForm($('keySection').querySelector('form'), {
      docsUrl: status.docsUrl,
      onSaved: async () => {
        await refreshStatus();
        loadSpecInfo(false);
        renderPermissions();
      },
    });
    renderSettings();
    bindSettings();
    renderPermissions();
    if (!status.hasKey) $('keyInput').focus();
    loadSpecInfo(false);
  }

  boot();
})();
