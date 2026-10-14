const test = require('node:test');
const assert = require('node:assert/strict');
const openapi = require('../src/lib/openapi.js');

const fastapi = require('./fixtures/fastapi-style.json');
const generic = require('./fixtures/generic-style.json');

function resolved(spec, overrides) {
  const r = openapi.resolveFeatures(spec, overrides || {});
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.op ? v.op.id : null]));
}

test('resolves features on a FastAPI-style spec', () => {
  assert.deepEqual(resolved(fastapi), {
    checkDomain: 'GET /api/v1/domains/check',
    checkWallet: 'GET /api/v1/wallets/{address}',
    checkWalletsBatch: 'POST /api/v1/wallets/batch-check',
    extractWallets: 'POST /api/v1/wallets/extract',
    submitDomain: 'POST /api/v1/domains',
    submitWallet: 'POST /api/v1/wallets/report',
    submissionStatus: 'GET /api/v1/submissions/{submission_id}',
    listSubmissions: 'GET /api/v1/submissions/me',
    verifyKey: 'GET /api/v1/auth/me',
  });
});

test('never maps destructive or admin endpoints', () => {
  const all = Object.values(resolved(fastapi));
  assert.ok(!all.some((id) => id && id.startsWith('DELETE')));
  assert.ok(!all.includes('GET /api/v1/health'));
});

test('resolves catch-all endpoints on a generic spec', () => {
  assert.deepEqual(resolved(generic), {
    checkDomain: 'GET /lookup',
    checkWallet: 'GET /lookup',
    checkWalletsBatch: null,
    extractWallets: null,
    submitDomain: 'POST /reports',
    submitWallet: 'POST /reports',
    submissionStatus: 'GET /reports/{id}',
    listSubmissions: 'GET /reports',
    verifyKey: null,
  });
});

test('overrides win, and "none" disables a feature', () => {
  const r = resolved(fastapi, { checkDomain: 'GET /api/v1/submissions/search', listSubmissions: 'none' });
  assert.equal(r.checkDomain, 'GET /api/v1/submissions/search');
  assert.equal(r.listSubmissions, null);
});

test('serverBase handles missing, relative and Swagger servers', () => {
  assert.equal(openapi.serverBase(fastapi, 'https://sdb.example.test/api/v1/openapi.json'), 'https://sdb.example.test');
  assert.equal(openapi.serverBase(generic, 'https://api.example.test/v2/openapi.json'), 'https://api.example.test/v2');
  assert.equal(openapi.serverBase({ paths: { '/check': {} } }, 'https://x.test/api/v1/openapi.json'), 'https://x.test/api/v1');
  assert.equal(openapi.serverBase({ swagger: '2.0', host: 'h.test', basePath: '/b', schemes: ['https'], paths: {} }, 'https://h.test/spec.json'), 'https://h.test/b');
});

function opById(spec, id) {
  return openapi.listOperations(spec).find((o) => o.id === id);
}

test('builds a domain check request with the API key header from the spec', () => {
  const op = opById(fastapi, 'GET /api/v1/domains/check');
  const { request, missing } = openapi.buildRequest(op, { domain: 'evil.example', url: 'https://evil.example/', value: 'evil.example' }, 'domain');
  assert.deepEqual(missing, []);
  openapi.applyAuth(fastapi, op, request, 'test-key');
  const { url, init } = openapi.toFetch('https://sdb.example.test', request);
  assert.equal(url, 'https://sdb.example.test/api/v1/domains/check?domain=evil.example');
  assert.equal(init.method, 'GET');
  assert.equal(init.headers['X-API-Key'], 'test-key');
  assert.equal(init.headers.Authorization, undefined);
  assert.equal(init.body, undefined);
});

test('wallet check fills the path and only sends an unambiguous chain', () => {
  const op = opById(fastapi, 'GET /api/v1/wallets/{address}');
  const evm = '0x52908400098527886E0F7030069857D2E4169EE7';
  let { request } = openapi.buildRequest(op, { address: evm, chain: 'evm', chainHint: 'evm', value: evm }, 'address');
  assert.equal(openapi.toFetch('https://b.test', request).url, 'https://b.test/api/v1/wallets/' + evm + '?chain=ethereum');

  const sol = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
  ({ request } = openapi.buildRequest(op, { address: sol, chainHint: 'sol', value: sol }, 'address'));
  assert.equal(openapi.toFetch('https://b.test', request).url, 'https://b.test/api/v1/wallets/' + sol);
});

test('catch-all query parameter receives the main value; bearer auth applied', () => {
  const op = opById(generic, 'GET /lookup');
  const { request } = openapi.buildRequest(op, { domain: 'bad.example', value: 'bad.example' }, 'domain');
  openapi.applyAuth(generic, op, request, 'k');
  const { url, init } = openapi.toFetch('https://api.example.test/v2', request);
  assert.equal(url, 'https://api.example.test/v2/lookup?q=bad.example');
  assert.equal(init.headers.Authorization, 'Bearer k');
});

test('reports missing inputs instead of guessing', () => {
  const op = opById(fastapi, 'GET /api/v1/submissions/{submission_id}');
  const { missing } = openapi.buildRequest(op, { domain: 'x.example', value: 'x.example' }, 'domain');
  assert.deepEqual(missing, ['submission_id']);
});

