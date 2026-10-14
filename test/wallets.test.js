const test = require('node:test');
const assert = require('node:assert/strict');
const w = require('../src/lib/wallets.js');

// Well-known public addresses (donation / documentation examples).
const SAMPLES = {
  evm: '0x52908400098527886E0F7030069857D2E4169EE7',
  btcBech32: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
  btcLegacy: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
  btcP2sh: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
  trx: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE',
  sol: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV',
  ltc: 'ltc1qg42tkwuuxefutzxezdkdel39gfstuap288mfea',
  xrp: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh',
};

test('finds addresses of several chains in free text', () => {
  const text = `Send ETH to ${SAMPLES.evm}, BTC to ${SAMPLES.btcBech32} or ${SAMPLES.btcLegacy}.
    USDT (TRC20): ${SAMPLES.trx}. SOL: ${SAMPLES.sol}. LTC ${SAMPLES.ltc}. XRP ${SAMPLES.xrp}.`;
  const found = w.findWallets(text);
  const byAddr = Object.fromEntries(found.map((f) => [f.address, f.chain]));
  assert.equal(byAddr[SAMPLES.evm], 'evm');
  assert.equal(byAddr[SAMPLES.btcBech32], 'btc');
  assert.equal(byAddr[SAMPLES.btcLegacy], 'btc');
  assert.equal(byAddr[SAMPLES.trx], 'trx');
  assert.equal(byAddr[SAMPLES.sol], 'sol');
  assert.equal(byAddr[SAMPLES.ltc], 'ltc');
  assert.equal(byAddr[SAMPLES.xrp], 'xrp');
  assert.equal(found.length, 7);
});

test('finds addresses inside explorer links and payment URIs', () => {
  const found = w.findWallets(`https://etherscan.io/address/${SAMPLES.evm}#tokentxns bitcoin:${SAMPLES.btcP2sh}?amount=1`);
  assert.deepEqual(found.map((f) => f.address).sort(), [SAMPLES.btcP2sh, SAMPLES.evm].sort());
});

test('ignores transaction hashes, long numbers, words and hex blobs', () => {
  const text = [
    '0x' + 'a'.repeat(64), // tx hash
    '12345678901234567890123456789012345', // number
    'Pneumonoultramicroscopicsilicovolcanoconiosis',
    'deadbeef'.repeat(8),
    'The quick brown fox jumps over the lazy dog',
  ].join(' ');
  assert.deepEqual(w.findWallets(text), []);
});

test('dedupes EVM addresses case-insensitively', () => {
  const found = w.findWallets(`${SAMPLES.evm} ${SAMPLES.evm.toLowerCase()}`);
  assert.equal(found.length, 1);
});

test('respects the result limit', () => {
  const many = Array.from({ length: 20 }, (_, i) => '0x' + String(i).padStart(40, '1')).join(' ');
  assert.equal(w.findWallets(many, { limit: 5 }).length, 5);
});

test('classifyAddress recognises single addresses and URI prefixes', () => {
  assert.equal(w.classifyAddress(SAMPLES.evm).chain, 'evm');
  assert.equal(w.classifyAddress(SAMPLES.evm).ambiguous, false);
  assert.equal(w.classifyAddress('ethereum:' + SAMPLES.evm).address, SAMPLES.evm);
  assert.equal(w.classifyAddress(SAMPLES.sol).ambiguous, true);
  assert.equal(w.classifyAddress('example.com'), null);
});

test('normalizeDomain accepts URLs, bare hosts and defanged input', () => {
  assert.equal(w.normalizeDomain('https://Sub.Example.com/path?q=1'), 'sub.example.com');
  assert.equal(w.normalizeDomain('example.com'), 'example.com');
  assert.equal(w.normalizeDomain('hxxps://evil[.]example[.]com/login'), 'evil.example.com');
  assert.equal(w.normalizeDomain('evil(.)example(.)org'), 'evil.example.org');
  assert.equal(w.normalizeDomain('not a domain'), '');
  assert.equal(w.normalizeDomain('localhost'), '');
});

test('detectQuery distinguishes wallets, domains and submission ids', () => {
  assert.equal(w.detectQuery(SAMPLES.trx).kind, 'wallet');
  assert.equal(w.detectQuery('https://bad.example/x').kind, 'domain');
  assert.equal(w.detectQuery('https://bad.example/x').url, 'https://bad.example/x');
  assert.equal(w.detectQuery('3fa85f64-5717-4562-b3fc-2c963f66afa6').kind, 'submission');
  assert.equal(w.detectQuery('12345').kind, 'submission');
  assert.equal(w.detectQuery('sub_abc123').kind, 'submission');
  assert.equal(w.detectQuery('hello world').kind, 'unknown');
  assert.equal(w.detectQuery('  ').kind, 'empty');
});

test('private hosts and trusted-domain matching', () => {
  assert.ok(w.isPrivateHost('localhost'));
  assert.ok(w.isPrivateHost('192.168.1.10'));
  assert.ok(w.isPrivateHost('printer.local'));
  assert.ok(!w.isPrivateHost('example.com'));
  assert.ok(!w.isPrivateHost('8.8.8.8'));
  assert.ok(w.hostMatches('app.example.com', 'example.com'));
  assert.ok(!w.hostMatches('badexample.com', 'example.com'));
});
