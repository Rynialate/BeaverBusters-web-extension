// Unit tests for the PURE helpers of src/lib/volume.js: units(), iso(), latest(), hasActivity(), addUsd(),
// stableFlows(), analyzeFlows(), utxoFlows(), walletInsights(), etherscanResult(), etherscanSummary().
// No network and no explorer payloads: every input below is a hand-written scalar or a result()-shaped
// object, never a captured or invented API response.
//
//   node --test tests/volume.test.mjs
//
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { units, iso, latest, hasActivity, addUsd, stableFlows, analyzeFlows, utxoFlows, walletInsights, etherscanResult, etherscanSummary, DEPOSIT_TXS, DEPOSIT_USD } from '../src/lib/volume.js';

const close = (actual, expected, rel = 1e-12) =>
  assert.ok(Math.abs(actual - expected) <= Math.abs(expected) * rel, `${actual} !~ ${expected}`);

// A result() as volume.js builds it, so tests never depend on an explorer's payload.
const base = fields => ({
  network: 'X', asset: 'BTC', received: null, sent: null, balance: null, txCount: null,
  firstSeen: null, lastActivity: null, tokens: [], source: null, explorer: null, partial: false, note: null,
  ...fields,
});

// ------------------------------------------------------------------ units()

describe('units()', () => {
  it('null / undefined / empty string -> null', () => {
    assert.equal(units(null, 8), null);
    assert.equal(units(undefined, 8), null);
    assert.equal(units('', 8), null);
  });

  it('integer strings with 8, 6, 9 and 18 decimals', () => {
    assert.equal(units('123456789', 8), 1.23456789);
    assert.equal(units('1000000', 6), 1);
    assert.equal(units('1500000000', 9), 1.5);
    assert.equal(units('1', 18), 1e-18);
    assert.equal(units('000123', 2), 1.23);
    assert.equal(units('0', 8), 0);
  });

  it('numbers and BigInt', () => {
    assert.equal(units(150000000, 8), 1.5);
    assert.equal(units(0, 6), 0);
    assert.equal(units(123n, 2), 1.23);
  });

  it('negative integer strings', () => {
    assert.equal(units('-150000000', 8), -1.5);
    assert.equal(units('-1', 6), -0.000001);
  });

  it('integers beyond 2^53 keep the whole part exact up to double precision', () => {
    // 2^64 wei and a 30-digit raw token amount: the string path splits before Number(), so the
    // result is the nearest double to the exact decimal value.
    assert.equal(units('18446744073709551616', 18), Number('18.446744073709551616'));
    assert.equal(units('123456789012345678901234567890', 18), Number('123456789012.345678901234567890'));
    // A uint256 max allowance (what an unfiltered TRC20 Approval would carry) stays finite.
    const max = (2n ** 256n - 1n).toString();
    close(units(max, 6), 1.157920892373162e71);
  });

  it('scientific-notation strings (Ethplorer `balance`) go through Number()', () => {
    close(units('1.2345e+24', 18), 1234500);
    close(units('5e+21', 18), 5000);
    close(units('1E-7', 0), 1e-7);
  });

  it('non-numeric strings -> null', () => {
    assert.equal(units('abc', 6), null);
    assert.equal(units('1e400', 6), null); // Infinity is rejected
  });

  it('decimals = 0 returns the integer itself', () => {
    assert.equal(units('123', 0), 123);
    assert.equal(units('5', 0), 5);
  });

  it('whitespace-only string -> null', () => {
    assert.equal(units('   ', 6), null);
  });

  it('non-finite numbers -> null', () => {
    assert.equal(units(NaN, 6), null);
    assert.equal(units(Infinity, 6), null);
  });

  it('hex strings are not decimal base units', () => {
    assert.equal(units('0x10', 0), null);
  });
});

// ------------------------------------------------------------------ iso()

