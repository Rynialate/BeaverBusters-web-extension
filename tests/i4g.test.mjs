// Unit tests for src/lib/i4g.js. The request tests replace fetch with a stub: nothing is sent to I4G.
//
//   node --test tests/i4g.test.mjs
//
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { i4g, i4gChain, i4gDefaultEvmChain, i4gSiteUrl, i4gCheck, i4gVerdict, i4gError, I4G_KEY_RE } from '../src/lib/i4g.js';

const KEY = 'sb_' + '0123456789abcdef'.repeat(2); // format only, not a real key
const EVM = '0x' + 'ab'.repeat(20);

describe('i4gChain()', () => {
  it('chains I4G takes as they are', () => {
    for (const c of ['btc', 'ltc', 'doge', 'dash', 'bch', 'trx', 'xrp', 'sol', 'ada']) assert.equal(i4gChain({ address: 'x', chain: c }), c);
  });
  it('0x addresses take the picked network, Ethereum by default', () => {
    assert.equal(i4gChain({ address: EVM, chain: 'eth' }), 'eth');
    assert.equal(i4gChain({ address: EVM, chain: 'eth' }, 'bsc'), 'bsc');
    assert.equal(i4gChain({ address: EVM, chain: 'eth' }, 'avax'), 'avax');
    assert.equal(i4gChain({ address: EVM, chain: 'eth' }, 'base'), 'eth'); // no Base code at I4G
  });
  it('Avalanche X-Chain and TON are not accepted', () => {
    assert.equal(i4gChain({ address: 'X-avax1qy8pk2p4gf84c6tkswgfm24hcngaa6lccqp6y8', chain: 'avax' }), null);
    assert.equal(i4gChain({ address: 'EQxyz', chain: 'ton' }), null);
  });
});

describe('i4gDefaultEvmChain()', () => {
  it('the network with the most money in', () => {
    const v = { networks: [{ network: 'Ethereum', usdReceived: 10 }, { network: 'BNB Chain', usdReceived: 900 }] };
    assert.equal(i4gDefaultEvmChain(v), 'bsc');
  });
  it('Ethereum when there is no volume or only networks I4G has no code for', () => {
    assert.equal(i4gDefaultEvmChain(null), 'eth');
    assert.equal(i4gDefaultEvmChain({ networks: [{ network: 'Base', usdReceived: 5 }] }), 'eth');
  });
});

describe('i4gSiteUrl()', () => {
  it('keeps scheme, host and path; drops query and fragment', () => {
    assert.equal(i4gSiteUrl('https://scam.example.com/deposit?ref=abc&session=1#top'), 'https://scam.example.com/deposit');
    assert.equal(i4gSiteUrl('http://scam.example.com'), 'http://scam.example.com/');
  });
});

describe('i4gCheck() and i4gVerdict()', () => {
  const raw = (o = {}) => ({ site_url: 'https://s.com', site_key: 's.com', has_wallets: false, latest_wallet_collected_utc: null, stale: false, is_reported: false, site_status: 'unknown', ...o });
  it('not reported -> blue "Not reported to I4G"', () => {
    const c = i4gCheck(raw(), 's.com');
    assert.equal(c.source, 'i4g');
    assert.equal(c.known, false);
    assert.deepEqual(i4gVerdict(c), { verdict: 'not_in_hub', label: 'Not reported to I4G' });
  });
  it('active, pending and dead', () => {
    assert.equal(i4gVerdict(i4gCheck(raw({ is_reported: true, site_status: 'active' }), 's.com')).verdict, 'scam');
    assert.equal(i4gVerdict(i4gCheck(raw({ is_reported: true, site_status: 'pending' }), 's.com')).verdict, 'suspected');
    assert.equal(i4gVerdict(i4gCheck(raw({ is_reported: true, site_status: 'dead' }), 's.com')).verdict, 'unknown');
  });
  it('wallet fields and odd values', () => {
    const c = i4gCheck(raw({ is_reported: true, site_status: 'weird', has_wallets: true, latest_wallet_collected_utc: '2026-03-15T12:30:00Z', stale: true }), 's.com');
    assert.equal(c.status, 'unknown');
    assert.equal(c.hasWallets, true);
    assert.equal(c.latestWallet, '2026-03-15T12:30:00Z');
    assert.equal(c.stale, true);
    assert.equal(i4gCheck(null, 'x.com').domain, 'x.com');
  });
});

