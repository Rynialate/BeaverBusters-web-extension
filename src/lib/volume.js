// On-chain money flow for a wallet, read from public block explorers (no API keys).
// The hub has no on-chain endpoint, so these calls go straight from the background worker to
// each explorer. Every adapter returns the same shape (see `result()`); missing figures are null,
// and an explorer failure is an error, never a silent zero.
//
// Sources (first that answers wins):
//   btc   blockchain.com (batched) -> mempool.space -> blockchair
//   ltc   litecoinspace.org        -> blockchair
//   doge  blockcypher              -> blockchair
//   dash  blockcypher              -> blockchair
//   bch   blockchain.com           -> blockchair
//   0x…   with an Etherscan key (Settings): Etherscan API V2 on every EVM network its plan covers,
//         else / then: ethplorer (Ethereum), binplorer (BNB Chain): native + USDT/USDC/DAI in/out;
//         blockscout (Polygon, Arbitrum, Base; explorer.optimism.io for Optimism): balances only
//   trx   tronscan (+ USDT-TRC20 in/out) -> trongrid (+ USDT-TRC20 in/out)
//   xrp   xrpscan                  -> xrplcluster (rippled)
//   sol   Solana public RPC (+ USDT/USDC token accounts)
//   ada   koios
//   ton   tonapi                   -> toncenter