describe('iso()', () => {
  const T = '2020-09-13T12:26:40.000Z';

  it('empty inputs -> null', () => {
    assert.equal(iso(null), null);
    assert.equal(iso(undefined), null);
    assert.equal(iso(''), null);
  });

  it('unix seconds and unix milliseconds', () => {
    assert.equal(iso(1600000000), T);
    assert.equal(iso(1600000000000), T);
    assert.equal(iso(1231006505), '2009-01-03T18:15:05.000Z'); // Bitcoin genesis, seconds
  });

  it('"YYYY-MM-DD HH:MM:SS" is read as UTC', () => {
    assert.equal(iso('2020-09-13 12:26:40'), T);
  });

  it('ISO strings with Z or an offset', () => {
    assert.equal(iso('2020-09-13T12:26:40Z'), T);
    assert.equal(iso('2020-09-13T14:26:40+02:00'), T);
  });

  it('unparseable strings -> null', () => {
    assert.equal(iso('not a date'), null);
  });

  it('0 means "never", not 1970', () => {
    assert.equal(iso(0), null);
  });

  it('non-finite numbers -> null instead of throwing', () => {
    assert.equal(iso(NaN), null);
    assert.equal(iso(Infinity), null);
  });

  it('out-of-range numbers -> null instead of throwing', () => {
    assert.equal(iso(1e17), null);
  });

  it('numeric strings are read as unix time', () => {
    assert.equal(iso('1600000000'), T);
  });
});

// ------------------------------------------------------------------ latest()

describe('latest()', () => {
  it('picks the newest ISO string and ignores empties', () => {
    assert.equal(latest(null, '2020-01-01T00:00:00.000Z', undefined, '2021-06-01T00:00:00.000Z'), '2021-06-01T00:00:00.000Z');
    assert.equal(latest('2021-06-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'), '2021-06-01T00:00:00.000Z');
  });

  it('nothing -> null', () => {
    assert.equal(latest(), null);
    assert.equal(latest(null, undefined, ''), null);
  });

  it('is lexicographic, so it is only correct for toISOString() output', () => {
    // Expanded years (beyond 9999) sort before 4-digit years: harmless while iso() rejects them.
    assert.equal(latest('+052000-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z'), '2020-01-01T00:00:00.000Z');
  });
});

// ------------------------------------------------------------------ hasActivity()

describe('hasActivity()', () => {
  it('an all-null / all-zero result is inactive', () => {
    assert.equal(hasActivity(base({})), false);
    assert.equal(hasActivity(base({ txCount: 0, balance: 0, received: 0, sent: 0 })), false);
  });

  it('any tx, balance, received or token balance/received counts', () => {
    assert.equal(hasActivity(base({ txCount: 1 })), true);
    assert.equal(hasActivity(base({ balance: 1e-18 })), true);
    assert.equal(hasActivity(base({ received: 0.5 })), true);
    assert.equal(hasActivity(base({ tokens: [{ symbol: 'USDT', balance: 3, received: null, sent: null }] })), true);
    assert.equal(hasActivity(base({ tokens: [{ symbol: 'USDT', balance: 0, received: 7, sent: 7 }] })), true);
  });

  it('negative figures do not count', () => {
    assert.equal(hasActivity(base({ balance: -1, txCount: -1 })), false);
  });

  it('tolerates a missing tokens array', () => {
    assert.equal(hasActivity({ txCount: null, balance: null, received: null }), false);
  });

  it('a recorded last activity counts even with no counts', () => {
    assert.equal(hasActivity(base({ balance: 0, lastActivity: '2024-01-01T00:00:00.000Z' })), true);
  });

  it('a token that was only sent counts', () => {
    assert.equal(hasActivity(base({ tokens: [{ symbol: 'USDT', balance: 0, received: null, sent: 5 }] })), true);
  });
});

// ------------------------------------------------------------------ addUsd()

