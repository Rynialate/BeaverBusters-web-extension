// Unit tests for the PURE helpers of src/lib/volume.js: units(), iso(), latest(), hasActivity(), addUsd().
// No network and no explorer payloads: every input below is a hand-written scalar or a result()-shaped
// object, never a captured or invented API response.
//
//   node --test tests/volume.test.mjs
//
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { units, iso, latest, hasActivity, addUsd } from '../src/lib/volume.js';

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

  it('a partial network marks the wallet total as a lower bound', () => {
    const vol = { networks: [base({ asset: 'TRX', partial: true, tokens: [{ symbol: 'USDT', balance: 0, received: 1e6, sent: 1e6 }] })] };
    addUsd(vol, {});
    assert.equal(vol.usdPartial, true);
  });
});