export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOL_MINTS = { Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC' };
const TRC20_PAGES = 5; // up to 1,000 transfers each way, then the total is marked partial

// Stablecoins are recognised by contract address, never by symbol: scam wallets are full of
// spam tokens that call themselves "USDT". Lower-case addresses per network.
const STABLES = {
  Ethereum: { '0xdac17f958d2ee523a2206206994597c13d831ec7': 'USDT', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48': 'USDC', '0x6b175474e89094c44da98b954eedeac495271d0f': 'DAI' },
  'BNB Chain': { '0x55d398326f99059ff775485246999027b3197955': 'USDT', '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d': 'USDC' },
  Polygon: { '0xc2132d05d31c914a87c6611c10748aeb04b58e8f': 'USDT', '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359': 'USDC', '0x2791bca1f2de4661ed88a30c99a7a9449aa84174': 'USDC.e' },
  Arbitrum: { '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9': 'USDT', '0xaf88d065e77c8cc2239327c5edb3a432268e5831': 'USDC', '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8': 'USDC.e' },
  Optimism: { '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58': 'USDT', '0x0b2c639c533813f4aa9d7837caf62653d097ff85': 'USDC' },
  Base: { '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC' },
  Avalanche: { '0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7': 'USDT', '0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e': 'USDC' },
};
const stableSymbol = (network, contract) => STABLES[network]?.[String(contract || '').toLowerCase()] || null;

// CoinGecko ids for the native asset of each network, for the USD estimate.
const PRICE_IDS = {
  BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', DASH: 'dash', BCH: 'bitcoin-cash', ETH: 'ethereum',
  BNB: 'binancecoin', POL: 'polygon-ecosystem-token', TRX: 'tron', XRP: 'ripple', SOL: 'solana', ADA: 'cardano', TON: 'the-open-network',
  AVAX: 'avalanche-2',
};

const GROSS_NOTE = 'Received and sent are gross: they include change sent back to the same address.';

// ---------- polite per-host fetching ----------

const HOST_GAP_MS = {
  'mempool.space': 250, 'litecoinspace.org': 250, 'api.blockcypher.com': 400, 'api.blockchair.com': 2000,
  'api.ethplorer.io': 600, 'api.binplorer.com': 600, 'api.trongrid.io': 350, 'api.xrpscan.com': 300,
  'xrplcluster.com': 300, 'api.mainnet-beta.solana.com': 300, 'api.koios.rest': 300, 'tonapi.io': 1100,
  'toncenter.com': 1100, 'api.coingecko.com': 2500,
  // blockchain.com asks for at most one Data API request every 10 seconds (see the batching below).
  'blockchain.info': 10000, 'api.blockchain.info': 1000, 'apilist.tronscanapi.com': 400,
  'api.etherscan.io': 350, // the free plan allows 3 calls a second
};
// Statuses some explorers use for "slow down" besides 429.
const LIMIT_STATUS = { 'api.blockchair.com': [402, 430, 434, 435], 'api.trongrid.io': [403] };
const nextSlot = new Map();
const blockedUntil = new Map();
let onBlock = null;

// The background persists these windows so they survive the worker being stopped when idle.
export function restoreBlocks(obj) {
  for (const [host, until] of Object.entries(obj || {})) if (until > Date.now()) blockedUntil.set(host, Math.max(until, blockedUntil.get(host) || 0));
}
export function setBlockListener(fn) { onBlock = fn; }

export class VolumeError extends Error {
  constructor(code, message, retryAt) { super(message); this.code = code; this.retryAt = retryAt; }
}

function checkBlocked(host) {
  const until = blockedUntil.get(host) || 0;
  const blocked = until - Date.now();
  if (blocked > 0) throw new VolumeError('rate_limited', `${host} asked us to slow down; try again in ${Math.ceil(blocked / 1000)} s`, until);
}

async function getJson(url, { method = 'GET', body, headers = {}, timeoutMs = 15000 } = {}) {
  const host = new URL(url).host;
  checkBlocked(host);
  const gap = HOST_GAP_MS[host] ?? 300;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + gap);
  if (at > now) await new Promise(r => setTimeout(r, at - now));
  checkBlocked(host); // a queued sibling request may have been rate-limited meanwhile

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
      credentials: 'omit',
      cache: 'no-store',
    });
  } catch (e) {
    throw new VolumeError(e.name === 'AbortError' ? 'timeout' : 'network', `${host} could not be reached`);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429 || LIMIT_STATUS[host]?.includes(res.status)) {
    const ra = res.headers.get('retry-after');
    const secs = Number(ra) || Math.max(0, (Date.parse(ra) - Date.now()) / 1000) || (host === 'api.blockcypher.com' ? 600 : 60);
    const until = Date.now() + secs * 1000;
    blockedUntil.set(host, until);
    try { onBlock?.(Object.fromEntries([...blockedUntil].filter(([, t]) => t > Date.now()))); } catch { /* best effort */ }
    throw new VolumeError('rate_limited', `${host} rate limit reached`, until);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new VolumeError('http_' + res.status, `${host} answered HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new VolumeError('bad_json', `${host} sent an unreadable answer`); }
}

// ---------- shared helpers ----------

const DECIMAL_RE = /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

// Integer base units (string, number or BigInt) -> decimal number of whole coins; null if unusable.
export function units(raw, decimals) {
  if (!Number.isInteger(decimals) || decimals < 0) return null;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'bigint') raw = raw.toString();
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw / 10 ** decimals : null;
  let s = String(raw).trim();
  if (!s) return null;
  if (!/^-?\d+$/.test(s)) {
    // Ethplorer sometimes sends "1.2345e+24"; accept plain decimal/scientific notation only.
    if (!DECIMAL_RE.test(s)) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n / 10 ** decimals : null;
  }
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const whole = s.length > decimals ? s.slice(0, s.length - decimals) : '0';
  const frac = decimals > 0 ? s.padStart(decimals + 1, '0').slice(-decimals) : '0';
  const n = Number(`${whole}.${frac}`);
  return neg ? -n : n;
}

// Seconds, milliseconds or microseconds since the epoch, numeric strings, ISO or "YYYY-MM-DD HH:MM:SS" (UTC).
// Anything outside 2009 (the first block) .. tomorrow is not a real chain timestamp and gives null.
const EARLIEST_MS = Date.UTC(2009, 0, 1);
const plausible = d => !isNaN(d) && d.getTime() >= EARLIEST_MS && d.getTime() <= Date.now() + 86400000;
export function iso(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim())) v = Number(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null; // 0 = "never" on some explorers
    const ms = v < 1e12 ? v * 1000 : v < 1e15 ? v : v / 1000;
    const d = new Date(ms);
    return plausible(d) ? d.toISOString() : null;
  }
  const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  return plausible(d) ? d.toISOString() : null;
}

export const latest = (...dates) => dates.filter(Boolean).sort().pop() || null;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const decimalsOf = d => { const n = Number(d); return d !== null && d !== undefined && d !== '' && Number.isInteger(n) && n >= 0 ? n : null; };

function result(fields) {
  return {
    network: null, asset: null, received: null, sent: null, balance: null, txCount: null, txCountPartial: false, tokenTransfers: null,
    firstSeen: null, lastActivity: null, tokens: [], source: null, explorer: null, partial: false, note: null,
    senders: null, sendersPartial: false, poisoning: [], label: null,
    ...fields,
  };
}

// ---------- transfer analysis ----------
// Adapters that read a transfer history pass it here as [{ from, to, amount, tiny }], where `tiny`
// marks dust (zero-value or a few cents) that says nothing about who paid the wallet.

// Below these amounts a transfer is dust. Stablecoins use STABLE_DUST.
const DUST = { BTC: 0.00001, ETH: 0.0001, BNB: 0.0005, TRX: 1 };
const STABLE_DUST = 1;
const isTiny = (amount, asset) => !(amount >= (DUST[asset] ?? STABLE_DUST));

// What a wallet shows of an address: the characters after the fixed prefix, first 3 and last 4.
// Poisoners generate addresses that match exactly these.
function lookalikeKey(a) {
  const body = String(a).replace(/^(0x|bc1[qp]|ltc1q|[13LMT])/, '');
  return body.length >= 10 ? body.slice(0, 3) + '…' + body.slice(-4) : null;
}

// Distinct senders (non-dust incoming transfers) and address poisoning: counterparties that only
// sent or received dust while matching the start and end of a real counterparty's address.
export function analyzeFlows(address, flows, norm = a => String(a || '')) {
  const me = norm(address);
  const cps = new Map(); // counterparty -> { real: any non-dust transfer }
  for (const f of flows) {
    const from = norm(f?.from), to = norm(f?.to);
    const other = from === me && to !== me ? to : to === me && from !== me ? from : null;
    if (!other) continue;
    const c = cps.get(other) || { real: false };
    if (!f.tiny) c.real = true;
    cps.set(other, c);
  }
  const groups = new Map();
  for (const [a, c] of cps) {
    const k = lookalikeKey(a);
    if (k) groups.set(k, [...(groups.get(k) || []), { a, ...c }]);
  }
  const poisoning = [], fakes = new Set();
  for (const g of groups.values()) {
    const real = g.find(x => x.real);
    if (!real) continue;
    for (const x of g) if (!x.real) { fakes.add(x.a); poisoning.push({ fake: x.a, real: real.a }); }
  }
  const senders = new Set();
  for (const f of flows) {
    const from = norm(f?.from);
    if (norm(f?.to) === me && from && from !== me && !f.tiny && !fakes.has(from)) senders.add(from);
  }
  return { senders: senders.size, poisoning };
}

// Bitcoin-style transactions (blockchain.com or Esplora shape) -> flows for `address`. Each incoming
// transaction counts once, with its first input as the sender (inputs of one transaction are
// normally one wallet's).
export function utxoFlows(address, txs, same = (a, b) => a === b, asset = 'BTC') {
  const flows = [];
  for (const tx of txs || []) {
    const ins = (tx?.inputs || tx?.vin || []).map(i => (i?.prev_out ? i.prev_out.addr : i?.prevout?.scriptpubkey_address)).filter(Boolean);
    const outs = (tx?.out || tx?.vout || []).map(o => ({ a: o?.addr ?? o?.scriptpubkey_address, v: num(o?.value) || 0 }));
    if (ins.some(a => same(address, a))) {
      for (const o of outs) if (o.a && !same(address, o.a)) flows.push({ from: address, to: o.a, amount: o.v / 1e8, tiny: isTiny(o.v / 1e8, asset) });
    } else if (ins.length) {
      const v = outs.filter(o => same(address, o.a)).reduce((s, o) => s + o.v, 0) / 1e8;
      if (v > 0) flows.push({ from: ins[0], to: address, amount: v, tiny: isTiny(v, asset) });
    }
  }
  return flows;
}

const btcNorm = a => (/^(bc1|ltc1)/i.test(String(a || '')) ? String(a).toLowerCase() : String(a || ''));
const evmNorm = a => String(a || '').toLowerCase();

// ---------- adapters ----------

// ---- blockchain.com ----
// The Data API asks for at most one request every 10 seconds, so every Bitcoin address wanted at
// about the same time goes into one multiaddr request (up to 50), and each caller gets its own row.
const BC_BATCH = 50;
let bcPending = [];
let bcTimer = null;

function blockchainComBtc(address) {
  return new Promise((resolve, reject) => {
    bcPending.push({ address, resolve, reject });
    if (!bcTimer) bcTimer = setTimeout(flushBlockchainCom, 300);
  });
}

async function flushBlockchainCom() {
  bcTimer = null;
  const batch = bcPending.splice(0, BC_BATCH);
  if (bcPending.length) bcTimer = setTimeout(flushBlockchainCom, 300);
  const addrs = [...new Set(batch.map(b => b.address))];
  const same = (a, b) => (/^bc1/i.test(a) ? a.toLowerCase() === String(b).toLowerCase() : a === b);
  try {
    const j = await getJson(`https://blockchain.info/multiaddr?active=${addrs.map(encodeURIComponent).join('|')}&n=100&cors=true`);
    if (!Array.isArray(j?.addresses)) throw new VolumeError('no_data', 'blockchain.com sent no address list');
    const rows = j.addresses;
    // Newest first: the first transaction touching an address is its last activity.
    const lastSeen = new Map(), txsOf = new Map(addrs.map(a => [a, []]));
    for (const tx of Array.isArray(j?.txs) ? j.txs : []) {
      const touched = [...(tx.inputs || []).map(i => i.prev_out?.addr), ...(tx.out || []).map(o => o.addr)].filter(Boolean);
      for (const a of addrs) {
        if (!touched.some(t => same(a, t))) continue;
        if (!lastSeen.has(a)) lastSeen.set(a, tx.time);
        txsOf.get(a).push(tx);
      }
    }
    // The shared transaction list can be filled by one busy address; look the others up one by one.
    const gaps = addrs.filter(a => !lastSeen.has(a) && num(rows.find(r => same(a, r.address))?.n_tx) > 0);
    await Promise.all(gaps.map(async a => {
      const txs = await getJson(`https://mempool.space/api/address/${a}/txs`).catch(() => null);
      const t = Array.isArray(txs) && txs[0];
      if (t) lastSeen.set(a, t.status?.confirmed ? t.status.block_time : Date.now() / 1000);
    }));
    for (const b of batch) {
      const a = rows.find(r => same(b.address, r.address));
      if (!a) { b.reject(new VolumeError('no_data', 'blockchain.com returned no data for this address')); continue; }
      // The transaction list is shared by the batch, so it may hold only some of this address's history.
      const seen = txsOf.get(b.address) || [];
      const fl = analyzeFlows(b.address, utxoFlows(b.address, seen, same), btcNorm);
      b.resolve(result({
        network: 'Bitcoin', asset: 'BTC',
        received: units(a.total_received, 8), sent: units(a.total_sent, 8), balance: units(a.final_balance, 8),
        txCount: num(a.n_tx),
        lastActivity: iso(lastSeen.get(b.address)),
        senders: fl.senders, sendersPartial: seen.length < (num(a.n_tx) || 0), poisoning: fl.poisoning,
        source: 'blockchain.com', explorer: `https://www.blockchain.com/explorer/addresses/btc/${b.address}`, note: GROSS_NOTE,
      }));
    }
  } catch (e) {
    batch.forEach(b => b.reject(e));
  }
}