describe('addUsd()', () => {
  it('native received / balance at the given price, summed across networks', () => {
    const vol = { networks: [base({ asset: 'BTC', received: 2, balance: 0.5 }), base({ asset: 'ETH', received: 10, balance: 0 })] };
    addUsd(vol, { BTC: 50000, ETH: 2000 });
    assert.equal(vol.networks[0].usdReceived, 100000);
    assert.equal(vol.networks[0].usdBalance, 25000);
    assert.equal(vol.networks[1].usdReceived, 20000);
    assert.equal(vol.networks[1].usdBalance, 0);
    assert.equal(vol.usdReceived, 120000);
    assert.match(vol.pricesAt, /^\d{4}-\d\d-\d\dT/);
  });

  it('no price -> null, and the wallet total stays null', () => {
    const vol = { networks: [base({ asset: 'BTC', received: 2, balance: 0.5 })] };
    addUsd(vol, {});
    assert.equal(vol.networks[0].usdReceived, null);
    assert.equal(vol.networks[0].usdBalance, null);
    assert.equal(vol.usdReceived, null);
  });

  it('stablecoins count at $1 on top of the native figure, even without a native price or total', () => {
    const tron = base({ asset: 'TRX', received: null, balance: 100, tokens: [{ symbol: 'USDT', balance: 25, received: 1000, sent: 975 }] });
    const vol = { networks: [tron] };
    addUsd(vol, { TRX: 0.1 });
    assert.equal(tron.usdReceived, 1000);    // TRX lifetime total unknown, USDT received counted
    assert.equal(tron.usdBalance, 10 + 25);
    assert.equal(vol.usdReceived, 1000);
  });

  it('an empty wallet gives a null total', () => {
    const vol = { networks: [] };
    addUsd(vol, { BTC: 1 });
    assert.equal(vol.usdReceived, null);
  });

  it('a zero price is treated as "no price"', () => {
    const vol = { networks: [base({ asset: 'BTC', received: 1, balance: 1 })] };
    addUsd(vol, { BTC: 0 });
    assert.equal(vol.networks[0].usdReceived, null);
  });

  it('a partial token (capped stablecoin history) also marks the wallet total as a lower bound', () => {
    const v = addUsd({ networks: [base({ asset: 'ETH', received: 1, tokens: [{ symbol: 'USDT', received: 70, sent: 69, balance: 1, partial: true }] })] }, { ETH: 2000 });
    assert.equal(v.usdReceived, 2070);
    assert.equal(v.usdPartial, true);
  });

  it('a partial network marks the wallet total as a lower bound', () => {
    const vol = { networks: [base({ asset: 'TRX', partial: true, tokens: [{ symbol: 'USDT', balance: 0, received: 1e6, sent: 1e6 }] })] };
    addUsd(vol, {});
    assert.equal(vol.usdPartial, true);
  });
});

// ------------------------------------------------------------------ stableFlows()

describe('stableFlows()', () => {
  const me = '0xAbC0000000000000000000000000000000000001';
  const other = '0x2222222222222222222222222222222222222222';
  const op = (from, to, value, timestamp = 100, type = 'transfer') => ({ from, to, value, timestamp, type });

  it('sums base units in and out, matching the address case-insensitively', () => {
    const f = stableFlows([op(other, me.toLowerCase(), '70000000', 300), op(me.toLowerCase(), other, '69320943', 400)], me, 6);
    assert.equal(f.inn, 70);
    close(f.out, 69.320943);
    assert.equal(f.lastTs, 400);
  });

  it('a transfer to itself counts both ways (gross totals)', () => {
    const f = stableFlows([op(me, me, '1000000')], me, 6);
    assert.equal(f.inn, 1);
    assert.equal(f.out, 1);
  });

  it('skips non-transfer operations and unusable values', () => {
    const f = stableFlows([op(other, me, '5000000', 1, 'approve'), op(other, me, 'abc'), op(other, me, '-1'), null], me, 6);
    assert.equal(f.inn, 0);
    assert.equal(f.out, 0);
  });

  it('no operations -> zero totals and no timestamp', () => {
    assert.deepEqual(stableFlows([], me, 18), { inn: 0, out: 0, lastTs: null });
  });
});

// ------------------------------------------------------------------ analyzeFlows()

