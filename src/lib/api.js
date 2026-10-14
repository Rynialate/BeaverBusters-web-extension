/*
 * API client (background only).
 *
 * Loads the server's OpenAPI document, resolves features to endpoints and
 * performs authenticated requests. Results of domain / wallet checks are
 * cached so live checking does not hit the server on every navigation.
 */
(function (root) {
  'use strict';
  const BB = root.BB;
  const { ext, config, store, openapi, verdict, wallets } = BB;

  let specState = null;
  let specLoading = null;
  const inflight = new Map();
  let cache = null; // Map<key, {v, exp}>
  let cacheSaveTimer = null;
  let rateLimitedUntil = 0;

  class ApiError extends Error {
    constructor(code, message, extra) {
      super(message);
      this.code = code;
      Object.assign(this, extra || {});
    }
  }

  function specUrlFor(settings) {
    if (settings.specUrl) return settings.specUrl;
    return String(settings.baseUrl || config.DEFAULT_BASE_URL).replace(/\/+$/, '') + '/' + config.SPEC_FILE;
  }

  async function fetchJson(url, init, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || config.REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(url, Object.assign({}, init, { signal: ctrl.signal, credentials: 'omit', cache: 'no-store' }));
      const text = await res.text();
      let data = text;
      if (text && (/json/i.test(res.headers.get('content-type') || '') || /^\s*[[{]/.test(text))) {
        try {
          data = JSON.parse(text);
        } catch (e) {
          /* keep text */
        }
      }
      return { ok: res.ok, status: res.status, statusText: res.statusText, data, retryAfter: res.headers.get('retry-after') };
    } catch (err) {
      if (err && err.name === 'AbortError') throw new ApiError('NETWORK', 'The API did not respond in time.');
      throw new ApiError('NETWORK', 'Could not reach the API (' + ((err && err.message) || err) + ').');
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Spec
  // ---------------------------------------------------------------------------

  async function downloadSpec(url, apiKey) {
    let res = await fetchJson(url, { headers: { Accept: 'application/json' } });
    if ((res.status === 401 || res.status === 403) && apiKey) {
      res = await fetchJson(url, { headers: { Accept: 'application/json', 'X-API-Key': apiKey, Authorization: 'Bearer ' + apiKey } });
    }
    if (!res.ok) throw new ApiError('SPEC_UNAVAILABLE', verdict.errorMessage(res.data, res.status, res.statusText));
    if (!res.data || typeof res.data !== 'object' || !res.data.paths) throw new ApiError('SPEC_UNAVAILABLE', 'Response is not an OpenAPI document.');
    return res.data;
  }

  function buildState(spec, specUrl, source, at, settings) {
    const ops = openapi.listOperations(spec);
    return {
      spec,
      specUrl,
      source,
      fetchedAt: at,
      base: openapi.serverBase(spec, specUrl),
      ops,
      features: openapi.resolveFeatures(spec, settings.endpointOverrides || {}),
      info: { title: (spec.info && spec.info.title) || '', version: (spec.info && spec.info.version) || '', openapi: spec.openapi || spec.swagger || '' },
      auth: openapi.describeAuth(spec),
      error: null,
    };
  }

  async function loadSpecUncached(force, apiKeyOverride) {
    const settings = await store.getSettings();
    const specUrl = specUrlFor(settings);
    const { importedSpec, specCache } = await ext.storage.local.get(['importedSpec', 'specCache']);
    if (importedSpec && importedSpec.spec) return buildState(importedSpec.spec, specUrl, 'imported', importedSpec.at, settings);
    const cachedOk = specCache && specCache.url === specUrl && specCache.spec;
    if (!force && cachedOk && Date.now() - specCache.at < config.SPEC_MAX_AGE_MS) return buildState(specCache.spec, specUrl, 'cache', specCache.at, settings);
    try {
      const spec = await downloadSpec(specUrl, apiKeyOverride || (await store.getApiKey()));
      await ext.storage.local.set({ specCache: { url: specUrl, at: Date.now(), spec } });
      return buildState(spec, specUrl, 'network', Date.now(), settings);
    } catch (err) {
      if (cachedOk) {
        const st = buildState(specCache.spec, specUrl, 'stale-cache', specCache.at, settings);
        st.warning = err.message;
        return st;
      }
      return { error: err.message, specUrl, ops: [], features: {}, failedAt: Date.now() };
    }
  }

  /** Load (or reuse) the resolved spec. Failed loads are retried after a minute. */
  async function loadSpec(opts) {
    const force = !!(opts && opts.force);
    if (!force && specState && !(specState.error && Date.now() - specState.failedAt > 60000)) return specState;
    if (!specLoading) {
      specLoading = loadSpecUncached(force, opts && opts.apiKey).finally(() => {
        specLoading = null;
      });
    }
    specState = await specLoading;
    return specState;
  }

  function invalidateSpec() {
    specState = null;
  }

  async function importSpec(text) {
    let spec;
    try {
      spec = typeof text === 'string' ? JSON.parse(text) : text;
    } catch (e) {
      throw new ApiError('BAD_SPEC', 'That file is not valid JSON.');
    }
    if (!spec || !spec.paths) throw new ApiError('BAD_SPEC', 'That JSON is not an OpenAPI document (no "paths").');
    await ext.storage.local.set({ importedSpec: { spec, at: Date.now() } });
    invalidateSpec();
    return loadSpec();
  }

  async function clearImportedSpec() {
    await ext.storage.local.remove('importedSpec');
    invalidateSpec();
  }

  // ---------------------------------------------------------------------------
  // Requests
  // ---------------------------------------------------------------------------

  async function execute(st, op, request, apiKey, opts) {
    if (Date.now() < rateLimitedUntil) {
      throw new ApiError('RATE_LIMITED', 'Rate limited by the API. Retrying in ' + Math.ceil((rateLimitedUntil - Date.now()) / 1000) + 's.');
    }
    openapi.applyAuth(st.spec, op, request, apiKey);
    const { url, init } = openapi.toFetch(st.base, request);
    const res = await fetchJson(url, init);
    const verifying = opts && opts.verifying;
    if (res.status === 401) {
      const msg = verdict.errorMessage(res.data, res.status, res.statusText);
      if (!verifying) await store.setKeyStatus('invalid', msg);
      throw new ApiError('AUTH', 'The API rejected the API key (' + msg + ').', { status: 401 });
    }
    if (res.status === 429) {
      const secs = Number(res.retryAfter) > 0 ? Number(res.retryAfter) : 30;
      rateLimitedUntil = Date.now() + Math.min(secs, 600) * 1000;
      throw new ApiError('RATE_LIMITED', 'Rate limited by the API. Retrying in ' + secs + 's.', { status: 429 });
    }
    if (res.ok && !verifying) {
      const ks = await store.getKeyStatus();
      if (ks && ks.state !== 'ok') await store.setKeyStatus('ok');
    }
    return {
      ok: res.ok,
      status: res.status,
      data: res.data,
      op: op.id,
      error: res.ok ? null : verdict.errorMessage(res.data, res.status, res.statusText),
    };
  }

  async function requireKey() {
    const apiKey = await store.getApiKey();
    if (!apiKey) throw new ApiError('NO_API_KEY', 'An API key is required. Add one in the extension options.');
    return apiKey;
  }

  async function featureOp(feature) {
    const st = await loadSpec();
    if (st.error) throw new ApiError('SPEC_UNAVAILABLE', 'Could not load the API description from ' + st.specUrl + ' (' + st.error + ').');
    const f = st.features[feature];
    if (!f || !f.op) {
      throw new ApiError('NOT_SUPPORTED', 'The API does not expose a "' + openapi.FEATURES[feature].label + '" endpoint. You can map one in Options → Endpoint mapping.');
    }
    return { st, op: f.op };
  }

  /** The mapped operation first, then (in automatic mode) the runner-up candidates. */
  function opsFor(st, feature) {
    const f = st.features[feature];
    const list = f && f.op ? [f.op] : [];
    if (f && f.auto) {
      for (const id of f.candidates) {
        const op = st.ops.find((o) => o.id === id);
        if (op && !list.some((x) => x.id === op.id)) list.push(op);
      }
    }
    return list;
  }

  async function call(feature, input, primary) {
    const apiKey = await requireKey();
    const { st } = await featureOp(feature);
    // e.g. a status lookup by domain skips GET /submissions/{id} and uses a search endpoint instead
    let first = null;
    for (const op of opsFor(st, feature)) {
      const { request, missing } = openapi.buildRequest(op, input, primary);
      if (!missing.length) return execute(st, op, request, apiKey);
      if (!first) first = { op, missing };
    }
    throw new ApiError('MISSING_INPUT', first.op.id + ' needs ' + first.missing.join(', ') + ', which this lookup cannot provide.');
  }

  async function hasFeature(feature) {
    const st = await loadSpec();
    return !!(st && !st.error && st.features[feature] && st.features[feature].op);
  }

  // ---------------------------------------------------------------------------
  // Verdict cache
  // ---------------------------------------------------------------------------

  async function loadCache() {
    if (cache) return cache;
    const { verdictCache } = await ext.storage.local.get('verdictCache');
    cache = new Map(Object.entries(verdictCache || {}));
    return cache;
  }

  function scheduleCacheSave() {
    if (cacheSaveTimer) return;
    cacheSaveTimer = setTimeout(async () => {
      cacheSaveTimer = null;
      const now = Date.now();
      const entries = Array.from(cache.entries()).filter(([, e]) => e.exp > now);
      const trimmed = entries.slice(-config.MAX_CACHE_ENTRIES);
      cache = new Map(trimmed);
      await ext.storage.local.set({ verdictCache: Object.fromEntries(trimmed) });
    }, 2000);
  }

  function slimVerdict(v) {
    try {
      if (JSON.stringify(v.raw || null).length > 20000) return Object.assign({}, v, { raw: '(response too large to store)' });
    } catch (e) {
      return Object.assign({}, v, { raw: null });
    }
    return v;
  }

  async function cached(key, force, producer) {
    const c = await loadCache();
    const hit = c.get(key);
    if (!force && hit && hit.exp > Date.now()) return Object.assign({ cached: true }, hit.v);
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      const settings = await store.getSettings();
      const v = await producer();
      const ttl = v.level === 'error' ? 60 * 1000 : Math.max(1, Number(settings.cacheMinutes) || 30) * 60 * 1000;
      c.delete(key);
      c.set(key, { v: slimVerdict(v), exp: Date.now() + ttl });
      scheduleCacheSave();
      return v;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function peekCache(key) {
    const c = await loadCache();
    const hit = c.get(key);
    return hit && hit.exp > Date.now() ? hit.v : null;
  }

  async function clearCache() {
    cache = new Map();
    await ext.storage.local.remove('verdictCache');
  }

  function toVerdict(res) {
    if (!res.ok && res.status !== 404) {
      return { level: 'error', label: verdict.LABELS.error, error: res.error, httpStatus: res.status, raw: res.data, op: res.op, reasons: [], fields: [], checkedAt: Date.now() };
    }
    const v = verdict.normalizeVerdict(res.data, res.status);
    v.op = res.op;
    v.checkedAt = Date.now();
    return v;
  }

  function walletKey(address, chain) {
    return 'w:' + (chain === 'evm' || /^0x/i.test(address) ? address.toLowerCase() : address);
  }

  // ---------------------------------------------------------------------------
  // Features
  // ---------------------------------------------------------------------------

  async function checkDomain(domain, opts) {
    const o = opts || {};
    return cached('d:' + domain, o.force, async () => {
      const settings = await store.getSettings();
      const url = settings.sendFullUrl && o.url ? o.url : 'https://' + domain + '/';
      return toVerdict(await call('checkDomain', { domain, url, kind: 'domain', value: domain }, 'domain'));
    });
  }

  function walletInput(w) {
    const info = wallets.classifyAddress(w.address);
    const chain = w.chain || (info && info.chain) || '';
    const ambiguous = w.ambiguous !== undefined ? w.ambiguous : !!(info && info.ambiguous);
    return { address: w.address, chain: ambiguous ? undefined : chain || undefined, chainHint: chain || undefined, kind: 'wallet', value: w.address };
  }

  async function checkWallet(w, opts) {
    const o = opts || {};
    return cached(walletKey(w.address, w.chain), o.force, async () => toVerdict(await call('checkWallet', walletInput(w), 'address')));
  }

  /** Check many wallets, using a batch endpoint when the API has one. */
  async function checkWallets(list, opts) {
    const results = new Map();
    const misses = [];
    for (const w of list) {
      const hit = !(opts && opts.force) && (await peekCache(walletKey(w.address, w.chain)));
      if (hit) results.set(w.address, Object.assign({ cached: true }, hit));
      else misses.push(w);
    }
    if (misses.length > 1 && (await hasFeature('checkWalletsBatch'))) {
      try {
        const res = await call('checkWalletsBatch', { addresses: misses.map((w) => w.address), kind: 'wallet' }, 'addresses');
        if (res.ok) {
          const byAddr = batchRecords(res.data);
          const c = await loadCache();
          const settings = await store.getSettings();
          for (const w of misses) {
            const rec = byAddr.get(w.address.toLowerCase());
            const v = rec !== undefined ? verdict.normalizeVerdict(rec, 200) : verdict.normalizeVerdict(null, 404);
            v.op = res.op;
            v.checkedAt = Date.now();
            results.set(w.address, v);
            c.set(walletKey(w.address, w.chain), { v: slimVerdict(v), exp: Date.now() + (Number(settings.cacheMinutes) || 30) * 60000 });
          }
          scheduleCacheSave();
          return results;
        }
      } catch (err) {
        if (err.code === 'AUTH' || err.code === 'RATE_LIMITED' || err.code === 'NO_API_KEY') throw err;
        // fall back to individual checks
      }
    }
    let index = 0;
    async function worker() {
      while (index < misses.length) {
        const w = misses[index++];
        try {
          results.set(w.address, await checkWallet(w, opts));
        } catch (err) {
          if (err.code === 'AUTH' || err.code === 'NO_API_KEY') throw err;
          results.set(w.address, { level: 'error', label: verdict.LABELS.error, error: err.message, reasons: [], fields: [] });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(config.WALLET_CHECK_CONCURRENCY, misses.length) }, worker));
    return results;
  }

  function batchRecords(data) {
    const map = new Map();
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      // {"0xabc": {...}, "0xdef": {...}}
      for (const [k, v] of Object.entries(data)) if (wallets.classifyAddress(k)) map.set(k.toLowerCase(), v);
      if (map.size) return map;
    }
    for (const item of verdict.extractAddresses(data)) map.set(item.address.toLowerCase(), item.record !== undefined ? item.record : item);
    return map;
  }

  /** Server-side wallet extraction from page text (only used when enabled in settings). */
  async function extractWallets(text, url) {
    const res = await call('extractWallets', { text, url, value: text }, 'text');
    if (!res.ok) throw new ApiError('HTTP', res.error || 'Extraction failed');
    return verdict.extractAddresses(res.data).map((x) => {
      const info = wallets.classifyAddress(x.address);
      return { address: x.address, chain: x.chain || (info && info.chain) || '', label: (info && info.label) || x.chain || 'Wallet', ambiguous: !x.chain && !!(info && info.ambiguous) };
    });
  }

  function lookupInput(q) {
    if (q.kind === 'wallet') return { input: Object.assign(walletInput({ address: q.value, chain: q.chain }), {}), primary: 'address' };
    if (q.kind === 'domain') return { input: { domain: q.value, url: q.url || 'https://' + q.value + '/', kind: 'domain', value: q.value }, primary: 'domain' };
    if (q.kind === 'submission') return { input: { id: q.value, value: q.value }, primary: 'id' };
    return { input: { value: q.value }, primary: 'value' };
  }

  /** "Has this already been submitted?" / submission status lookup. */
  async function submissionStatus(query) {
    const q = typeof query === 'string' ? wallets.detectQuery(query) : query;
    const { input, primary } = lookupInput(q);
    const res = await call('submissionStatus', input, primary);
    if (res.status === 404) return { ok: true, found: false, records: [], op: res.op, raw: res.data };
    if (!res.ok) return { ok: false, error: res.error, status: res.status, op: res.op, raw: res.data };
    const records = verdict.submissionRecords(res.data).map(verdict.describeRecord);
    return { ok: true, found: records.length > 0, records, op: res.op, raw: res.data };
  }

  async function listSubmissions() {
    const res = await call('listSubmissions', {}, 'value');
    if (!res.ok) return { ok: false, error: res.error, status: res.status, op: res.op };
    return { ok: true, records: verdict.extractList(res.data).map(verdict.describeRecord), op: res.op, raw: res.data };
  }

  async function getSubmitForm(kind, context) {
    const feature = kind === 'wallet' ? 'submitWallet' : 'submitDomain';
    const st = await loadSpec();
    if (st.error) return { available: false, error: 'Could not load the API description (' + st.error + ').' };
    const f = st.features[feature];
    if (!f || !f.op) return { available: false, error: 'The API does not expose an endpoint for reporting a ' + (kind === 'wallet' ? 'wallet' : 'website') + '.' };
    return {
      available: true,
      op: { id: f.op.id, summary: f.op.summary, description: f.op.description },
      fields: openapi.describeForm(f.op, Object.assign({ kind }, context || {})),
      canCheckSubmitted: !!(st.features.submissionStatus && st.features.submissionStatus.op),
    };
  }

  async function submit(kind, values, target) {
    const apiKey = await requireKey();
    const { st, op } = await featureOp(kind === 'wallet' ? 'submitWallet' : 'submitDomain');
    const { request, missing } = openapi.buildRequestFromValues(op, values || {});
    if (missing.length) throw new ApiError('MISSING_INPUT', 'Please fill in: ' + missing.join(', '));
    const res = await execute(st, op, request, apiKey);
    const id = res.ok ? verdict.extractId(res.data) : null;
    if (res.ok) {
      await store.addHistory({ id, kind, target: target || '', op: op.id, status: (verdict.describeRecord(verdict.unwrap(res.data)) || {}).status || '' });
      const c = await loadCache();
      if (target) {
        c.delete('d:' + target);
        c.delete(walletKey(target, ''));
      }
    }
    return { ok: res.ok, status: res.status, id, error: res.error, data: res.data, op: res.op };
  }

  /**
   * Check that a key is accepted. Returns {valid: true|false|null, message}.
   * null means the key could not be verified either way (e.g. network error).
   */
  async function verifyKey(apiKey) {
    const st = await loadSpec({ force: true, apiKey });
    if (st.error) return { valid: null, message: 'Could not load the API description from ' + st.specUrl + ': ' + st.error };
    const attempts = [];
    if (st.features.verifyKey && st.features.verifyKey.op) attempts.push({ op: st.features.verifyKey.op, input: {}, primary: 'value' });
    if (st.features.checkDomain && st.features.checkDomain.op) attempts.push({ op: st.features.checkDomain.op, input: { domain: 'example.com', url: 'https://example.com/', value: 'example.com', kind: 'domain' }, primary: 'domain' });
    if (!attempts.length) return { valid: null, message: 'The API description has no endpoint that can be used to verify the key.' };
    let lastMessage = '';
    for (const a of attempts) {
      const { request, missing } = openapi.buildRequest(a.op, a.input, a.primary);
      if (missing.length) continue;
      try {
        const res = await execute(st, a.op, request, apiKey, { verifying: true });
        if (res.status === 403) return { valid: false, message: 'The API refused this key (' + res.error + ').' };
        if (res.ok || res.status === 404) return { valid: true, message: 'Key accepted by ' + a.op.id };
        lastMessage = a.op.id + ' answered ' + res.status + ' (' + res.error + ')';
      } catch (err) {
        if (err.code === 'AUTH') return { valid: false, message: err.message };
        lastMessage = err.message;
      }
    }
    return { valid: null, message: lastMessage || 'Could not verify the key.' };
  }

  async function getSpecInfo(force) {
    const st = await loadSpec({ force: !!force });
    const features = Object.keys(openapi.FEATURES).map((name) => {
      const f = st.features && st.features[name];
      return { name, label: openapi.FEATURES[name].label, op: f && f.op ? f.op.id : null, auto: f ? f.auto : true, candidates: f ? f.candidates : [] };
    });
    return {
      error: st.error || null,
      warning: st.warning || null,
      specUrl: st.specUrl,
      base: st.base || '',
      source: st.source || '',
      fetchedAt: st.fetchedAt || st.failedAt || null,
      info: st.info || null,
      auth: st.auth || [],
      operations: (st.ops || []).map((o) => ({ id: o.id, summary: o.summary })),
      features,
    };
  }

  function apiHost() {
    if (specState && specState.base) {
      try {
        return new URL(specState.base).hostname;
      } catch (e) {
        /* ignore */
      }
    }
    try {
      return new URL(config.DEFAULT_BASE_URL).hostname;
    } catch (e) {
      return '';
    }
  }

  BB.api = {
    ApiError,
    loadSpec,
    invalidateSpec,
    importSpec,
    clearImportedSpec,
    hasFeature,
    checkDomain,
    checkWallet,
    checkWallets,
    extractWallets,
    submissionStatus,
    listSubmissions,
    getSubmitForm,
    submit,
    verifyKey,
    getSpecInfo,
    peekDomain: (domain) => peekCache('d:' + domain),
    clearCache,
    apiHost,
  };
})(globalThis);
