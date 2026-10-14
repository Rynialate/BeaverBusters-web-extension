const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeVerdict, extractList, extractAddresses, extractId, describeRecord, errorMessage } = require('../src/lib/verdict.js');

const level = (data, status) => normalizeVerdict(data, status).level;

test('boolean scam flags', () => {
  assert.equal(level({ domain: 'x', is_scam: true }), 'scam');
  assert.equal(level({ domain: 'x', is_scam: false }), 'safe');
  assert.equal(level({ malicious: 'true' }), 'scam');
  assert.equal(level({ whitelisted: true }), 'safe');
});

test('explicit is_scam:false outranks scammy labels but not a review status', () => {
  assert.equal(level({ address: '0x1', is_scam: false, category: 'drainer' }), 'safe');
  assert.equal(level({ is_scam: false, status: 'under_review' }), 'suspicious');
  assert.equal(level({ is_scam: false, risk_score: 0.9 }), 'safe');
});

test('category is consulted after status', () => {
  assert.equal(level({ status: 'clean', category: 'exchange' }), 'safe');
  assert.equal(level({ category: 'phishing' }), 'scam');
});

test('status strings', () => {
  assert.equal(level({ status: 'phishing' }), 'scam');
  assert.equal(level({ verdict: 'Confirmed scam' }), 'scam');
  assert.equal(level({ status: 'under_review' }), 'suspicious');
  assert.equal(level({ classification: 'clean' }), 'safe');
  assert.equal(level({ verdict: 'not a scam' }), 'safe');
  assert.equal(level({ risk_level: 'high' }), 'scam');
  assert.equal(level({ status: 'unknown' }), 'unknown');
});

test('numeric risk scores in 0-1 and 0-100 scales', () => {
  const v = normalizeVerdict({ risk_score: 0.92 });
  assert.equal(v.level, 'scam');
  assert.equal(v.score, 92);
  assert.equal(level({ score: 55 }), 'suspicious');
  assert.equal(level({ score: 10 }), 'safe');
  assert.equal(level({ trust_score: 95 }), 'safe');
});

test('envelopes are unwrapped and their own status ignored', () => {
  assert.equal(level({ status: 'ok', data: { found: false } }), 'unknown');
  assert.equal(level({ success: true, data: { is_scam: true } }), 'scam');
  assert.equal(level({ results: [] }), 'unknown');
  assert.equal(level([{ is_phishing: true }]), 'scam');
});

test('nested verdict objects are found', () => {
  assert.equal(level({ domain: 'x', analysis: { is_malicious: true } }), 'scam');
});

test('report counts and listing flags warn rather than block', () => {
  assert.equal(level({ report_count: 3 }), 'suspicious');
  assert.equal(level({ found: true }), 'suspicious');
  assert.equal(level({ found: false }), 'unknown');
});

test('HTTP 404 means not in database', () => {
  const v = normalizeVerdict({ detail: 'Not Found' }, 404);
  assert.equal(v.level, 'unknown');
  assert.equal(v.label, 'Not in database');
});

test('bare boolean and string bodies', () => {
  assert.equal(level(true), 'scam');
  assert.equal(level(false), 'safe');
  assert.equal(level('malicious'), 'scam');
});

test('display fields prefer meaningful keys', () => {
  const v = normalizeVerdict({ is_scam: true, category: 'drainer', first_seen: '2026-01-01', internal_hash: 'abc' });
  assert.deepEqual(v.fields.slice(0, 2), [{ key: 'category', value: 'drainer' }, { key: 'first_seen', value: '2026-01-01' }]);
});

test('list, address and id extraction', () => {
  assert.deepEqual(extractList({ items: [1, 2] }), [1, 2]);
  assert.deepEqual(extractList({ data: { submissions: [3] } }), [3]);
  assert.deepEqual(extractAddresses({ wallets: ['0xabc', { address: 'T1', chain: 'tron' }] }).map((a) => a.address), ['0xabc', 'T1']);
  assert.equal(extractId({ submission_id: 42 }), '42');
  assert.equal(extractId({ data: { id: 'abc' } }), 'abc');
});

test('submission lookups: empty lists, single records and found:false', () => {
  const { submissionRecords } = require('../src/lib/verdict.js');
  assert.deepEqual(submissionRecords({ items: [] }), []);
  assert.deepEqual(submissionRecords({ total: 0, data: { items: [] } }), []);
  assert.deepEqual(submissionRecords({ found: false }), []);
  assert.equal(submissionRecords({ items: [{ id: 1 }, { id: 2 }] }).length, 2);
  assert.deepEqual(submissionRecords({ id: 'sub_1', status: 'pending', tags: ['a'] }), [{ id: 'sub_1', status: 'pending', tags: ['a'] }]);
  assert.deepEqual(extractList({ id: 1, tags: ['x', 'y'] }), []);
});

test('describeRecord summarises submissions', () => {
  const r = describeRecord({ id: 7, domain: 'bad.example', status: 'pending', created_at: '2026-10-01T00:00:00Z' });
  assert.equal(r.title, 'bad.example');
  assert.equal(r.status, 'pending');
  assert.equal(r.id, '7');
});

test('error messages from FastAPI validation errors', () => {
  const msg = errorMessage({ detail: [{ loc: ['body', 'category'], msg: 'Field required' }] }, 422);
  assert.equal(msg, 'category: Field required');
  assert.equal(errorMessage({ detail: 'Invalid API key' }, 401), 'Invalid API key');
  assert.equal(errorMessage('<html>oops</html>', 502, 'Bad Gateway'), 'HTTP 502 Bad Gateway');
});