describe('analyzeFlows()', () => {
  const me = '0x' + 'b'.repeat(40);
  const real = '0x8cbd37' + '0'.repeat(30) + '1dc0';
  const fake1 = '0x8cbdb5' + '1'.repeat(30) + '1dc0'; // same first 3 and last 4 after 0x
  const fake2 = '0x8cbd43' + '2'.repeat(30) + '1dc0';
  const payer = '0x' + 'a'.repeat(40);
  const lower = a => String(a || '').toLowerCase(); // like volume.js's own normaliser
  const f = (from, to, amount, tiny = amount < 1) => ({ from, to, amount, tiny });

  it('counts distinct non-dust senders, not transfers', () => {
    const r = analyzeFlows(me, [f(payer, me, 100), f(payer, me, 50), f(real, me, 7), f(me, real, 3)], lower);
    assert.equal(r.senders, 2);
    assert.deepEqual(r.poisoning, []);
  });

  it('dust-only look-alikes of a real counterparty are poisoning, and are not senders', () => {
    const r = analyzeFlows(me, [f(me, real, 100.02), f(fake1, me, 0.0001), f(me, fake1, 0), f(fake2, me, 0.001)], lower);
    assert.deepEqual(r.poisoning.map(p => p.fake).sort(), [fake1, fake2].sort());
    assert.ok(r.poisoning.every(p => p.real === real));
    assert.equal(r.senders, 0);
  });

  it('matches addresses case-insensitively through the normaliser', () => {
    const r = analyzeFlows(me.toUpperCase().replace('0X', '0x'), [f(payer.toUpperCase().replace('0X', '0x'), me, 10)], lower);
    assert.equal(r.senders, 1);
  });

  it('look-alikes that both moved real money are not flagged', () => {
    const r = analyzeFlows(me, [f(me, real, 100), f(fake1, me, 50)], lower);
    assert.deepEqual(r.poisoning, []);
    assert.equal(r.senders, 1);
  });

  it('a dust-only address with no real look-alike is not flagged', () => {
    assert.deepEqual(analyzeFlows(me, [f(fake1, me, 0.0001)], lower).poisoning, []);
  });

  it('Tron addresses: the leading T is not part of the match', () => {
    const tme = 'T' + 'M'.repeat(33);
    const treal = 'TYAS' + 'q'.repeat(26) + 'xHLS', tfake = 'TYAS' + 'z'.repeat(26) + 'xHLS';
    const r = analyzeFlows(tme, [f(tme, treal, 500), f(tfake, tme, 0.000001)]);
    assert.deepEqual(r.poisoning, [{ fake: tfake, real: treal }]);
  });

  it('ignores transfers that do not involve the wallet, or go to itself', () => {
    const r = analyzeFlows(me, [f(payer, real, 100), f(me, me, 100), null], lower);
    assert.equal(r.senders, 0);
  });
});

// ------------------------------------------------------------------ utxoFlows()

describe('utxoFlows()', () => {
  const A = 'bc1qme', X = 'bc1qpayer1', Y = 'bc1qpayer2', Z = '1Recipient';
  it('blockchain.com shape: one sender per incoming transaction (its first input)', () => {
    const txs = [{ inputs: [{ prev_out: { addr: X, value: 9000 } }, { prev_out: { addr: Y, value: 9000 } }], out: [{ addr: A, value: 15000 }, { addr: X, value: 2000 }] }];
    assert.deepEqual(utxoFlows(A, txs), [{ from: X, to: A, amount: 0.00015, tiny: false }]);
  });
  it('Esplora shape: spending transactions become outgoing flows, change is skipped', () => {
    const txs = [{ vin: [{ prevout: { scriptpubkey_address: A, value: 100000 } }], vout: [{ scriptpubkey_address: Z, value: 60000 }, { scriptpubkey_address: A, value: 39000 }] }];
    assert.deepEqual(utxoFlows(A, txs), [{ from: A, to: Z, amount: 0.0006, tiny: false }]);
  });
  it('dust outputs are marked tiny', () => {
    const txs = [{ inputs: [{ prev_out: { addr: X, value: 1000 } }], out: [{ addr: A, value: 546 }] }];
    assert.equal(utxoFlows(A, txs)[0].tiny, true);
  });
  it('coinbase-like transactions without input addresses are skipped', () => {
    assert.deepEqual(utxoFlows(A, [{ inputs: [{}], out: [{ addr: A, value: 5e9 }] }]), []);
  });
});

// ------------------------------------------------------------------ walletInsights()