// blockchain.com's public address API (Haskoin store) for Bitcoin Cash. Amounts in satoshis.
async function blockchainComBch(address) {
  const cash = address.startsWith('bitcoincash:') ? address : 'bitcoincash:' + address;
  const j = await getJson(`https://api.blockchain.info/haskoin-store/bch/address/${encodeURIComponent(cash)}/balance`);
  if (!j || num(j.received) === null) throw new VolumeError('no_data', 'blockchain.com returned no data for this address');
  const balance = (num(j.confirmed) || 0) + (num(j.unconfirmed) || 0);
  let lastActivity = null;
  if (num(j.txs) > 0) {
    const t = await getJson(`https://api.blockchain.info/haskoin-store/bch/address/${encodeURIComponent(cash)}/transactions/full?limit=1`).catch(() => null);
    if (Array.isArray(t) && t[0]) lastActivity = iso(t[0].time);
  }
  return result({
    network: 'Bitcoin Cash', asset: 'BCH',
    received: units(j.received, 8), sent: units(Math.max(0, num(j.received) - balance), 8), balance: units(balance, 8),
    txCount: num(j.txs), lastActivity,
    source: 'blockchain.com', explorer: `https://www.blockchain.com/explorer/addresses/bch/${cash.replace(/^bitcoincash:/, '')}`, note: GROSS_NOTE,
  });
}

// mempool.space-style (Esplora) API: btc and ltc.
async function esplora(base, network, asset, explorer, address) {
  const source = new URL(base).host;
  const a = await getJson(`${base}/api/address/${address}`);
  if (!a) return result({ network, asset, received: 0, sent: 0, balance: 0, txCount: 0, source, explorer });
  const c = a.chain_stats || {}, m = a.mempool_stats || {};
  const funded = (c.funded_txo_sum || 0) + (m.funded_txo_sum || 0);
  const spent = (c.spent_txo_sum || 0) + (m.spent_txo_sum || 0);
  const txCount = (c.tx_count || 0) + (m.tx_count || 0);
  let lastActivity = null, fl = null, listed = 0;
  if (txCount) {
    const txs = await getJson(`${base}/api/address/${address}/txs`).catch(() => null);
    const t = Array.isArray(txs) && txs[0];
    if (t) lastActivity = t.status?.confirmed ? iso(t.status.block_time) : new Date().toISOString();
    if (Array.isArray(txs)) { fl = analyzeFlows(address, utxoFlows(address, txs, (x, y) => btcNorm(x) === btcNorm(y), asset), btcNorm); listed = txs.length; }
  }
  return result({
    network, asset, received: funded / 1e8, sent: spent / 1e8, balance: (funded - spent) / 1e8, txCount, lastActivity, source, explorer, note: GROSS_NOTE,
    ...(fl ? { senders: fl.senders, sendersPartial: listed < txCount, poisoning: fl.poisoning } : txCount === 0 ? { senders: 0 } : {}),
  });
}

async function blockchair(slug, network, asset, address, decimals = 8) {
  const j = await getJson(`https://api.blockchair.com/${slug}/dashboards/address/${encodeURIComponent(address)}`);
  const d = j?.data && Object.values(j.data)[0]?.address;
  if (!d) throw new VolumeError('no_data', 'blockchair returned no address data');
  return result({
    network, asset,
    received: units(d.received, decimals), sent: units(d.spent, decimals), balance: units(d.balance, decimals),
    txCount: num(d.transaction_count),
    firstSeen: iso(d.first_seen_receiving),
    lastActivity: latest(iso(d.last_seen_receiving), iso(d.last_seen_spending)),
    source: 'blockchair.com', explorer: `https://blockchair.com/${slug}/address/${address}`, note: GROSS_NOTE,
  });
}

async function blockcypher(coin, network, asset, address) {
  const j = await getJson(`https://api.blockcypher.com/v1/${coin}/main/addrs/${address}?limit=1`);
  const explorer = `https://live.blockcypher.com/${coin}/address/${address}/`;
  if (!j) return result({ network, asset, received: 0, sent: 0, balance: 0, txCount: 0, source: 'blockcypher.com', explorer });
  // total_received/total_sent are confirmed-only, so pair them with the confirmed balance and count.
  return result({
    network, asset,
    received: units(j.total_received, 8), sent: units(j.total_sent, 8),
    balance: units(j.balance, 8),
    txCount: num(j.n_tx),
    lastActivity: latest(iso(j.txrefs?.[0]?.confirmed), j.unconfirmed_txrefs?.length ? new Date().toISOString() : null),
    source: 'blockcypher.com', explorer, note: GROSS_NOTE + ' Unconfirmed transactions are not counted.',
  });
}

// Ethplorer-style API (Ethereum: ethplorer.io, BNB Chain: binplorer.com). Gives native totals in and
// out; stablecoin totals come from each contract's transfer history (see stableFlows()).
const ETHPLORER_HISTORY = 100; // the largest page the free key accepts; a full page marks the totals partial

// Sum one token's transfers into and out of `address`. Each operation's `value` is in base units.
export function stableFlows(ops, address, decimals) {
  const me = address.toLowerCase();
  let inn = 0, out = 0, lastTs = null;
  for (const op of ops) {
    if (op?.type && op.type !== 'transfer') continue;
    const v = units(op?.value, decimals);
    if (v === null || v < 0) continue;
    if (String(op.to).toLowerCase() === me) inn += v;
    if (String(op.from).toLowerCase() === me) out += v;
    lastTs = Math.max(lastTs || 0, num(op.timestamp) || 0) || lastTs;
  }
  return { inn, out, lastTs };
}

async function ethplorer(host, network, asset, explorerBase, address) {
  const q = `apiKey=freekey`;
  const j = await getJson(`https://${host}/getAddressInfo/${address}?${q}&showETHTotals=true`);
  if (!j || j.error) throw new VolumeError('no_data', j?.error?.message || `${host} returned no data`);
  const listed = new Map(); // contract -> { balance, decimals } for the stablecoins the wallet holds
  for (const t of j.tokens || []) {
    const contract = String(t.tokenInfo?.address || '').toLowerCase();
    const dec = decimalsOf(t.tokenInfo?.decimals);
    if (stableSymbol(network, contract) && dec !== null) listed.set(contract, { balance: units(t.rawBalance ?? t.balance, dec), decimals: dec });
  }
  const e = j.ETH || j.BNB || {};
  const [nativeTx, tokenOps] = await Promise.all([
    getJson(`https://${host}/getAddressTransactions/${address}?${q}&limit=${ETHPLORER_HISTORY}&showZeroValues=1`).catch(() => null),
    getJson(`https://${host}/getAddressHistory/${address}?${q}&type=transfer&limit=1`).catch(() => null),
  ]);
  // No token transfer at all (and none held): skip the per-contract history requests.
  const anyTokenOps = !Array.isArray(tokenOps?.operations) || tokenOps.operations.length > 0 || listed.size > 0;
  const tokens = [];
  let capped = false, stableTs = null, failed = 0;
  const flows = [];
  const nativeOk = Array.isArray(nativeTx);
  for (const t of nativeOk ? nativeTx : []) {
    if (t?.success === false) continue;
    const v = num(t?.value);
    if (v !== null) flows.push({ from: t.from, to: t.to, amount: v, tiny: isTiny(v, asset) });
  }
  for (const [contract, symbol] of anyTokenOps ? Object.entries(STABLES[network] || {}) : []) {
    let h;
    try { h = await getJson(`https://${host}/getAddressHistory/${address}?${q}&token=${contract}&type=transfer&limit=${ETHPLORER_HISTORY}`); } catch { h = null; }
    const held = listed.get(contract);
    if (!Array.isArray(h?.operations)) {
      failed++;
      if (held) tokens.push({ symbol, balance: held.balance, received: null, sent: null, partial: true });
      continue;
    }
    if (!h.operations.length && !held) continue;
    const dec = held?.decimals ?? decimalsOf(h.operations[0]?.tokenInfo?.decimals);
    if (dec === null) continue;
    const f = stableFlows(h.operations, address, dec);
    for (const op of h.operations) {
      const v = units(op?.value, dec);
      if (v !== null && (!op.type || op.type === 'transfer')) flows.push({ from: op.from, to: op.to, amount: v, tiny: isTiny(v, symbol) });
    }
    const full = h.operations.length >= ETHPLORER_HISTORY;
    capped ||= full;
    stableTs = Math.max(stableTs || 0, f.lastTs || 0) || stableTs;
    tokens.push({ symbol, balance: held ? held.balance : 0, received: f.inn, sent: f.out, partial: full });
  }
  const fl = analyzeFlows(address, flows, evmNorm);
  const notes = [];
  if (e.balance === undefined) notes.push(`${host} did not report the native ${asset} figures.`);
  if (failed) notes.push('Some stablecoin histories could not be loaded; totals are a lower bound.');
  else if (capped) notes.push(`Only the latest ${ETHPLORER_HISTORY} transfers per stablecoin are counted; totals are a lower bound.`);
  return result({
    network, asset,
    received: num(e.totalIn), sent: num(e.totalOut), balance: num(e.balance),
    // countTxs is often missing; the transaction list (up to 100) then gives the count.
    txCount: num(j.countTxs) ?? (nativeOk ? nativeTx.length : null),
    txCountPartial: num(j.countTxs) === null && nativeOk && nativeTx.length >= ETHPLORER_HISTORY,
    lastActivity: latest(Array.isArray(nativeTx) && nativeTx[0] ? iso(nativeTx[0].timestamp) : null, iso(tokenOps?.operations?.[0]?.timestamp), iso(stableTs)),
    senders: nativeOk || flows.length ? fl.senders : null,
    sendersPartial: !nativeOk || nativeTx.length >= ETHPLORER_HISTORY || capped || failed > 0,
    poisoning: fl.poisoning,
    tokens, source: host.replace(/^api\./, ''), explorer: `${explorerBase}${address}`,
    note: notes.join(' ') || null,
  });
}