test('batch body gets an address array', () => {
  const op = opById(fastapi, 'POST /api/v1/wallets/batch-check');
  const { request } = openapi.buildRequest(op, { addresses: ['a1', 'a2'] }, 'addresses');
  assert.equal(request.contentType, 'application/json');
  assert.deepEqual(JSON.parse(request.body), { addresses: ['a1', 'a2'] });
});

test('describeForm builds a prefilled submission form from the schema', () => {
  const op = opById(fastapi, 'POST /api/v1/wallets/report');
  const fields = openapi.describeForm(op, { kind: 'wallet', address: '0x52908400098527886E0F7030069857D2E4169EE7', chain: 'evm', source: 'https://scam.example/' });
  const byName = Object.fromEntries(fields.map((f) => [f.name, f]));
  assert.equal(byName.address.value, '0x52908400098527886E0F7030069857D2E4169EE7');
  assert.equal(byName.address.required, true);
  assert.equal(byName.chain.type, 'enum');
  assert.equal(byName.chain.value, 'ethereum');
  assert.deepEqual(byName.category.options, ['phishing', 'fake_exchange', 'investment_fraud', 'drainer', 'impersonation', 'other']);
  assert.equal(byName.category.value, undefined);
  assert.equal(byName.source_url.value, 'https://scam.example/');
  assert.equal(byName.notes.type, 'text');
});

test('describeForm maps a generic report schema and picks the enum for the kind', () => {
  const op = opById(generic, 'POST /reports');
  const domainFields = openapi.describeForm(op, { kind: 'domain', domain: 'bad.example' });
  const d = Object.fromEntries(domainFields.map((f) => [f.name, f]));
  assert.equal(d.type.value, 'website');
  assert.equal(d.target.value, 'bad.example');
  assert.equal(d.reason.type, 'text');
  const walletFields = openapi.describeForm(op, { kind: 'wallet', address: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE' });
  assert.equal(walletFields.find((f) => f.name === 'type').value, 'wallet');
});

test('readOnly properties are not part of the submission form', () => {
  const op = opById(fastapi, 'POST /api/v1/domains');
  const names = openapi.describeForm(op, { kind: 'domain', domain: 'x.example' }).map((f) => f.name);
  assert.ok(!names.includes('id'));
});

test('form fields are ordered by role, independent of property order', () => {
  const op = opById(fastapi, 'POST /api/v1/domains');
  const props = op.requestBody.schema.properties;
  const shuffled = Object.fromEntries(Object.keys(props).sort().map((k) => [k, props[k]]));
  const sortedOp = Object.assign({}, op, { requestBody: Object.assign({}, op.requestBody, { schema: Object.assign({}, op.requestBody.schema, { properties: shuffled }) }) });
  const fields = openapi.describeForm(sortedOp, { kind: 'domain', domain: 'x.example' });
  assert.deepEqual(fields.map((f) => f.name), ['domain', 'url', 'category', 'evidence_urls', 'description']);
  assert.equal(fields.find((f) => f.name === 'category').label, 'Category');
  assert.equal(fields.find((f) => f.name === 'evidence_urls').label, 'Evidence Urls');
});

test('buildRequestFromValues coerces lists and skips empty optionals', () => {
  const op = opById(fastapi, 'POST /api/v1/domains');
  const { request, missing } = openapi.buildRequestFromValues(op, {
    'body:domain': 'bad.example',
    'body:url': '',
    'body:category': 'phishing',
    'body:evidence_urls': 'https://a.example\nhttps://b.example',
  });
  assert.deepEqual(missing, []);
  assert.deepEqual(JSON.parse(request.body), { domain: 'bad.example', category: 'phishing', evidence_urls: ['https://a.example', 'https://b.example'] });
});

test('buildRequestFromValues lists missing required fields', () => {
  const op = opById(fastapi, 'POST /api/v1/domains');
  const { missing } = openapi.buildRequestFromValues(op, { 'body:domain': 'x.example' });
  assert.deepEqual(missing, ['category']);
});

test('falls back to common headers when the spec declares no auth', () => {
  const spec = { openapi: '3.0.0', paths: { '/check': { get: { parameters: [{ name: 'domain', in: 'query', required: true, schema: { type: 'string' } }] } } } };
  const op = openapi.listOperations(spec)[0];
  const { request } = openapi.buildRequest(op, { domain: 'a.example' }, 'domain');
  openapi.applyAuth(spec, op, request, 'k');
  assert.equal(request.headers['X-API-Key'], 'k');
  assert.equal(request.headers.Authorization, 'Bearer k');
});

test('resolveSchema flattens allOf and nullable anyOf', () => {
  const spec = { components: { schemas: { A: { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] } } } };
  const s = openapi.resolveSchema(spec, { allOf: [{ $ref: '#/components/schemas/A' }, { properties: { b: { anyOf: [{ type: 'integer' }, { type: 'null' }] } } }] });
  assert.equal(s.type, 'object');
  assert.deepEqual(Object.keys(s.properties), ['a', 'b']);
  assert.equal(s.properties.b.type, 'integer');
  assert.equal(s.properties.b.nullable, true);
  assert.deepEqual(s.required, ['a']);
});

test('aliasKey maps common parameter names', () => {
  assert.equal(openapi.aliasKey('wallet_address'), 'address');
  assert.equal(openapi.aliasKey('domainName'), 'domain');
  assert.equal(openapi.aliasKey('report_id'), 'id');
  assert.equal(openapi.aliasKey('q'), 'value');
  assert.equal(openapi.aliasKey('network'), 'chain');
  assert.equal(openapi.aliasKey('limit'), null);
});
