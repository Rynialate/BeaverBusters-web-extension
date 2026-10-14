/*
 * OpenAPI-driven request planning.
 *
 * The extension does not hard-code endpoint paths. It reads the server's
 * OpenAPI document at runtime, scores each operation against the features the
 * extension needs (domain check, wallet check, submit, submission status, ...),
 * and builds requests from the operation's declared parameters, request body
 * schema and security scheme. Users can override any mapping in the options.
 *
 * This file is pure (no browser APIs) so it can be unit tested in Node.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.BB = root.BB || {};
  root.BB.openapi = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  const STOP = new Set(['api', 'v1', 'v2', 'v3', 'v4', 'the', 'a', 'an', 'of', 'for', 'to', 'and', 'or', 'by', 'in', 'on', 'with', 'from', 'get', 'post', 'put', 'patch', 'delete', 'endpoint', 'route', 'handler']);

  // ---------------------------------------------------------------------------
  // Spec traversal
  // ---------------------------------------------------------------------------

  function splitWords(str) {
    if (!str) return [];
    return String(str)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t && !STOP.has(t));
  }

  function normName(name) {
    return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function deref(spec, obj, depth) {
    let cur = obj;
    let n = depth || 0;
    while (cur && typeof cur === 'object' && typeof cur.$ref === 'string' && n < 20) {
      const ref = cur.$ref;
      if (!ref.startsWith('#/')) return {};
      let node = spec;
      for (const raw of ref.slice(2).split('/')) {
        const key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
        node = node && typeof node === 'object' ? node[key] : undefined;
      }
      cur = node;
      n++;
    }
    return cur;
  }

  const MERGE_KEYS = ['title', 'description', 'default', 'example', 'format', 'maxLength', 'minLength', 'pattern', 'readOnly', 'writeOnly', 'nullable', 'deprecated'];

  /**
   * Resolve $ref/allOf/anyOf/oneOf into a single flattened schema that is easy
   * to reason about. Handles Pydantic-style `anyOf: [X, {type: null}]`.
   */
  function resolveSchema(spec, schema, depth) {
    const d = depth || 0;
    if (!schema || typeof schema !== 'object') return {};
    if (d > 10) return {};

    if (schema.$ref) {
      const target = resolveSchema(spec, deref(spec, schema), d + 1);
      const own = Object.assign({}, schema);
      delete own.$ref;
      return Object.assign({}, target, pick(own, MERGE_KEYS));
    }

    let out = Object.assign({}, schema);

    if (Array.isArray(schema.allOf)) {
      delete out.allOf;
      const merged = { properties: {}, required: [] };
      for (const part of schema.allOf) {
        const r = resolveSchema(spec, part, d + 1);
        Object.assign(merged, pick(r, ['type', 'enum', 'items', 'format', 'title', 'description', 'default']));
        if (r.properties) Object.assign(merged.properties, r.properties);
        if (Array.isArray(r.required)) merged.required.push(...r.required);
      }
      if (!Object.keys(merged.properties).length) delete merged.properties;
      if (!merged.required.length) delete merged.required;
      out = Object.assign(merged, out);
      if (merged.properties && schema.properties) out.properties = Object.assign({}, merged.properties, schema.properties);
    }

    const variants = schema.anyOf || schema.oneOf;
    if (Array.isArray(variants)) {
      delete out.anyOf;
      delete out.oneOf;
      const resolved = variants.map((v) => resolveSchema(spec, v, d + 1));
      const nonNull = resolved.filter((v) => v.type !== 'null');
      if (nonNull.length < resolved.length) out.nullable = true;
      if (nonNull.length === 1) {
        out = Object.assign({}, nonNull[0], pick(out, MERGE_KEYS), { nullable: out.nullable });
      } else if (nonNull.length > 1 && nonNull.every((v) => Array.isArray(v.enum) || v.const !== undefined)) {
        out.enum = [].concat(...nonNull.map((v) => v.enum || [v.const]));
        out.type = out.type || nonNull[0].type || 'string';
      } else if (nonNull.length > 1) {
        const objectish = nonNull.find((v) => v.type === 'object' || v.properties);
        const stringish = nonNull.find((v) => v.type === 'string');
        out = Object.assign({}, objectish || stringish || nonNull[0], pick(out, MERGE_KEYS));
      }
    }

    if (Array.isArray(out.type)) {
      const t = out.type.filter((x) => x !== 'null');
      if (t.length < out.type.length) out.nullable = true;
      out.type = t[0] || 'string';
    }
    if (out.const !== undefined && !out.enum) out.enum = [out.const];
    if (!out.type) {
      if (out.properties) out.type = 'object';
      else if (out.items) out.type = 'array';
      else if (Array.isArray(out.enum) && out.enum.length) out.type = typeof out.enum[0] === 'number' ? 'number' : 'string';
    }
    if (out.items) out.items = resolveSchema(spec, out.items, d + 1);
    if (out.properties && d < 6) {
      const props = {};
      for (const k of Object.keys(out.properties)) props[k] = resolveSchema(spec, out.properties[k], d + 1);
      out.properties = props;
    }
    return out;
  }

  function pick(obj, keys) {
    const out = {};
    for (const k of keys) if (obj && obj[k] !== undefined) out[k] = obj[k];
    return out;
  }

  function pickContentType(content) {
    const types = Object.keys(content || {});
    return (
      types.find((t) => t === 'application/json') ||
      types.find((t) => /\+json$|\/json/.test(t)) ||
      types.find((t) => t === 'application/x-www-form-urlencoded') ||
      types.find((t) => t === 'multipart/form-data') ||
      types[0] ||
      null
    );
  }

  /** Flatten a spec (OpenAPI 3.x or Swagger 2.0) into a list of normalised operations. */
  function listOperations(spec) {
    const ops = [];
    const paths = (spec && spec.paths) || {};
    for (const path of Object.keys(paths)) {
      const item = deref(spec, paths[path]) || {};
      const shared = item.parameters || [];
      for (const method of HTTP_METHODS) {
        const raw = item[method];
        if (!raw || typeof raw !== 'object') continue;

        const byKey = new Map();
        for (const p of shared.concat(raw.parameters || [])) {
          const param = deref(spec, p);
          if (param && param.name) byKey.set(param.in + ':' + param.name, param);
        }
        const allParams = Array.from(byKey.values());

        let requestBody = null;
        if (raw.requestBody) {
          const rb = deref(spec, raw.requestBody) || {};
          const ct = pickContentType(rb.content);
          if (ct) requestBody = { contentType: ct, schema: resolveSchema(spec, rb.content[ct].schema), required: !!rb.required };
        }
        // Swagger 2.0 body / formData parameters
        const bodyParam = allParams.find((p) => p.in === 'body');
        if (bodyParam && !requestBody) {
          requestBody = { contentType: 'application/json', schema: resolveSchema(spec, bodyParam.schema), required: !!bodyParam.required };
        }
        const formParams = allParams.filter((p) => p.in === 'formData');
        if (formParams.length && !requestBody) {
          const properties = {};
          for (const p of formParams) properties[p.name] = resolveSchema(spec, p.schema || { type: p.type, enum: p.enum, items: p.items, description: p.description });
          requestBody = {
            contentType: (raw.consumes || []).includes('multipart/form-data') ? 'multipart/form-data' : 'application/x-www-form-urlencoded',
            schema: { type: 'object', properties, required: formParams.filter((p) => p.required).map((p) => p.name) },
            required: true,
          };
        }

        const parameters = allParams
          .filter((p) => p.in === 'path' || p.in === 'query' || p.in === 'header')
          .map((p) => ({
            name: p.name,
            in: p.in,
            required: p.in === 'path' ? true : !!p.required,
            description: p.description || '',
            schema: resolveSchema(spec, p.schema || { type: p.type || 'string', enum: p.enum, items: p.items, default: p.default }),
          }));

        ops.push({
          id: method.toUpperCase() + ' ' + path,
          method,
          path,
          operationId: raw.operationId || '',
          summary: raw.summary || '',
          description: raw.description || '',
          tags: raw.tags || [],
          deprecated: !!raw.deprecated,
          parameters,
          requestBody,
          security: raw.security,
        });
      }
    }
    return ops;
  }

  // ---------------------------------------------------------------------------
  // Feature resolution
  // ---------------------------------------------------------------------------

  const SUBMIT_NEGATIVE = { delete: -8, remove: -8, admin: -6, check: -3, lookup: -3, search: -3, status: -2, vote: -5, comment: -5, comments: -5, extract: -5, login: -8, register: -8, token: -4, batch: -2, bulk: -2, export: -5, approve: -6, reject: -6, review: -4 };
  const DOMAIN_SUBJECTS = { domain: 5, domains: 5, url: 4, urls: 4, site: 4, sites: 4, website: 4, websites: 4, hostname: 4, host: 3, link: 2, links: 2, phishing: 1 };
  const WALLET_SUBJECTS = { wallet: 5, wallets: 5, address: 5, addresses: 5, addr: 4, crypto: 2, blockchain: 1 };
  const SUBMISSION_SUBJECTS = { submission: 5, submissions: 5, submitted: 5, report: 4, reports: 4, reported: 4, ticket: 3, tickets: 3, case: 2, cases: 2 };
  const CHECK_ACTIONS = { check: 3, checker: 3, lookup: 3, search: 2, scan: 2, verify: 2, query: 2, reputation: 3, risk: 2, status: 1, info: 1, score: 2, is: 1, analyze: 2, analyse: 2 };
  const CHECK_NEGATIVE = { submit: -6, submission: -3, submissions: -3, report: -3, reports: -3, create: -6, add: -4, new: -3, delete: -8, remove: -8, update: -6, edit: -6, admin: -6, batch: -3, bulk: -3, login: -8, register: -8, signup: -8, token: -3, user: -3, users: -3, stats: -3, statistics: -3, export: -4, import: -4, extract: -4, vote: -4, comment: -4, comments: -4, me: -3 };

  /**
   * Feature definitions used to score operations.
   *  subjects  - what the endpoint is about (at least one subject or generic token must match)
   *  generic   - weaker subject words for catch-all endpoints (e.g. /lookup?q=)
   *  actions   - verbs that raise confidence
   *  negative  - words that rule an endpoint out (only applied to the endpoint's name, not its fields)
   *  input     - 'required' (must accept the feature's input), 'none' (no required params)
   *  inputKeys - which input aliases the endpoint should accept
   */
  const FEATURES = {
    checkDomain: {
      label: 'Check domain / website',
      methods: ['get', 'post'],
      prefer: { get: 1 },
      postNeedsAction: true,
      subjects: DOMAIN_SUBJECTS,
      generic: { check: 2, lookup: 2, search: 1, query: 1, scan: 1, indicator: 2, indicators: 2, entity: 1, target: 1 },
      actions: CHECK_ACTIONS,
      negative: Object.assign({ wallet: -6, wallets: -6, address: -5, addresses: -5 }, CHECK_NEGATIVE),
      input: 'required',
      inputKeys: ['domain', 'url', 'value'],
      threshold: 4,
    },
    checkWallet: {
      label: 'Check wallet address',
      methods: ['get', 'post'],
      prefer: { get: 1 },
      postNeedsAction: true,
      subjects: WALLET_SUBJECTS,
      generic: { check: 2, lookup: 2, search: 1, query: 1, scan: 1, indicator: 2, indicators: 2, entity: 1, target: 1 },
      actions: CHECK_ACTIONS,
      negative: Object.assign({ domain: -6, domains: -6, url: -5, urls: -5, site: -5, website: -5 }, CHECK_NEGATIVE),
      input: 'required',
      inputKeys: ['address', 'value'],
      threshold: 4,
    },
    checkWalletsBatch: {
      label: 'Check many wallets at once',
      methods: ['post'],
      subjects: WALLET_SUBJECTS,
      actions: { batch: 4, bulk: 4, multi: 3, multiple: 3, check: 2, lookup: 2 },
      requireAny: ['batch', 'bulk', 'multi', 'multiple'],
      negative: { submit: -6, report: -4, delete: -8, admin: -6, domain: -5, domains: -5, extract: -4 },
      input: 'required',
      inputKeys: ['addresses'],
      threshold: 6,
    },
    extractWallets: {
      label: 'Extract wallets from page (server-side)',
      methods: ['post'],
      subjects: WALLET_SUBJECTS,
      generic: { text: 2, page: 2, content: 2, html: 2 },
      actions: { extract: 6, find: 4, detect: 4, parse: 4, scan: 3, scrape: 4, discover: 4 },
      requireAny: ['extract', 'find', 'detect', 'parse', 'scan', 'scrape', 'discover'],
      negative: { submit: -6, report: -4, delete: -8, admin: -6, domain: -2, batch: -1 },
      input: 'required',
      inputKeys: ['text', 'url'],
      threshold: 6,
    },
    submitDomain: {
      label: 'Submit / report a domain',
      methods: ['post', 'put'],
      subjects: DOMAIN_SUBJECTS,
      generic: { submission: 3, submissions: 3, report: 3, reports: 3, submit: 3, scam: 1, scams: 1 },
      actions: { submit: 4, report: 4, reports: 3, submission: 3, submissions: 3, create: 2, add: 2, new: 2, flag: 3 },
      negative: Object.assign({ wallet: -6, wallets: -6, address: -5, addresses: -5 }, SUBMIT_NEGATIVE),
      input: 'required',
      inputKeys: ['domain', 'url', 'value'],
      threshold: 5,
    },
    submitWallet: {
      label: 'Submit / report a wallet',
      methods: ['post', 'put'],
      subjects: WALLET_SUBJECTS,
      generic: { submission: 3, submissions: 3, report: 3, reports: 3, submit: 3, scam: 1, scams: 1 },
      actions: { submit: 4, report: 4, reports: 3, submission: 3, submissions: 3, create: 2, add: 2, new: 2, flag: 3 },
      negative: Object.assign({ domain: -6, domains: -6, url: -5, urls: -5, site: -5, sites: -5, website: -5 }, SUBMIT_NEGATIVE),
      input: 'required',
      inputKeys: ['address', 'value'],
      threshold: 5,
    },
    submissionStatus: {
      label: 'Check submission status / already submitted',
      methods: ['get'],
      subjects: SUBMISSION_SUBJECTS,
      actions: { status: 4, check: 3, lookup: 3, search: 2, find: 2, exists: 3, track: 3, state: 2 },
      negative: { delete: -8, admin: -5, create: -6, vote: -4, comment: -4, comments: -4, stats: -3, statistics: -3, export: -4, me: -2, mine: -2, my: -2 },
      input: 'required',
      inputKeys: ['id', 'domain', 'url', 'address', 'value'],
      threshold: 5,
    },
    listSubmissions: {
      label: 'List my submissions',
      methods: ['get'],
      subjects: SUBMISSION_SUBJECTS,
      actions: { my: 4, mine: 4, me: 3, list: 3, history: 3, all: 1, recent: 2 },
      negative: { delete: -8, admin: -5, stats: -3, statistics: -3, export: -4, vote: -4, comment: -4, comments: -4 },
      input: 'none',
      threshold: 5,
    },
    verifyKey: {
      label: 'Verify API key',
      methods: ['get'],
      subjects: { me: 4, whoami: 5, account: 3, profile: 3, key: 3, keys: 2, apikey: 4, auth: 3, verify: 2, validate: 3, usage: 3, quota: 3, user: 1, limits: 2 },
      actions: {},
      negative: { domain: -3, domains: -3, wallet: -3, wallets: -3, submission: -3, submissions: -3, admin: -5, delete: -8, list: -1, health: -3, ping: -3 },
      input: 'none',
      needsSecurity: true,
      threshold: 4,
    },
  };

  /** Alias table: input key -> parameter / property names that mean the same thing. */
  const ALIASES = {
    domain: ['domain', 'domains', 'hostname', 'host', 'site', 'website', 'fqdn', 'domainname'],
    url: ['url', 'link', 'uri', 'href', 'pageurl', 'websiteurl', 'siteurl', 'targeturl'],
    address: ['address', 'wallet', 'walletaddress', 'addr', 'account', 'accountaddress', 'cryptoaddress', 'walletid'],
    addresses: ['addresses', 'wallets', 'walletaddresses', 'items', 'values', 'list'],
    chain: ['chain', 'network', 'blockchain', 'coin', 'currency', 'asset', 'symbol', 'chainid', 'networkid', 'ticker', 'cryptocurrency', 'crypto'],
    id: ['id', 'submissionid', 'reportid', 'ticket', 'ticketid', 'reference', 'referenceid', 'uuid', 'trackingid', 'caseid'],
    text: ['text', 'content', 'body', 'html', 'pagetext', 'pagecontent', 'rawtext'],
    kind: ['type', 'kind', 'targettype', 'entitytype', 'subjecttype', 'reporttype', 'submissiontype', 'indicatortype'],
    value: ['value', 'q', 'query', 'term', 'search', 'target', 'indicator', 'entity', 'subject', 'input', 'keyword', 'identifier'],
    source: ['source', 'sourceurl', 'foundon', 'referrer', 'evidenceurl', 'reportedfrom'],
  };
  const ALIAS_LOOKUP = {};
  for (const key of Object.keys(ALIASES)) for (const a of ALIASES[key]) if (!ALIAS_LOOKUP[a]) ALIAS_LOOKUP[a] = key;
  const CONTAINS_ORDER = [['address', 'address'], ['wallet', 'address'], ['domain', 'domain'], ['hostname', 'domain'], ['website', 'domain'], ['url', 'url'], ['chain', 'chain'], ['network', 'chain']];

  /** Map a parameter / property name to an input key (or null). */
  function aliasKey(name) {
    const n = normName(name);
    if (!n) return null;
    if (ALIAS_LOOKUP[n]) return ALIAS_LOOKUP[n];
    if (/(submission|report|ticket|case|tracking)id$/.test(n)) return 'id';
    for (const [needle, key] of CONTAINS_ORDER) if (n.includes(needle)) return key;
    return null;
  }

  function opTokens(op) {
    const path = new Set();
    for (const seg of op.path.split('/')) {
      if (!seg || /^\{.*\}$/.test(seg)) continue;
      splitWords(seg).forEach((t) => path.add(t));
    }
    const name = new Set();
    [op.operationId, op.summary].concat(op.tags || []).forEach((s) => splitWords(s).forEach((t) => name.add(t)));
    const field = new Set();
    for (const p of op.parameters) if (p.in !== 'header') splitWords(p.name).forEach((t) => field.add(t));
    const props = op.requestBody && op.requestBody.schema && op.requestBody.schema.properties;
    if (props) Object.keys(props).forEach((k) => splitWords(k).forEach((t) => field.add(t)));
    return { path, name, field };
  }

  function tokenWeight(tokens, t) {
    if (tokens.path.has(t)) return 1.5;
    if (tokens.name.has(t)) return 1;
    if (tokens.field.has(t)) return 0.5;
    return 0;
  }

  function sumTable(tokens, table, includeFields) {
    let total = 0;
    for (const t of Object.keys(table || {})) {
      let w = tokenWeight(tokens, t);
      if (!includeFields && w === 0.5) w = 0;
      total += w * table[t];
    }
    return total;
  }

  function requiredInputs(op) {
    const req = op.parameters.filter((p) => p.required && p.in !== 'header').map((p) => p.name);
    const body = op.requestBody && op.requestBody.schema;
    if (op.requestBody && op.requestBody.required && body) {
      if (body.type === 'object' && Array.isArray(body.required)) req.push(...body.required);
      else if (body.type !== 'object') req.push('(body)');
    }
    return req;
  }

  /** All inputs the operation can take: [{name, key, required, schema, location}] */
  function operationInputs(op) {
    const inputs = [];
    for (const p of op.parameters) {
      if (p.in === 'header') continue;
      inputs.push({ name: p.name, key: aliasKey(p.name), required: p.required, schema: p.schema, location: p.in });
    }
    const body = op.requestBody && op.requestBody.schema;
    if (body) {
      if (body.type === 'object' && body.properties) {
        const req = new Set(body.required || []);
        for (const k of Object.keys(body.properties)) {
          const s = body.properties[k];
          if (s.readOnly) continue;
          inputs.push({ name: k, key: aliasKey(k), required: req.has(k), schema: s, location: 'body' });
        }
      } else if (body.type === 'array') {
        inputs.push({ name: '(body)', key: 'addresses', required: true, schema: body, location: 'body-raw' });
      } else if (body.type && body.type !== 'object') {
        inputs.push({ name: '(body)', key: 'value', required: true, schema: body, location: 'body-raw' });
      }
    }
    return inputs;
  }

  /** How well an operation can accept the feature's input: 2 = alias match, 1 = single required string, 0 = no. */
  function inputFit(op, feature) {
    const inputs = operationInputs(op);
    const keys = feature.inputKeys || [];
    if (inputs.some((i) => keys.includes(i.key))) return 2;
    if (keys.includes('addresses') && inputs.some((i) => i.schema && i.schema.type === 'array' && (!i.key || i.key === 'addresses'))) return 2;
    const req = inputs.filter((i) => i.required);
    if (req.length === 1 && !req[0].key && (!req[0].schema.type || req[0].schema.type === 'string')) return 1;
    return 0;
  }

  function hasSecurity(spec, op) {
    const reqs = op.security !== undefined ? op.security : spec.security;
    return Array.isArray(reqs) && reqs.length > 0 && reqs.some((r) => Object.keys(r || {}).length > 0);
  }

  function securitySchemes(spec) {
    return (spec && ((spec.components && spec.components.securitySchemes) || spec.securityDefinitions)) || {};
  }

  /** Score an operation for a feature. Returns null when it does not qualify. */
  function scoreOperation(spec, op, featureName) {
    const f = FEATURES[featureName];
    if (!f || !f.methods.includes(op.method)) return null;
    const tokens = opTokens(op);
    const subject = sumTable(tokens, f.subjects, true);
    const generic = sumTable(tokens, f.generic, true);
    if (subject <= 0 && generic <= 0) return null;
    const action = sumTable(tokens, f.actions, true);
    const negative = sumTable(tokens, f.negative, false);
    if (f.requireAny && !f.requireAny.some((t) => tokenWeight(tokens, t) > 0)) return null;
    if (f.postNeedsAction && op.method !== 'get' && action <= 0) return null;

    let fit = 0;
    if (f.input === 'required') {
      fit = inputFit(op, f);
      if (!fit) return null;
    } else if (f.input === 'none') {
      if (requiredInputs(op).length) return null;
    }
    if (f.needsSecurity && Object.keys(securitySchemes(spec)).length && !hasSecurity(spec, op)) return null;

    let score = (subject > 0 ? subject : generic) + action + negative + (f.prefer && f.prefer[op.method] ? f.prefer[op.method] : 0) + fit;
    if (op.deprecated) score -= 2;
    if (score < (f.threshold || 4)) return null;
    return { score, fit, required: requiredInputs(op).length };
  }

  /** Rank all qualifying operations for a feature (best first). */
  function rankOperations(spec, ops, featureName) {
    const ranked = [];
    for (const op of ops) {
      const s = scoreOperation(spec, op, featureName);
      if (s) ranked.push({ op, score: s.score, fit: s.fit, required: s.required });
    }
    ranked.sort((a, b) =>
      b.score - a.score ||
      b.fit - a.fit ||
      a.required - b.required ||
      (a.op.method === 'get' ? -1 : 0) - (b.op.method === 'get' ? -1 : 0) ||
      a.op.path.length - b.op.path.length
    );
    return ranked;
  }

  /**
   * Resolve every feature to an operation.
   * overrides: { featureName: 'METHOD /path' | 'none' }
   * @returns {{[feature: string]: {op: object|null, auto: boolean, candidates: string[]}}}
   */
  function resolveFeatures(spec, overrides) {
    const ops = listOperations(spec);
    const byId = new Map(ops.map((o) => [o.id, o]));
    const result = {};
    for (const name of Object.keys(FEATURES)) {
      const ranked = rankOperations(spec, ops, name);
      const override = overrides && overrides[name];
      let op = null;
      let auto = true;
      if (override === 'none') {
        auto = false;
      } else if (override && byId.has(override)) {
        op = byId.get(override);
        auto = false;
      } else if (ranked.length) {
        op = ranked[0].op;
      }
      result[name] = { op, auto, candidates: ranked.slice(0, 5).map((r) => r.op.id) };
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Request building
  // ---------------------------------------------------------------------------

  /** Base URL that operation paths are relative to. */
  function serverBase(spec, specUrl) {
    const server = spec && Array.isArray(spec.servers) && spec.servers[0];
    if (server && server.url && server.url !== '/') {
      const vars = server.variables || {};
      const url = server.url.replace(/\{([^}]+)\}/g, (m, name) => (vars[name] && vars[name].default) || '');
      return new URL(url, specUrl).href.replace(/\/+$/, '');
    }
    if (spec && spec.swagger && spec.host) {
      const scheme = (spec.schemes && spec.schemes[0]) || new URL(specUrl).protocol.replace(':', '');
      return (scheme + '://' + spec.host + (spec.basePath || '')).replace(/\/+$/, '');
    }
    // No servers declared (common for FastAPI): paths are usually absolute from
    // the origin. If they are not, assume they are relative to the spec's folder.
    const u = new URL(specUrl);
    const dir = u.pathname.replace(/\/[^/]*$/, '');
    const paths = Object.keys((spec && spec.paths) || {});
    if (!dir || paths.some((p) => p === dir || p.startsWith(dir + '/'))) return u.origin;
    return u.origin + dir;
  }

  /** Security schemes the operation accepts, as a list of alternatives (each an AND-list). */
  function authOptions(spec, op) {
    const schemes = securitySchemes(spec);
    const reqs = op && op.security !== undefined ? op.security : spec && spec.security;
    const options = [];
    if (Array.isArray(reqs) && reqs.length) {
      for (const r of reqs) {
        const names = Object.keys(r || {});
        if (!names.length) continue;
        const list = names.map((n) => Object.assign({ key: n }, schemes[n] || {}));
        options.push(list);
      }
    }
    if (!options.length) for (const n of Object.keys(schemes)) options.push([Object.assign({ key: n }, schemes[n])]);
    return options;
  }

  function supportedScheme(s) {
    if (!s || !s.type) return false;
    if (s.type === 'apiKey') return s.in === 'header' || s.in === 'query';
    if (s.type === 'http') return /^bearer$/i.test(s.scheme || '');
    return s.type === 'oauth2' || s.type === 'openIdConnect';
  }

  /** Apply the API key according to the spec's security scheme. Mutates `req`. */
  function applyAuth(spec, op, req, apiKey) {
    if (!apiKey) return [];
    const option = authOptions(spec, op).find((list) => list.every(supportedScheme));
    if (!option) {
      // Spec does not say how to authenticate; send the two most common forms.
      req.headers['X-API-Key'] = apiKey;
      req.headers.Authorization = 'Bearer ' + apiKey;
      return ['header:X-API-Key', 'header:Authorization'];
    }
    const applied = [];
    for (const s of option) {
      if (s.type === 'apiKey' && s.in === 'header') {
        req.headers[s.name] = apiKey;
        applied.push('header:' + s.name);
      } else if (s.type === 'apiKey' && s.in === 'query') {
        req.query.push([s.name, apiKey]);
        applied.push('query:' + s.name);
      } else {
        req.headers.Authorization = 'Bearer ' + apiKey;
        applied.push('header:Authorization');
      }
    }
    return applied;
  }

  const CHAIN_SYNONYMS = {
    evm: ['eth', 'ethereum', 'evm', 'erc20', 'erc'],
    btc: ['btc', 'bitcoin'],
    sol: ['sol', 'solana'],
    trx: ['trx', 'tron', 'trc20'],
    ltc: ['ltc', 'litecoin'],
    doge: ['doge', 'dogecoin'],
    xrp: ['xrp', 'ripple'],
    ton: ['ton', 'toncoin'],
    ada: ['ada', 'cardano'],
    bch: ['bch', 'bitcoincash'],
    xmr: ['xmr', 'monero'],
  };
  const KIND_SYNONYMS = {
    domain: ['domain', 'website', 'site', 'url', 'web', 'host', 'hostname', 'phishing', 'link'],
    wallet: ['wallet', 'address', 'crypto', 'walletaddress', 'blockchain', 'account'],
  };

  /** Pick the enum option that best matches a value using a synonym table. */
  function matchEnum(options, value, synonyms) {
    if (!Array.isArray(options) || !options.length || value === undefined || value === null) return undefined;
    const v = normName(value);
    const exact = options.find((o) => normName(o) === v);
    if (exact !== undefined) return exact;
    const words = (synonyms && synonyms[value]) || [v];
    for (const w of words) {
      const hit = options.find((o) => normName(o) === w) || options.find((o) => normName(o).includes(w));
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  function coerce(value, schema) {
    if (value === undefined || value === null) return undefined;
    const s = schema || {};
    if (s.type === 'array') {
      const arr = Array.isArray(value) ? value : [value];
      return arr.map((v) => coerce(v, s.items || {})).filter((v) => v !== undefined);
    }
    if (Array.isArray(value)) value = value[0];
    if (s.type === 'integer' || s.type === 'number') {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    if (s.type === 'boolean') return value === true || value === 'true' || value === 'on' || value === 1;
    if (Array.isArray(s.enum) && s.enum.length && !s.enum.includes(value)) {
      const m = s.enum.find((o) => normName(o) === normName(value));
      return m;
    }
    return typeof value === 'object' ? value : String(value);
  }

  /** Derive a value for an input key from the caller's input object. */
  function valueFor(key, input, schema, primary) {
    let v;
    switch (key) {
      case 'domain':
        v = input.domain || (input.url ? safeHost(input.url) : undefined);
        break;
      case 'url':
        v = input.url || (input.domain ? 'https://' + input.domain + '/' : undefined);
        break;
      case 'addresses':
        v = input.addresses || (input.address ? [input.address] : undefined);
        break;
      case 'value':
        v = input[primary];
        break;
      case 'chain':
        v = input.chain;
        if (v && schema && Array.isArray(schema.enum)) v = matchEnum(schema.enum, v, CHAIN_SYNONYMS);
        break;
      case 'kind':
        v = input.kind;
        if (v && schema && Array.isArray(schema.enum)) v = matchEnum(schema.enum, v, KIND_SYNONYMS);
        break;
      case 'source':
        v = input.source;
        break;
      default:
        v = key ? input[key] : undefined;
    }
    return coerce(v, schema);
  }

  function safeHost(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return undefined;
    }
  }

  function newRequest(op) {
    return { method: op.method.toUpperCase(), path: op.path, pathParams: {}, query: [], headers: { Accept: 'application/json' }, body: undefined, contentType: null };
  }

  function encodeBody(req, data, contentType) {
    if (data === undefined) return;
    if (!contentType || /json/.test(contentType)) {
      req.contentType = 'application/json';
      req.body = JSON.stringify(data);
    } else if (contentType === 'application/x-www-form-urlencoded') {
      const usp = new URLSearchParams();
      for (const [k, v] of Object.entries(data || {})) {
        if (Array.isArray(v)) v.forEach((x) => usp.append(k, String(x)));
        else if (v !== undefined) usp.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      req.contentType = contentType;
      req.body = usp.toString();
    } else if (contentType === 'multipart/form-data' && typeof FormData !== 'undefined') {
      const fd = new FormData();
      for (const [k, v] of Object.entries(data || {})) {
        if (Array.isArray(v)) v.forEach((x) => fd.append(k, String(x)));
        else if (v !== undefined) fd.append(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
      }
      req.contentType = null; // browser sets the multipart boundary
      req.body = fd;
    } else {
      req.contentType = contentType;
      req.body = typeof data === 'string' ? data : JSON.stringify(data);
    }
  }

  /**
   * Build a request by mapping a loose input object onto the operation's
   * parameters and body. `primary` names the input key that carries the main
   * value (used for catch-all params like `q` or a lone required field).
   */
  function buildRequest(op, input, primary) {
    const req = newRequest(op);
    const inputs = operationInputs(op);
    const missing = [];
    let primaryUsed = false;
    const bodyObj = {};
    let rawBody;

    const assign = (inp, val) => {
      if (inp.location === 'path') req.pathParams[inp.name] = val;
      else if (inp.location === 'query') {
        if (Array.isArray(val)) val.forEach((x) => req.query.push([inp.name, String(x)]));
        else req.query.push([inp.name, typeof val === 'object' ? JSON.stringify(val) : String(val)]);
      } else if (inp.location === 'body') bodyObj[inp.name] = val;
      else if (inp.location === 'body-raw') rawBody = val;
    };

    const unresolved = [];
    for (const inp of inputs) {
      const val = inp.key ? valueFor(inp.key, input, inp.schema, primary) : undefined;
      if (val !== undefined && !(Array.isArray(val) && !val.length && !inp.required)) {
        assign(inp, val);
        if (inp.key === primary || inp.key === 'value' || (primary === 'address' && inp.key === 'addresses')) primaryUsed = true;
      } else if (inp.required) {
        unresolved.push(inp);
      }
    }

    // Second pass for required inputs we could not map by name.
    for (const inp of unresolved) {
      const s = inp.schema || {};
      let v;
      // An ambiguous chain guess is only sent when the endpoint insists on a chain.
      if (inp.key === 'chain' && input.chainHint) v = valueFor('chain', { chain: input.chainHint }, s, primary);
      // A lone unrecognised string parameter most likely carries the main value.
      if (v === undefined && !inp.key && !primaryUsed && input[primary] !== undefined && (!s.type || s.type === 'string')) {
        v = coerce(input[primary], s);
        primaryUsed = v !== undefined;
      }
      if (v === undefined && s.default !== undefined) v = s.default;
      if (v === undefined && Array.isArray(s.enum) && s.enum.length === 1) v = s.enum[0];
      if (v === undefined) missing.push(inp.name);
      else assign(inp, v);
    }

    if (rawBody !== undefined) encodeBody(req, rawBody, op.requestBody && op.requestBody.contentType);
    else if (Object.keys(bodyObj).length || (op.requestBody && op.requestBody.required)) encodeBody(req, bodyObj, op.requestBody && op.requestBody.contentType);

    return { request: req, missing };
  }

  /** Describe the operation's inputs as form fields (used for submission forms). */
  function describeForm(op, context) {
    const ctx = context || {};
    const fields = [];
    for (const inp of operationInputs(op)) {
      if (inp.location === 'query' && /^(skip|offset|limit|page|pagesize|perpage|sort|order|cursor)$/i.test(normName(inp.name)) && !inp.required) continue;
      const s = inp.schema || {};
      let type = 'string';
      if (Array.isArray(s.enum) && s.enum.length) type = 'enum';
      else if (s.type === 'boolean') type = 'boolean';
      else if (s.type === 'integer' || s.type === 'number') type = 'number';
      else if (s.type === 'array') type = s.items && Array.isArray(s.items.enum) ? 'multienum' : 'list';
      else if (s.type === 'object') type = 'json';
      else if (/desc|note|detail|evidence|comment|reason|message|story|summary|explanation|info|context/i.test(inp.name) || (s.maxLength && s.maxLength > 300) || s.format === 'textarea') type = 'text';

      // A $ref'd enum carries its class title ("ScamCategory"); only trust a
      // title that is just a prettier spelling of the field name.
      const fallback = humanize(inp.name === '(body)' ? (inp.key === 'addresses' ? 'Items' : 'Value') : inp.name);
      const field = {
        id: inp.location + ':' + inp.name,
        name: inp.name,
        location: inp.location,
        key: inp.key,
        label: s.title && normName(s.title) === normName(inp.name) ? s.title : fallback,
        description: s.description || '',
        required: !!inp.required,
        type,
        options: type === 'enum' ? s.enum : type === 'multienum' ? s.items.enum : undefined,
        format: s.format || '',
        default: s.default,
        value: undefined,
      };
      let pre = inp.key ? valueFor(inp.key, ctx, s, ctx.kind === 'wallet' ? 'address' : 'domain') : undefined;
      if (pre === undefined && inp.key === 'chain' && ctx.chainHint) pre = valueFor('chain', { chain: ctx.chainHint }, s);
      if (pre === undefined && inp.key === 'source' && ctx.pageUrl) pre = ctx.pageUrl;
      if (pre === undefined && s.default !== undefined) pre = s.default;
      field.value = pre;
      fields.push(field);
    }
    // Property order is not reliable (Chrome's storage returns keys sorted), so
    // order fields by role: what is reported first, free-text notes last.
    const rank = (f) => {
      const single = f.type !== 'list' && f.type !== 'multienum'; // "evidence_urls" is not the reported URL
      if (single && f.key === 'kind') return 0;
      if (single && ['domain', 'address', 'value'].includes(f.key)) return 1;
      if (single && f.key === 'url') return 2;
      if (single && f.key === 'chain') return 3;
      return f.required ? 4 : f.type === 'text' ? 6 : 5;
    };
    return fields.map((f, i) => [f, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
  }

  /** Build a request from explicit form values keyed by field id ("location:name"). */
  function buildRequestFromValues(op, values) {
    const req = newRequest(op);
    const inputs = operationInputs(op);
    const bodyObj = {};
    let rawBody;
    const missing = [];
    for (const inp of inputs) {
      const id = inp.location + ':' + inp.name;
      let v = values[id];
      if (typeof v === 'string' && v.trim() === '') v = undefined;
      if (v !== undefined) {
        const s = inp.schema || {};
        if (s.type === 'array' && typeof v === 'string') v = v.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
        if (s.type === 'object' && typeof v === 'string') {
          try {
            v = JSON.parse(v);
          } catch (e) {
            missing.push(inp.name + ' (invalid JSON)');
            continue;
          }
        }
        v = coerce(v, s);
      }
      if (v === undefined) {
        if (inp.required) missing.push(inp.name);
        continue;
      }
      if (inp.location === 'path') req.pathParams[inp.name] = v;
      else if (inp.location === 'query') (Array.isArray(v) ? v : [v]).forEach((x) => req.query.push([inp.name, String(x)]));
      else if (inp.location === 'body') bodyObj[inp.name] = v;
      else rawBody = v;
    }
    if (rawBody !== undefined) encodeBody(req, rawBody, op.requestBody && op.requestBody.contentType);
    else if (Object.keys(bodyObj).length || (op.requestBody && op.requestBody.required)) encodeBody(req, bodyObj, op.requestBody && op.requestBody.contentType);
    return { request: req, missing };
  }

  /** Turn a planned request into a URL + fetch init. */
  function toFetch(base, req) {
    let path = req.path.replace(/\{([^}]+)\}/g, (m, name) => encodeURIComponent(String(req.pathParams[name] !== undefined ? req.pathParams[name] : '')));
    const url = new URL(base.replace(/\/+$/, '') + path);
    for (const [k, v] of req.query) url.searchParams.append(k, v);
    const headers = Object.assign({}, req.headers);
    if (req.contentType) headers['Content-Type'] = req.contentType;
    const init = { method: req.method, headers };
    if (req.body !== undefined && req.method !== 'GET') init.body = req.body;
    return { url: url.href, init };
  }

  function humanize(name) {
    const s = String(name || '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function describeAuth(spec) {
    const schemes = securitySchemes(spec);
    return Object.keys(schemes).map((k) => {
      const s = schemes[k] || {};
      if (s.type === 'apiKey') return `${k}: API key in ${s.in} "${s.name}"`;
      if (s.type === 'http') return `${k}: HTTP ${s.scheme}`;
      return `${k}: ${s.type}`;
    });
  }

  return {
    FEATURES,
    ALIASES,
    splitWords,
    deref,
    resolveSchema,
    listOperations,
    aliasKey,
    operationInputs,
    scoreOperation,
    rankOperations,
    resolveFeatures,
    serverBase,
    authOptions,
    applyAuth,
    buildRequest,
    buildRequestFromValues,
    describeForm,
    toFetch,
    describeAuth,
    matchEnum,
    humanize,
  };
});