// Blockscout v2: balance, transaction counts and stablecoin balances (no lifetime totals).
async function blockscout(host, network, asset, explorerBase, address) {
  const explorer = `${explorerBase}${address}`;
  const a = await getJson(`https://${host}/api/v2/addresses/${address}`);
  if (!a) return result({ network, asset, balance: 0, txCount: 0, source: host, explorer });
  const [counters, tokenBalances] = await Promise.all([
    getJson(`https://${host}/api/v2/addresses/${address}/counters`).catch(() => null),
    getJson(`https://${host}/api/v2/addresses/${address}/token-balances`).catch(() => null),
  ]);
  const tokens = [];
  for (const t of Array.isArray(tokenBalances) ? tokenBalances : []) {
    const symbol = stableSymbol(network, t.token?.address_hash ?? t.token?.address);
    const dec = decimalsOf(t.token?.decimals);
    if (symbol && dec !== null) tokens.push({ symbol, balance: units(t.value, dec), received: null, sent: null });
  }
  return result({
    network, asset,
    balance: units(a.coin_balance, 18),
    txCount: counters ? num(counters.transactions_count) : null,
    tokenTransfers: counters ? num(counters.token_transfers_count) : null,
    tokens, source: host, explorer,
    note: counters ? 'Lifetime totals are not available from this explorer.' : 'Transaction counts could not be loaded; activity may be under-reported.',
  });
}

// ---- Etherscan (API V2: one key for every EVM chain) ----
// Used first for 0x wallets when Settings has an Etherscan key. The free plan does not cover BNB Chain,
// Base, OP or Avalanche and returns at most 1,000 records per request; a chain the key's plan does
// not cover, or any other Etherscan failure, falls back to that network's keyless explorer.
let etherscanKey = '';
export function setEtherscanKey(key) {
  const next = String(key || '').trim();
  if (next !== etherscanKey) etherscanRefused.clear(); // another key may have another plan
  etherscanKey = next;
}
const ETHERSCAN_API = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_PAGE = 1000;
const etherscanRefused = new Set(); // chain ids the key's plan does not cover, remembered for the session
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Etherscan answers errors with HTTP 200: status "0" and the reason in `result`. An empty list is
// status "0" with an empty array ("No transactions found").
export function etherscanResult(j) {
  if (j && j.status === '1') return j.result;
  if (j && Array.isArray(j.result) && !j.result.length) return [];
  const why = String(typeof j?.result === 'string' && j.result ? j.result : j?.message || 'no answer');
  if (/rate limit|limit reached/i.test(why)) {
    const daily = /day|daily|resets/i.test(why);
    throw new VolumeError('rate_limited', daily ? 'Etherscan daily limit reached' : 'Etherscan rate limit reached', Date.now() + (daily ? 3600e3 : 1500));
  }
  if (/api key/i.test(why)) throw new VolumeError('etherscan_key', 'Etherscan did not accept the API key set in Settings');
  if (/not supported for this chain|upgrade your api plan/i.test(why)) throw new VolumeError('etherscan_plan', 'This chain is not covered by your Etherscan plan');
  throw new VolumeError('etherscan_error', 'Etherscan: ' + why.slice(0, 120));
}

// The key goes in the query string, as Etherscan requires; error messages never include the URL.
async function etherscanCall(chainid, params, key = etherscanKey) {
  const qs = new URLSearchParams({ chainid: String(chainid), ...params, apikey: key });
  for (let attempt = 0; ; attempt++) {
    try {
      return etherscanResult(await getJson(`${ETHERSCAN_API}?${qs}`, { timeoutMs: 20000 }));
    } catch (e) {
      // A per-second limit clears almost at once: wait and try again (twice at most).
      if (e.code === 'rate_limited' && e.retryAt - Date.now() < 5000 && attempt < 2) { await sleep(1100); continue; }
      throw e;
    }
  }
}

// Whether Etherscan accepts a key: a balance read on Ethereum.
export async function checkEtherscanKey(key) {
  await etherscanCall(1, { module: 'account', action: 'balance', address: '0x0000000000000000000000000000000000000000', tag: 'latest' }, String(key || '').trim());
  return true;
}

// Etherscan's three lists for one address -> the figures of one network. `normal`, `internal` and
// `tokens` are arrays (newest first, up to ETHERSCAN_PAGE) or null when that list failed.
export function etherscanSummary(address, network, asset, { normal, internal, tokens }) {
  const me = String(address).toLowerCase();
  const capped = l => Array.isArray(l) && l.length >= ETHERSCAN_PAGE;
  let received = 0, sent = 0, firstTs = null, lastTs = null;
  const flows = [], stable = new Map();
  const when = ts => {
    const t = num(ts);
    if (!t) return;
    if (!lastTs || t > lastTs) lastTs = t;
    if (!firstTs || t < firstTs) firstTs = t;
  };
  for (const t of [...(normal || []), ...(internal || [])]) {
    when(t?.timeStamp);
    if (t?.isError === '1') continue;
    const v = units(t?.value, 18);
    if (v === null) continue;
    const from = String(t.from).toLowerCase(), to = String(t.to).toLowerCase();
    if (to === me && from !== me) received += v;
    if (from === me && to !== me) sent += v;
    flows.push({ from, to, amount: v, tiny: isTiny(v, asset) });
  }
  for (const t of tokens || []) {
    when(t?.timeStamp);
    const contract = String(t?.contractAddress || '').toLowerCase();
    const symbol = stableSymbol(network, contract);
    const dec = decimalsOf(t?.tokenDecimal);
    const v = symbol && dec !== null ? units(t.value, dec) : null;
    if (v === null) continue;
    const from = String(t.from).toLowerCase(), to = String(t.to).toLowerCase();
    const s = stable.get(contract) || { symbol, decimals: dec, inn: 0, out: 0 };
    if (to === me && from !== me) s.inn += v;
    if (from === me && to !== me) s.out += v;
    stable.set(contract, s);
    flows.push({ from, to, amount: v, tiny: isTiny(v, symbol) });
  }
  const tokensCapped = capped(tokens);
  const complete = Array.isArray(normal) && Array.isArray(internal) && Array.isArray(tokens) && !capped(normal) && !capped(internal) && !tokensCapped;
  const fl = analyzeFlows(address, flows, evmNorm);
  return {
    received, sent,
    txCount: Array.isArray(normal) ? normal.length : null,
    txCountPartial: capped(normal),
    tokenTransfers: Array.isArray(tokens) ? tokens.length : null,
    tokenTransfersPartial: tokensCapped,
    partial: capped(normal) || capped(internal) || !Array.isArray(internal),
    firstSeen: complete ? iso(firstTs) : null,
    lastActivity: iso(lastTs),
    // In minus out is the balance when the whole token history was read; otherwise ask for it.
    tokens: [...stable].map(([contract, t]) => ({ contract, symbol: t.symbol, decimals: t.decimals, received: t.inn, sent: t.out, balance: tokensCapped ? null : Math.max(0, t.inn - t.out), partial: tokensCapped })),
    senders: fl.senders,
    sendersPartial: !complete,
    poisoning: fl.poisoning,
  };
}