describe('i4gError()', () => {
  it('400 lists every validation error', () => {
    const e = i4gError(400, { errors: ['site_url is required.', 'wallets[0].chain is required.'] }, 'submit');
    assert.equal(e.code, 'i4g_invalid');
    assert.match(e.message, /site_url is required\. wallets\[0\]\.chain is required\./);
  });
  it('401 bad key; 403 expired vs not approved (submit only)', () => {
    assert.equal(i4gError(401, { error: 'Invalid or revoked API key.' }, 'check').code, 'i4g_bad_key');
    assert.equal(i4gError(403, { error: 'Your API key has expired. Use /rotate-api-key in Discord to get a new one.' }, 'submit').code, 'i4g_key_expired');
    assert.equal(i4gError(403, { error: 'Your account is not approved to submit. DM Sam Mabry (I4G) …' }, 'submit').code, 'i4g_not_approved');
    assert.equal(i4gError(403, { error: 'Your account is not approved to submit.' }, 'check').code, 'i4g_key_expired');
  });
  it('429, 503 and anything else', () => {
    assert.equal(i4gError(429, { error: 'Rate limit exceeded: 50 submissions per minute.' }, 'submit').code, 'i4g_rate_limited');
    assert.equal(i4gError(503, { error: 'x' }, 'submit').code, 'i4g_unavailable');
    const e = i4gError(500, { error: 'Internal server error. Please retry or contact support.' }, 'submit');
    assert.equal(e.code, 'i4g_error');
    assert.equal(e.status, 500);
  });
});

describe('requests (fetch stubbed)', () => {
  let calls;
  const answer = (status, body) => { globalThis.fetch = async (url, opts) => { calls.push({ url, opts }); return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }); }; };
  beforeEach(() => { calls = []; i4g.forget(); });

  it('a malformed key never reaches the network', async () => {
    answer(200, {});
    await assert.rejects(i4g.check('sbh_not-an-i4g-key', 's.com'), e => e.code === 'no_i4g_key');
    assert.equal(calls.length, 0);
    assert.ok(I4G_KEY_RE.test(KEY));
  });

  it('check: GET with the Bearer key and site_url, no Content-Type', async () => {
    answer(200, { site_key: 's.com', is_reported: false, site_status: 'unknown' });
    await i4g.check(KEY, 's.com');
    const { url, opts } = calls[0];
    assert.equal(url, 'https://scambuster.intelligenceforgood.org/api/check?site_url=s.com');
    assert.equal(opts.method, 'GET');
    assert.equal(opts.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(opts.headers['Content-Type'], undefined);
    assert.equal(opts.credentials, 'omit');
  });

  it('submit: POST JSON; 201 queued and 200 duplicate both resolve', async () => {
    const payload = { site_url: 'https://s.com/', wallets: [{ address: EVM, chain: 'bsc' }] };
    answer(201, { submission_id: 'cb48', status: 'queued', wallet_count: 1 });
    assert.equal((await i4g.submit(KEY, payload)).status, 'queued');
    assert.equal(calls[0].opts.method, 'POST');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(calls[0].opts.body), payload);
    answer(200, { status: 'duplicate' });
    assert.equal((await i4g.submit(KEY, payload)).status, 'duplicate');
  });

  it('a 429 pauses that endpoint only', async () => {
    answer(429, { error: 'Rate limit exceeded: 50 submissions per minute.' });
    await assert.rejects(i4g.submit(KEY, { site_url: 'https://s.com/' }), e => e.code === 'i4g_rate_limited');
    const before = calls.length;
    await assert.rejects(i4g.submit(KEY, { site_url: 'https://s.com/' }), e => e.code === 'i4g_rate_limited');
    assert.equal(calls.length, before, 'second submit refused locally');
    answer(200, { site_key: 's.com', is_reported: true, site_status: 'active' });
    assert.equal((await i4g.check(KEY, 's.com')).site_status, 'active'); // check has its own counter
  });

  it('history: one request a minute; the same page is served from memory', async () => {
    answer(200, { page: 1, total_pages: 2, total_submissions: 6, submissions: [] });
    const first = await i4g.history(KEY, 1);
    assert.equal(first.cached, false);
    assert.equal(calls.at(-1).url, 'https://scambuster.intelligenceforgood.org/api/submission_history?page=1');
    const again = await i4g.history(KEY, 1);
    assert.equal(again.cached, true);
    const n = calls.length;
    await assert.rejects(i4g.history(KEY, 2), e => e.code === 'i4g_rate_limited' && /one history request a minute/.test(e.message));
    assert.equal(calls.length, n, 'page 2 refused locally inside the minute');
  });

  it('network failure -> i4g_network', async () => {
    globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(i4g.check(KEY, 's.com'), e => e.code === 'i4g_network' && /scambuster\.intelligenceforgood\.org/.test(e.message));
  });
});