describe('walletInsights()', () => {
  it('a quiet wallet is not a deposit address, and senders are summed over networks', () => {
    const v = walletInsights({ networks: [base({ txCount: 40, senders: 12 }), base({ txCount: 3, senders: 2, sendersPartial: true })], usdReceived: 9000 });
    assert.equal(v.service, null);
    assert.equal(v.senders, 14);
    assert.equal(v.sendersPartial, true);
  });
  it('an explorer name tag marks a deposit address; a scam tag does not, and is kept as risky', () => {
    const ex = walletInsights({ networks: [base({ label: 'Binance-Hot 3', source: 'tronscan.org', network: 'Tron' })] });
    assert.deepEqual(ex.service.reasons, [{ kind: 'tag', label: 'Binance-Hot 3', source: 'tronscan.org' }]);
    const bad = walletInsights({ networks: [base({ label: 'Fake_Phishing123', source: 'tronscan.org' })] });
    assert.equal(bad.service, null);
    assert.equal(bad.tags[0].risky, true);
  });
  it('defaults: 1,000 transactions or $1,000,000 received or held', () => {
    assert.equal(DEPOSIT_TXS, 1000);
    assert.equal(DEPOSIT_USD, 1e6);
    assert.deepEqual(walletInsights({ networks: [base({ txCount: 1000 })] }).service.reasons, [{ kind: 'tx_count', value: 1000, partial: false }]);
    assert.equal(walletInsights({ networks: [base({ txCount: 999, usdBalance: 999999 })], usdReceived: 999999 }).service, null);
    assert.equal(walletInsights({ networks: [base({})], usdReceived: 1e6 }).service.reasons[0].kind, 'received_usd');
    assert.equal(walletInsights({ networks: [base({ usdBalance: 1e6 })], usdReceived: null }).service.reasons[0].kind, 'balance_usd');
  });
  it('transactions are summed over networks (a 0x wallet on several chains)', () => {
    const v = walletInsights({ networks: [base({ txCount: 600 }), base({ txCount: 500, txCountPartial: true }), base({})] });
    assert.equal(v.txCount, 1100);
    assert.equal(v.txCountPartial, true);
    assert.deepEqual(v.service.reasons, [{ kind: 'tx_count', value: 1100, partial: true }]);
  });
  it('a lower-bound count below the limit does not flag', () => {
    assert.equal(walletInsights({ networks: [base({ txCount: 100, txCountPartial: true })] }).service, null);
  });
  it('limits come from Settings; 0 turns one off', () => {
    const w = () => ({ networks: [base({ txCount: 75, usdBalance: 500 })], usdReceived: 2000 });
    assert.equal(walletInsights(w(), { txs: 50, usd: 0 }).service.reasons[0].kind, 'tx_count');
    assert.equal(walletInsights(w(), { txs: 0, usd: 1000 }).service.reasons[0].kind, 'received_usd');
    assert.equal(walletInsights(w(), { txs: 0, usd: 0 }).service, null);
  });
  it('no network with a count -> txCount null', () => {
    const v = walletInsights({ networks: [base({})] });
    assert.equal(v.txCount, null);
    assert.equal(v.txCountPartial, false);
  });
  it('running it again with other limits replaces the flag', () => {
    const v = { networks: [base({ txCount: 300 })] };
    assert.equal(walletInsights(v, { txs: 200, usd: 0 }).service.reasons[0].kind, 'tx_count');
    assert.equal(walletInsights(v, { txs: 500, usd: 0 }).service, null);
  });
  it('no network with a transfer list -> senders null', () => {
    assert.equal(walletInsights({ networks: [base({})] }).senders, null);
  });
  it('poisoning is collected with the network it was seen on', () => {
    const v = walletInsights({ networks: [base({ network: 'Ethereum', poisoning: [{ fake: 'f', real: 'r' }] })] });
    assert.deepEqual(v.poisoning, [{ fake: 'f', real: 'r', network: 'Ethereum' }]);
  });
});

// ------------------------------------------------------------------ etherscanResult()