async function etherscanNetwork(net, address) {
  const { chainid, network, asset } = net;
  if (etherscanRefused.has(chainid)) throw new VolumeError('etherscan_plan', 'This chain is not covered by your Etherscan plan');
  const list = action => etherscanCall(chainid, { module: 'account', action, address, startblock: '0', endblock: '99999999', page: '1', offset: String(ETHERSCAN_PAGE), sort: 'desc' });
  let normal;
  try { normal = await list('txlist'); } catch (e) {
    if (e.code === 'etherscan_plan') etherscanRefused.add(chainid);
    throw e;
  }
  const [internal, tokens] = await Promise.all([list('txlistinternal').catch(() => null), list('tokentx').catch(() => null)]);
  const sum = etherscanSummary(address, network, asset, { normal, internal, tokens });
  const active = normal.length || internal?.length || tokens?.length;
  const balance = active ? units(await etherscanCall(chainid, { module: 'account', action: 'balance', address, tag: 'latest' }).catch(() => null), 18) : 0;
  for (const t of sum.tokens) {
    if (t.balance === null) t.balance = units(await etherscanCall(chainid, { module: 'account', action: 'tokenbalance', contractaddress: t.contract, address, tag: 'latest' }).catch(() => null), t.decimals);
    delete t.contract;
    delete t.decimals;
  }
  const notes = [];
  if (internal === null) notes.push('Internal transfers could not be loaded; native totals may be low.');
  if (tokens === null) notes.push('Token transfers could not be loaded.');
  if (sum.txCountPartial || sum.tokenTransfersPartial || internal?.length >= ETHERSCAN_PAGE) notes.push(`Only the latest ${ETHERSCAN_PAGE.toLocaleString('en-US')} records of each kind are read; totals are a lower bound.`);
  return result({
    network, asset, ...sum, balance,
    note: notes.join(' ') || null,
    source: 'etherscan.io', explorer: `${net.explorer}${address}`,
  });
}

// Etherscan first when there is a key; on failure the keyless explorer answers (a refused key is
// noted). Avalanche has no keyless source.
async function evmNetwork(net, address) {
  if (!etherscanKey) return net.keyless(address);
  try {
    return await etherscanNetwork(net, address);
  } catch (first) {
    if (!net.keyless) throw first;
    let r;
    try { r = await net.keyless(address); } catch (second) { throw first.code === 'etherscan_key' ? first : second; }
    if (first.code === 'etherscan_key') r.note = `${r.note || ''} Etherscan refused the API key set in Settings.`.trim();
    return r;
  }
}

const EVM_NETWORKS = [
  { network: 'Ethereum', asset: 'ETH', chainid: 1, explorer: 'https://etherscan.io/address/', keyless: a => ethplorer('api.ethplorer.io', 'Ethereum', 'ETH', 'https://etherscan.io/address/', a) },
  { network: 'BNB Chain', asset: 'BNB', chainid: 56, explorer: 'https://bscscan.com/address/', keyless: a => ethplorer('api.binplorer.com', 'BNB Chain', 'BNB', 'https://bscscan.com/address/', a) },
  { network: 'Polygon', asset: 'POL', chainid: 137, explorer: 'https://polygonscan.com/address/', keyless: a => blockscout('polygon.blockscout.com', 'Polygon', 'POL', 'https://polygonscan.com/address/', a) },
  { network: 'Arbitrum', asset: 'ETH', chainid: 42161, explorer: 'https://arbiscan.io/address/', keyless: a => blockscout('arbitrum.blockscout.com', 'Arbitrum', 'ETH', 'https://arbiscan.io/address/', a) },
  { network: 'Optimism', asset: 'ETH', chainid: 10, explorer: 'https://optimistic.etherscan.io/address/', keyless: a => blockscout('explorer.optimism.io', 'Optimism', 'ETH', 'https://optimistic.etherscan.io/address/', a) },
  { network: 'Base', asset: 'ETH', chainid: 8453, explorer: 'https://basescan.org/address/', keyless: a => blockscout('base.blockscout.com', 'Base', 'ETH', 'https://basescan.org/address/', a) },
  { network: 'Avalanche', asset: 'AVAX', chainid: 43114, explorer: 'https://snowscan.xyz/address/', keyless: null },
];
// Networks a 0x address is checked on: Avalanche only with an Etherscan key.
const evmNetworks = () => EVM_NETWORKS.filter(n => n.keyless || etherscanKey);

// Sum one token's TRC20 transfers in one direction, following TronGrid's pagination. Never throws:
// a failed page ends the sum early and marks it partial.
async function trc20Total(address, contract, direction) {
  let url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${direction}=true&contract_address=${contract}&limit=200`;
  let total = 0, count = 0, partial = false, lastTs = null, firstTs = null, error = null;
  const flows = [];
  for (let page = 0; page < TRC20_PAGES && url; page++) {
    let j;
    try { j = await getJson(url); } catch (e) { error = e; partial = true; break; }
    for (const t of j?.data || []) {
      // The endpoint also returns Approval events (often 2^256-1); only count real transfers.
      if (t.type && t.type !== 'Transfer') continue;
      if (t.token_info?.address && t.token_info.address !== contract) continue;
      const v = units(t.value, decimalsOf(t.token_info?.decimals) ?? 6) || 0;
      total += v;
      count++;
      flows.push({ from: t.from, to: t.to, amount: v, tiny: isTiny(v, 'USDT') });
      if (!lastTs || t.block_timestamp > lastTs) lastTs = t.block_timestamp;
      if (!firstTs || t.block_timestamp < firstTs) firstTs = t.block_timestamp;
    }
    url = j?.meta?.links?.next || null;
    if (url && page === TRC20_PAGES - 1) partial = true;
  }
  return { total, count, partial, lastTs, firstTs, error, flows };
}

// ---- Tronscan ----
// An API key is optional (Settings); Tronscan may refuse or throttle requests without one,
// and then TronGrid answers instead.
let tronscanKey = '';
export function setTronscanKey(key) { tronscanKey = String(key || '').trim(); }
const tronscanHeaders = () => (tronscanKey ? { 'TRON-PRO-API-KEY': tronscanKey } : {});
const TRONSCAN_PAGE = 50;
const TRONSCAN_PAGES = 20; // up to 1,000 USDT transfers, then the totals are marked partial

// Walk one of Tronscan's transfer lists for the wallet and split it into money in and money out.
// `pick(t)` returns the transfer's amount in whole units, or null to skip it. Never throws after the
// first page: a failed later page ends the walk and marks the totals partial.
async function tronscanWalk(url, address, fromKey, toKey, pick, asset) {
  let inn = 0, out = 0, nIn = 0, nOut = 0, partial = false, error = null, firstTs = null, lastTs = null;
  const flows = [];
  const seen = new Set(); // the list is newest first and live: new transfers shift later pages
  for (let page = 0; page < TRONSCAN_PAGES; page++) {
    let j;
    try {
      j = await getJson(`${url}&limit=${TRONSCAN_PAGE}&start=${page * TRONSCAN_PAGE}`, { headers: tronscanHeaders() });
      if (!Array.isArray(j?.token_transfers) && !Array.isArray(j?.data)) throw new VolumeError('no_data', 'tronscan sent no transfer list');
    } catch (e) {
      if (page === 0) throw e; // nothing summed yet: let TronGrid answer instead
      error = e; partial = true; break;
    }
    const list = Array.isArray(j.token_transfers) ? j.token_transfers : j.data;
    for (const t of list) {
      const id = t.transaction_id || t.transactionHash || t.hash;
      const key = `${id}|${t[fromKey]}|${t[toKey]}|${t.quant ?? t.amount}`;
      if (id) { if (seen.has(key)) continue; seen.add(key); }
      if (t.revert || (t.finalResult && t.finalResult !== 'SUCCESS') || (t.contractRet && t.contractRet !== 'SUCCESS')) continue;
      const amount = pick(t);
      if (amount === null) continue;
      if (t[toKey] === address && t[fromKey] !== address) { inn += amount; nIn++; }
      else if (t[fromKey] === address && t[toKey] !== address) { out += amount; nOut++; }
      else continue; // to itself, or not this wallet
      flows.push({ from: t[fromKey], to: t[toKey], amount, tiny: isTiny(amount, asset) });
      const ts = num(t.block_ts ?? t.timestamp);
      if (ts && (!lastTs || ts > lastTs)) lastTs = ts;
      if (ts && (!firstTs || ts < firstTs)) firstTs = ts;
    }
    if (list.length < TRONSCAN_PAGE) break;
    if (page === TRONSCAN_PAGES - 1) partial = true;
  }
  return { inn, out, nIn, nOut, partial, error, firstTs, lastTs, flows };
}

// USDT-TRC20: Transfer events only (the list also carries approvals), checked by contract.
const tronscanUsdt = address => tronscanWalk(
  `https://apilist.tronscanapi.com/api/token_trc20/transfers?contract_address=${USDT_TRC20}&relatedAddress=${address}`,
  address, 'from_address', 'to_address',
  t => ((t.event_type && t.event_type !== 'Transfer') || (t.contract_address && t.contract_address !== USDT_TRC20)
    ? null : units(t.quant, decimalsOf(t.tokenInfo?.tokenDecimal) ?? 6)), 'USDT');

// Native TRX: the transfer list filtered to TRX (token "_"); it otherwise also lists TRC10 airdrops.
const tronscanTrx = address => tronscanWalk(
  `https://apilist.tronscanapi.com/api/transfer?address=${address}&token=_`,
  address, 'transferFromAddress', 'transferToAddress',
  t => ((t.tokenInfo?.tokenId ?? t.tokenName) !== '_' ? null : units(t.amount, decimalsOf(t.tokenInfo?.tokenDecimal) ?? 6)), 'TRX');

async function tronViaTronscan(address) {
  const explorer = `https://tronscan.org/#/address/${address}`;
  // /api/account answers without a key (accountv2 needs one).
  const acct = await getJson(`https://apilist.tronscanapi.com/api/account?address=${address}`, { headers: tronscanHeaders() });
  if (!acct || acct.address !== address) throw new VolumeError('no_data', `tronscan: ${acct?.message || acct?.error || acct?.Error || 'no account data for this address'}`);
  const [trx, usdtWalk] = await Promise.all([tronscanTrx(address).catch(e => ({ failed: e })), tronscanUsdt(address).catch(e => ({ failed: e }))]);
  // USDT from TronGrid if Tronscan will not list the transfers.
  let usdt = usdtWalk, usdtSource = 'tronscan.org';
  if (usdtWalk.failed) {
    const [i, o] = await Promise.all([trc20Total(address, USDT_TRC20, 'only_to'), trc20Total(address, USDT_TRC20, 'only_from')]);
    usdtSource = 'trongrid.io';
    usdt = (i.error && !i.count) || (o.error && !o.count)
      ? { unavailable: true, inn: null, out: null, nIn: 0, nOut: 0, partial: true, error: i.error || o.error }
      : { inn: i.total, out: o.total, nIn: i.count, nOut: o.count, partial: i.partial || o.partial, error: i.error || o.error, firstTs: Math.min(...[i.firstTs, o.firstTs].filter(Boolean)), lastTs: Math.max(...[i.lastTs, o.lastTs].filter(Boolean)), flows: [...i.flows, ...o.flows] };
  }
  const trxOk = !trx.failed;
  const fl = analyzeFlows(address, [...(trxOk ? trx.flows : []), ...(usdt.flows || [])]);
  const usdtRow = (acct.trc20token_balances || []).find(t => t.tokenId === USDT_TRC20);
  const notes = [`TRX and USDT-TRC20 totals are summed from transfers (Tronscan${usdtSource !== 'tronscan.org' ? '; USDT from TronGrid' : ''}).`];
  if (!num(acct.date_created)) notes.unshift('Not activated (no TRX yet).');
  if (!trxOk) notes.push('TRX transfers could not be loaded; only the TRX balance is shown.');
  if (num(acct.transactions_in) !== null || num(acct.transactions_out) !== null) notes.push(`Transactions in/out: ${num(acct.transactions_in) ?? '?'} / ${num(acct.transactions_out) ?? '?'}.`);
  if (usdt.unavailable) notes.push('USDT transfers could not be loaded from Tronscan or TronGrid; USDT totals are unavailable.');
  else if ((trxOk && trx.error) || usdt.error) notes.push('Some transfer pages could not be loaded, so totals are a lower bound.');
  return result({
    network: 'Tron', asset: 'TRX',
    received: trxOk ? trx.inn : null, sent: trxOk ? trx.out : null,
    balance: units(acct.balance ?? 0, 6),
    txCount: num(acct.totalTransactionCount),
    // Transfer history gives a first-seen date only when it was read to the end.
    firstSeen: iso(acct.date_created) || iso(Math.min(...[trxOk && !trx.partial && trx.firstTs, !usdt.partial && usdt.firstTs].filter(Boolean))),
    lastActivity: latest(iso(acct.latest_operation_time), trxOk ? iso(trx.lastTs) : null, iso(usdt.lastTs)),
    tokens: (usdt.nIn || usdt.nOut || usdtRow || usdt.unavailable) ? [{
      symbol: 'USDT',
      balance: usdtRow ? units(usdtRow.balance, decimalsOf(usdtRow.tokenDecimal) ?? 6) : (!usdt.partial ? Math.max(0, usdt.inn - usdt.out) : null),
      received: usdt.inn, sent: usdt.out, transfersIn: usdt.nIn, transfersOut: usdt.nOut, partial: !!usdt.partial,
    }] : [],
    partial: trxOk && trx.partial,
    senders: fl.senders, sendersPartial: !trxOk || trx.partial || !!usdt.partial, poisoning: fl.poisoning,
    // Tronscan's own public name tag (e.g. an exchange hot wallet); account names set by owners are not used.
    label: typeof acct.addressTag === 'string' && acct.addressTag.trim() ? acct.addressTag.trim() : null,
    source: 'tronscan.org', explorer, note: notes.join(' '),
  });
}

async function tron(address) {
  try {
    return await tronViaTronscan(address);
  } catch (first) {
    let r;
    try { r = await tronViaTrongrid(address); } catch { throw first; }
    if (tronscanKey && (first.code === 'http_401' || first.code === 'http_403')) r.note = `${r.note || ''} Tronscan refused the API key set in Settings.`.trim();
    return r;
  }
}