describe('etherscanResult()', () => {
  it('status "1" -> the result; an empty list -> []', () => {
    assert.deepEqual(etherscanResult({ status: '1', message: 'OK', result: [{ hash: 'h' }] }), [{ hash: 'h' }]);
    assert.equal(etherscanResult({ status: '1', message: 'OK', result: '12345' }), '12345');
    assert.deepEqual(etherscanResult({ status: '0', message: 'No transactions found', result: [] }), []);
  });
  it('errors arrive as status "0" with the reason in result', () => {
    const code = j => { try { etherscanResult(j); return 'none'; } catch (e) { return e.code; } };
    assert.equal(code({ status: '0', message: 'NOTOK', result: 'Invalid API Key' }), 'etherscan_key');
    assert.equal(code({ status: '0', message: 'NOTOK', result: 'Missing/Invalid API Key' }), 'etherscan_key');
    assert.equal(code({ status: '0', message: 'NOTOK', result: 'Free API access is not supported for this chain. Please upgrade your api plan for full chain coverage.' }), 'etherscan_plan');
    assert.equal(code({ status: '0', message: 'NOTOK', result: 'Something else broke' }), 'etherscan_error');
    assert.equal(code(null), 'etherscan_error');
  });
  it('rate limits: a per-second limit retries soon, a daily one much later', () => {
    const at = j => { try { etherscanResult(j); } catch (e) { assert.equal(e.code, 'rate_limited'); return e.retryAt - Date.now(); } return null; };
    assert.ok(at({ status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (3/sec)' }) < 5000);
    assert.ok(at({ status: '0', message: 'NOTOK', result: 'Max daily rate limit reached. 100000 calls per day' }) > 3000e3);
  });
});

// ------------------------------------------------------------------ etherscanSummary()

describe('etherscanSummary()', () => {
  const me = '0x' + 'b'.repeat(40), other = '0x' + 'a'.repeat(40), other2 = '0x' + 'c'.repeat(40);
  const USDT = '0xdac17f958d2ee523a2206206994597c13d831ec7', SPAM = '0x' + '9'.repeat(40);
  const T = 1767000000; // timestamps are offsets from this (iso() refuses dates before 2009)
  const tx = (from, to, eth, ts, isError = '0') => ({ from, to, value: String(BigInt(Math.round(eth * 1e6)) * 10n ** 12n), timeStamp: String(T + ts), isError });
  const tok = (from, to, amount, contract, ts, decimals = 6) => ({ from, to, value: String(Math.round(amount * 10 ** decimals)), contractAddress: contract, tokenDecimal: String(decimals), timeStamp: String(T + ts) });

  it('counts, native in/out with internal transfers, failed transactions skipped', () => {
    const s = etherscanSummary(me, 'Ethereum', 'ETH', {
      normal: [tx(me, other, 0.5, 300), tx(other, me, 1, 200), tx(other, me, 9, 250, '1')],
      internal: [tx(other2, me, 0.25, 280)],
      tokens: [],
    });
    assert.equal(s.txCount, 3);
    assert.equal(s.txCountPartial, false);
    close(s.received, 1.25);
    close(s.sent, 0.5);
    assert.equal(s.partial, false);
    assert.equal(s.lastActivity, new Date((T + 300) * 1000).toISOString());
    assert.equal(s.firstSeen, new Date((T + 200) * 1000).toISOString());
    assert.equal(s.senders, 2);
  });

  it('stablecoins by contract only; balance = in - out when the whole history was read', () => {
    const s = etherscanSummary(me, 'Ethereum', 'ETH', {
      normal: [], internal: [],
      tokens: [tok(other, me, 70, USDT, 10), tok(me, other2, 69.320943, USDT, 20), tok(other, me, 5000, SPAM, 30)],
    });
    assert.equal(s.tokens.length, 1);
    assert.equal(s.tokens[0].symbol, 'USDT');
    close(s.tokens[0].received, 70);
    close(s.tokens[0].sent, 69.320943);
    close(s.tokens[0].balance, 0.679057, 1e-9);
    assert.equal(s.tokenTransfers, 3);
    assert.equal(s.tokens[0].partial, false);
  });

  it('a full page (1,000) makes counts and totals lower bounds', () => {
    const many = Array.from({ length: 1000 }, (_, i) => tx(other, me, 0.001, 1000 + i));
    const s = etherscanSummary(me, 'Ethereum', 'ETH', { normal: many, internal: [], tokens: Array.from({ length: 1000 }, (_, i) => tok(other, me, 1, USDT, 5000 + i)) });
    assert.equal(s.txCount, 1000);
    assert.equal(s.txCountPartial, true);
    assert.equal(s.partial, true);
    assert.equal(s.tokenTransfersPartial, true);
    assert.equal(s.tokens[0].balance, null); // asked for separately
    assert.equal(s.tokens[0].partial, true);
    assert.equal(s.firstSeen, null);
    assert.equal(s.sendersPartial, true);
  });

  it('a failed list is marked, not read as empty', () => {
    const s = etherscanSummary(me, 'Ethereum', 'ETH', { normal: [tx(other, me, 1, 10)], internal: null, tokens: null });
    assert.equal(s.partial, true);
    assert.equal(s.tokenTransfers, null);
    assert.equal(s.sendersPartial, true);
  });
});