async function tronViaTrongrid(address) {
  const explorer = `https://tronscan.org/#/address/${address}`;
  // TRC20 transfers do not activate an account, so the USDT totals are fetched either way.
  const [j, inn, out] = await Promise.all([
    getJson(`https://api.trongrid.io/v1/accounts/${address}`),
    trc20Total(address, USDT_TRC20, 'only_to'),
    trc20Total(address, USDT_TRC20, 'only_from'),
  ]);
  if (inn.error && !inn.count && inn.error.code === 'rate_limited') throw inn.error;
  const acct = j?.data?.[0];
  const partial = inn.partial || out.partial;
  const usdtBal = acct ? (acct.trc20 || []).map(o => o[USDT_TRC20]).find(v => v !== undefined) : undefined;
  const notes = ['TRX lifetime totals are not available; USDT-TRC20 totals are summed from transfers.'];
  if (!acct) notes.unshift('Not activated (no TRX yet).');
  if (inn.error || out.error) notes.push('Some transfer pages could not be loaded, so the USDT totals are a lower bound.');
  return result({
    network: 'Tron', asset: 'TRX',
    balance: acct ? units(acct.balance ?? 0, 6) : 0,
    firstSeen: iso(acct?.create_time) || iso(Math.min(...[inn.firstTs, out.firstTs].filter(Boolean))),
    lastActivity: latest(iso(acct?.latest_opration_time), iso(inn.lastTs), iso(out.lastTs)),
    tokens: (inn.count || out.count || usdtBal !== undefined) ? [{
      symbol: 'USDT',
      balance: usdtBal !== undefined ? units(usdtBal, 6) : (!partial ? Math.max(0, inn.total - out.total) : null),
      received: inn.total, sent: out.total, transfersIn: inn.count, transfersOut: out.count, partial,
    }] : [],
    // Senders from USDT transfers only: TronGrid has no TRX transfer walk here.
    ...(() => { const fl = analyzeFlows(address, [...inn.flows, ...out.flows]); return { senders: fl.senders, sendersPartial: true, poisoning: fl.poisoning }; })(),
    source: 'trongrid.io', explorer, note: notes.join(' '),
  });
}

async function xrp(address) {
  const explorer = `https://xrpscan.com/account/${address}`;
  const viaXrpscan = async () => {
    const j = await getJson(`https://api.xrpscan.com/api/v1/account/${address}`);
    if (!j || (j.xrpBalance === undefined && !j.account)) throw new VolumeError('no_data', 'xrpscan returned no account data');
    return result({ network: 'XRP Ledger', asset: 'XRP', balance: num(j.xrpBalance), firstSeen: iso(j.inception), source: 'xrpscan.com', explorer });
  };
  const viaRippled = async () => {
    const r = await getJson('https://xrplcluster.com/', { method: 'POST', body: { method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] } });
    const res = r?.result;
    if (res?.error === 'actNotFound') return result({ network: 'XRP Ledger', asset: 'XRP', balance: 0, source: 'xrplcluster.com', explorer, note: 'Account is not funded.' });
    if (!res?.account_data) throw new VolumeError(res?.error === 'slowDown' ? 'rate_limited' : 'rpc_error', `xrplcluster: ${res?.error || 'no data'}`);
    return result({ network: 'XRP Ledger', asset: 'XRP', balance: units(res.account_data.Balance, 6), source: 'xrplcluster.com', explorer });
  };
  return firstOf(viaXrpscan, viaRippled);
}

async function solRpc(method, params) {
  const j = await getJson('https://api.mainnet-beta.solana.com', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });
  // JSON-RPC errors arrive as HTTP 200; never read them as an empty account.
  if (j?.error) throw new VolumeError(/rate|too many/i.test(j.error.message || '') ? 'rate_limited' : 'rpc_error', `Solana RPC ${method}: ${j.error.message || 'error'}`);
  if (!j || !('result' in j)) throw new VolumeError('no_data', 'Solana RPC sent no result');
  return j.result;
}

async function solana(address) {
  const [bal, sigs, tokenAccts] = await Promise.all([
    solRpc('getBalance', [address]),
    solRpc('getSignaturesForAddress', [address, { limit: 1000 }]),
    solRpc('getTokenAccountsByOwner', [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]).catch(() => null),
  ]);
  const bySymbol = new Map();
  const stableAccounts = [];
  for (const acc of tokenAccts?.value || []) {
    const info = acc.account?.data?.parsed?.info;
    const symbol = SOL_MINTS[info?.mint];
    if (!symbol) continue;
    stableAccounts.push(acc.pubkey);
    bySymbol.set(symbol, (bySymbol.get(symbol) || 0) + (num(info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount) || 0));
  }
  // Incoming SPL transfers are signed against the token account, not the owner: merge those histories.
  const lists = [Array.isArray(sigs) ? sigs : []];
  for (const pk of stableAccounts.slice(0, 4)) {
    lists.push(await solRpc('getSignaturesForAddress', [pk, { limit: 1000 }]).catch(() => []));
  }
  const merged = new Map();
  for (const l of lists) for (const s of l || []) if (s?.signature) merged.set(s.signature, s.blockTime);
  const times = [...merged.values()].filter(Boolean).sort((x, y) => x - y);
  const partial = lists.some(l => (l || []).length >= 1000);
  return result({
    network: 'Solana', asset: 'SOL',
    balance: units(bal?.value ?? 0, 9),
    txCount: merged.size,
    txCountPartial: partial,
    partial,
    lastActivity: times.length ? iso(times[times.length - 1]) : null,
    firstSeen: times.length && !partial ? iso(times[0]) : null,
    tokens: [...bySymbol].map(([symbol, balance]) => ({ symbol, balance, received: null, sent: null })),
    source: 'solana.com RPC', explorer: `https://solscan.io/account/${address}`,
    note: 'Lifetime totals are not available from the public RPC.',
  });
}

async function cardano(address) {
  const [info, txs] = await Promise.all([
    getJson('https://api.koios.rest/api/v1/address_info', { method: 'POST', body: { _addresses: [address] } }),
    getJson('https://api.koios.rest/api/v1/address_txs', { method: 'POST', body: { _addresses: [address] } }).catch(() => null),
  ]);
  const a = Array.isArray(info) ? info[0] : null;
  const list = Array.isArray(txs) ? txs : null;
  const times = (list || []).map(t => t.block_time).filter(Boolean).sort((x, y) => x - y);
  return result({
    network: 'Cardano', asset: 'ADA',
    balance: units(a?.balance ?? 0, 6),
    txCount: list ? list.length : null,
    txCountPartial: !!list && list.length >= 1000,
    partial: !!list && list.length >= 1000,
    firstSeen: times.length && list.length < 1000 ? iso(times[0]) : null,
    lastActivity: times.length ? iso(times[times.length - 1]) : null,
    source: 'koios.rest', explorer: `https://cardanoscan.io/address/${address}`,
    note: list ? 'Lifetime totals are not available from this explorer.' : 'Transactions could not be loaded; only the balance is shown.',
  });
}

async function ton(address) {
  const id = address.replace(/\+/g, '-').replace(/\//g, '_'); // same 36 bytes, URL-safe
  const explorer = `https://tonviewer.com/${id}`;
  const viaTonapi = async () => {
    const j = await getJson(`https://tonapi.io/v2/accounts/${id}`);
    if (!j) throw new VolumeError('no_data', 'tonapi returned no account');
    return result({ network: 'TON', asset: 'TON', balance: units(j.balance ?? 0, 9), lastActivity: iso(j.last_activity), source: 'tonapi.io', explorer, note: j.status === 'nonexist' ? 'Account does not exist yet.' : null });
  };
  const viaToncenter = async () => {
    const j = await getJson(`https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(id)}`);
    if (!j?.ok || !j.result) throw new VolumeError('no_data', 'toncenter returned no account');
    return result({ network: 'TON', asset: 'TON', balance: units(j.result.balance ?? 0, 9), source: 'toncenter.com', explorer });
  };
  return firstOf(viaTonapi, viaToncenter);
}

// Try sources in order; the first success wins, otherwise the first error is reported.
async function firstOf(...fns) {
  let firstErr;
  for (const fn of fns) {
    try { return await fn(); } catch (e) { firstErr = firstErr || e; }
  }
  throw firstErr;
}

const ADAPTERS = {
  btc: a => firstOf(() => blockchainComBtc(a), () => esplora('https://mempool.space', 'Bitcoin', 'BTC', `https://mempool.space/address/${a}`, a), () => blockchair('bitcoin', 'Bitcoin', 'BTC', a)),
  ltc: a => firstOf(() => esplora('https://litecoinspace.org', 'Litecoin', 'LTC', `https://litecoinspace.org/address/${a}`, a), () => blockchair('litecoin', 'Litecoin', 'LTC', a)),
  doge: a => firstOf(() => blockcypher('doge', 'Dogecoin', 'DOGE', a), () => blockchair('dogecoin', 'Dogecoin', 'DOGE', a)),
  dash: a => firstOf(() => blockcypher('dash', 'Dash', 'DASH', a), () => blockchair('dash', 'Dash', 'DASH', a)),
  bch: a => firstOf(() => blockchainComBch(a), () => blockchair('bitcoin-cash', 'Bitcoin Cash', 'BCH', a.replace(/^bitcoincash:/, ''))),
  trx: tron,
  xrp,
  sol: solana,
  ada: cardano,
  ton,
};
// 0x addresses are checked on every EVM network above whatever their chain id; 'avax' is left out
// because it also names Avalanche X-Chain addresses, which have no explorer here.
const EVM_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'op', 'base'];
export const SUPPORTED = new Set([...Object.keys(ADAPTERS), ...EVM_CHAINS]);

const errorOf = (network, e) => ({ network, code: e?.code || 'error', message: e?.message || String(e), retryAt: e?.retryAt });

// One wallet -> { chain, address, networks: [result...], errors: [{network, code, message, retryAt}], checked, at }.
// A 0x address is checked on every supported EVM network (or only those named in `only`);
// only networks with activity are kept.
export async function walletVolume(chain, address, { only } = {}) {
  const at = new Date().toISOString();
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const all = evmNetworks();
    const nets = only ? all.filter(n => only.includes(n.network)) : all;
    const settled = await Promise.allSettled(nets.map(n => evmNetwork(n, address)));
    const networks = [], errors = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') { if (hasActivity(s.value)) networks.push(s.value); }
      else errors.push(errorOf(nets[i].network, s.reason));
    });
    const checked = nets.filter((_, i) => settled[i].status === 'fulfilled').map(n => n.network);
    return { chain, address, networks, errors, checked, at };
  }
  const adapter = Object.prototype.hasOwnProperty.call(ADAPTERS, chain) ? ADAPTERS[chain] : null;
  if (!adapter) return { chain, address, networks: [], errors: [{ network: chain, code: 'unsupported', message: 'No explorer for this chain' }], checked: [], at };
  try {
    const r = await adapter(address);
    return { chain, address, networks: [r], errors: [], checked: [r.network], at };
  } catch (e) {
    return { chain, address, networks: [], errors: [errorOf(chain, e)], checked: [], at };
  }
}

export function hasActivity(r) {
  return !!(r.txCount > 0 || r.tokenTransfers > 0 || r.balance > 0 || r.received > 0 || r.sent > 0 || r.lastActivity
    || r.tokens?.some(t => t.balance > 0 || t.received > 0 || t.sent > 0));
}

// ---------- USD estimate ----------

export async function usdPrices(assets) {
  const ids = [...new Set(assets.map(a => PRICE_IDS[a]).filter(Boolean))];
  if (!ids.length) return {};
  const j = await getJson(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`);
  const out = {};
  for (const [asset, id] of Object.entries(PRICE_IDS)) if (j?.[id]?.usd) out[asset] = j[id].usd;
  return out;
}

// Adds usd estimates in place: received/balance of the native asset at today's price, stablecoins at $1.
// usdPartial marks a total that is only a lower bound (capped histories or failed pages): a network's
// `partial` covers its native figures, a token's `partial` covers that token's in and out.
export function addUsd(vol, prices) {
  const missing = new Set();
  for (const r of vol.networks) {
    const p = prices[r.asset];
    if (!p && ((r.received || 0) > 0 || (r.sent || 0) > 0 || (r.balance || 0) > 0)) missing.add(r.asset);
    r.usdReceived = p && r.received !== null ? r.received * p : null;
    r.usdSent = p && r.sent !== null ? r.sent * p : null;
    r.usdBalance = p && r.balance !== null ? r.balance * p : null;
    const stableIn = r.tokens.reduce((s, t) => s + (t.received || 0), 0);
    const stableOut = r.tokens.reduce((s, t) => s + (t.sent || 0), 0);
    const stableBal = r.tokens.reduce((s, t) => s + (t.balance || 0), 0);
    if (stableIn) r.usdReceived = (r.usdReceived || 0) + stableIn;
    if (stableOut) r.usdSent = (r.usdSent || 0) + stableOut;
    if (stableBal) r.usdBalance = (r.usdBalance || 0) + stableBal;
  }
  const total = key => (vol.networks.some(r => r[key] !== null && r[key] !== undefined) ? vol.networks.reduce((s, r) => s + (r[key] || 0), 0) : null);
  vol.usdReceived = total('usdReceived');
  vol.usdSent = total('usdSent');
  vol.usdPartial = vol.networks.some(r => r.partial || r.tokens.some(t => t.partial));
  vol.usdMissing = [...missing]; // assets with flows but no price: their part is not in the USD totals
  vol.pricesAt = new Date().toISOString();
  return vol;
}

// ---------- wallet insights ----------

// A wallet this busy or this big is more likely an exchange or payment service than the scammer's
// own wallet. Both limits are in Settings (0 turns one off). Explorer name tags (Tronscan) count too,
// unless the tag itself says scam.
export const EXCHANGE_TXS = 1000;
export const EXCHANGE_USD = 1e6;
const RISK_TAG = /scam|fraud|phish|hack|exploit|stolen|drain|ponzi|sanction|theft|heist|fake/i;

// Wallet-level summary of the per-network analysis; run after addUsd() (it reads the USD figures).
// Safe to run again, e.g. when the limits change.
//   txCount:  transactions summed over networks (null when no network had a count); txCountPartial
//             when a count is only a lower bound
//   service:  likely exchange: { reasons: [{ kind: 'tag', label, source }
//             | { kind: 'tx_count', value, partial } | { kind: 'received_usd' | 'balance_usd', value }] } or null
//   tags:     explorer name tags, with `risky` for the ones that say scam/phishing/...
//   senders:  distinct senders, summed over networks (null when no network had a transfer list)
//   poisoning: [{ fake, real, network }]
export function walletInsights(vol, { txs = EXCHANGE_TXS, usd = EXCHANGE_USD } = {}) {
  const nets = vol.networks || [];
  const tags = nets.filter(n => n.label).map(n => ({ label: n.label, source: n.source, network: n.network, risky: RISK_TAG.test(n.label) }));
  const reasons = tags.filter(t => !t.risky).map(t => ({ kind: 'tag', label: t.label, source: t.source }));
  const withCount = nets.filter(n => Number.isFinite(n.txCount));
  vol.txCount = withCount.length ? withCount.reduce((s, n) => s + n.txCount, 0) : null;
  vol.txCountPartial = withCount.some(n => n.txCountPartial);
  // A lower-bound count past the limit counts; one below it proves nothing either way.
  if (txs > 0 && vol.txCount >= txs) reasons.push({ kind: 'tx_count', value: vol.txCount, partial: vol.txCountPartial });
  const held = nets.reduce((s, n) => s + (n.usdBalance || 0), 0);
  if (usd > 0 && (vol.usdReceived || 0) >= usd) reasons.push({ kind: 'received_usd', value: vol.usdReceived });
  else if (usd > 0 && held >= usd) reasons.push({ kind: 'balance_usd', value: held });
  vol.service = reasons.length ? { reasons } : null;
  vol.tags = tags;
  const counted = nets.filter(n => Number.isFinite(n.senders));
  vol.senders = counted.length ? counted.reduce((s, n) => s + n.senders, 0) : null;
  vol.sendersPartial = counted.some(n => n.sendersPartial);
  vol.poisoning = nets.flatMap(n => (n.poisoning || []).map(p => ({ ...p, network: n.network })));
  return vol;
}
