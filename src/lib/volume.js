// On-chain money flow for a wallet, read from public block explorers (no API keys).
// The hub has no on-chain endpoint, so these calls go straight from the background worker to
// each explorer. Every adapter returns the same shape (see `result()`); missing figures are null,
// and an explorer failure is an error, never a silent zero.
//
// Sources (first that answers wins):
//   btc   mempool.space            -> blockchair
//   ltc   litecoinspace.org        -> blockchair
//   doge  blockcypher              -> blockchair
//   dash  blockcypher              -> blockchair
//   bch   blockchair
//   0x…   ethplorer (Ethereum), binplorer (BNB Chain), blockscout (Polygon, Arbitrum, Optimism, Base)
//   trx   trongrid (+ USDT-TRC20 transfer totals)
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
};
const stableSymbol = (network, contract) => STABLES[network]?.[String(contract || '').toLowerCase()] || null;

// CoinGecko ids for the native asset of each network, for the USD estimate.
const PRICE_IDS = {
  BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', DASH: 'dash', BCH: 'bitcoin-cash', ETH: 'ethereum',
  BNB: 'binancecoin', POL: 'polygon-ecosystem-token', TRX: 'tron', XRP: 'ripple', SOL: 'solana', ADA: 'cardano', TON: 'the-open-network',
};

const GROSS_NOTE = 'Received is gross: it includes change sent back to the same address.';

// ---------- polite per-host fetching ----------

const HOST_GAP_MS = {
  'mempool.space': 250, 'litecoinspace.org': 250, 'api.blockcypher.com': 400, 'api.blockchair.com': 2000,
  'api.ethplorer.io': 600, 'api.binplorer.com': 600, 'api.trongrid.io': 350, 'api.xrpscan.com': 300,
  'xrplcluster.com': 300, 'api.mainnet-beta.solana.com': 300, 'api.koios.rest': 300, 'tonapi.io': 1100,
  'toncenter.com': 1100, 'api.coingecko.com': 2500,
};
// Statuses some explorers use for "slow down" besides 429.
const LIMIT_STATUS = { 'api.blockchair.com': [402, 430, 434, 435], 'api.trongrid.io': [403] };
const nextSlot = new Map();
const blockedUntil = new Map();

export class VolumeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function checkBlocked(host) {
  const blocked = (blockedUntil.get(host) || 0) - Date.now();
  if (blocked > 0) throw new VolumeError('rate_limited', `${host} asked us to slow down; try again in ${Math.ceil(blocked / 1000)} s`);
}

async function getJson(url, { method = 'GET', body, timeoutMs = 15000 } = {}) {
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
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
    blockedUntil.set(host, Date.now() + secs * 1000);
    throw new VolumeError('rate_limited', `${host} rate limit reached`);
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
    network: null, asset: null, received: null, sent: null, balance: null, txCount: null, tokenTransfers: null,
    firstSeen: null, lastActivity: null, tokens: [], source: null, explorer: null, partial: false, note: null,
    ...fields,
  };
}

// ---------- adapters ----------

// mempool.space-style (Esplora) API: btc and ltc.
async function esplora(base, network, asset, explorer, address) {
  const source = new URL(base).host;
  const a = await getJson(`${base}/api/address/${address}`);
  if (!a) return result({ network, asset, received: 0, sent: 0, balance: 0, txCount: 0, source, explorer });
  const c = a.chain_stats || {}, m = a.mempool_stats || {};
  const funded = (c.funded_txo_sum || 0) + (m.funded_txo_sum || 0);
  const spent = (c.spent_txo_sum || 0) + (m.spent_txo_sum || 0);
  const txCount = (c.tx_count || 0) + (m.tx_count || 0);
  let lastActivity = null;
  if (txCount) {
    const txs = await getJson(`${base}/api/address/${address}/txs`).catch(() => null);
    const t = Array.isArray(txs) && txs[0];
    if (t) lastActivity = t.status?.confirmed ? iso(t.status.block_time) : new Date().toISOString();
  }
  return result({ network, asset, received: funded / 1e8, sent: spent / 1e8, balance: (funded - spent) / 1e8, txCount, lastActivity, source, explorer, note: GROSS_NOTE });
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

// Ethplorer-style API (Ethereum: ethplorer.io, BNB Chain: binplorer.com). Gives native totals in and out.
async function ethplorer(host, network, asset, explorerBase, address) {
  const q = `apiKey=freekey`;
  const j = await getJson(`https://${host}/getAddressInfo/${address}?${q}&showETHTotals=true`);
  if (!j || j.error) throw new VolumeError('no_data', j?.error?.message || `${host} returned no data`);
  const tokens = [];
  for (const t of j.tokens || []) {
    const symbol = stableSymbol(network, t.tokenInfo?.address);
    const dec = decimalsOf(t.tokenInfo?.decimals);
    if (!symbol || dec === null) continue;
    const balance = units(t.rawBalance ?? t.balance, dec);
    let received = t.totalIn !== undefined ? units(t.totalIn, dec) : null;
    let sent = t.totalOut !== undefined ? units(t.totalOut, dec) : null;
    // Lifetime inflow can never be below the current balance; if it is, the totals were already
    // in whole tokens rather than base units.
    if (received !== null && balance > 0 && received < balance) { received = num(t.totalIn); sent = num(t.totalOut); }
    tokens.push({ symbol, balance, received, sent });
  }
  const e = j.ETH || j.BNB || {};
  const [nativeTx, tokenOps] = await Promise.all([
    getJson(`https://${host}/getAddressTransactions/${address}?${q}&limit=1&showZeroValues=1`).catch(() => null),
    getJson(`https://${host}/getAddressHistory/${address}?${q}&limit=1`).catch(() => null),
  ]);
  return result({
    network, asset,
    received: num(e.totalIn), sent: num(e.totalOut), balance: num(e.balance),
    txCount: num(j.countTxs),
    lastActivity: latest(Array.isArray(nativeTx) && nativeTx[0] ? iso(nativeTx[0].timestamp) : null, iso(tokenOps?.operations?.[0]?.timestamp)),
    tokens, source: host.replace(/^api\./, ''), explorer: `${explorerBase}${address}`,
    note: e.balance === undefined ? `${host} did not report the native ${asset} figures.` : null,
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

const EVM_NETWORKS = [
  { network: 'Ethereum', run: a => ethplorer('api.ethplorer.io', 'Ethereum', 'ETH', 'https://etherscan.io/address/', a) },
  { network: 'BNB Chain', run: a => ethplorer('api.binplorer.com', 'BNB Chain', 'BNB', 'https://bscscan.com/address/', a) },
  { network: 'Polygon', run: a => blockscout('polygon.blockscout.com', 'Polygon', 'POL', 'https://polygonscan.com/address/', a) },
  { network: 'Arbitrum', run: a => blockscout('arbitrum.blockscout.com', 'Arbitrum', 'ETH', 'https://arbiscan.io/address/', a) },
  { network: 'Optimism', run: a => blockscout('optimism.blockscout.com', 'Optimism', 'ETH', 'https://optimistic.etherscan.io/address/', a) },
  { network: 'Base', run: a => blockscout('base.blockscout.com', 'Base', 'ETH', 'https://basescan.org/address/', a) },
];

// Sum one token's TRC20 transfers in one direction, following TronGrid's pagination. Never throws:
// a failed page ends the sum early and marks it partial.
async function trc20Total(address, contract, direction) {
  let url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${direction}=true&contract_address=${contract}&limit=200`;
  let total = 0, count = 0, partial = false, lastTs = null, firstTs = null, error = null;
  for (let page = 0; page < TRC20_PAGES && url; page++) {
    let j;
    try { j = await getJson(url); } catch (e) { error = e; partial = true; break; }
    for (const t of j?.data || []) {
      // The endpoint also returns Approval events (often 2^256-1); only count real transfers.
      if (t.type && t.type !== 'Transfer') continue;
      if (t.token_info?.address && t.token_info.address !== contract) continue;
      total += units(t.value, decimalsOf(t.token_info?.decimals) ?? 6) || 0;
      count++;
      if (!lastTs || t.block_timestamp > lastTs) lastTs = t.block_timestamp;
      if (!firstTs || t.block_timestamp < firstTs) firstTs = t.block_timestamp;
    }
    url = j?.meta?.links?.next || null;
    if (url && page === TRC20_PAGES - 1) partial = true;
  }
  return { total, count, partial, lastTs, firstTs, error };
}

async function tron(address) {
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
      received: inn.total, sent: out.total, transfersIn: inn.count, transfersOut: out.count,
    }] : [],
    partial,
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
  btc: a => firstOf(() => esplora('https://mempool.space', 'Bitcoin', 'BTC', `https://mempool.space/address/${a}`, a), () => blockchair('bitcoin', 'Bitcoin', 'BTC', a)),
  ltc: a => firstOf(() => esplora('https://litecoinspace.org', 'Litecoin', 'LTC', `https://litecoinspace.org/address/${a}`, a), () => blockchair('litecoin', 'Litecoin', 'LTC', a)),
  doge: a => firstOf(() => blockcypher('doge', 'Dogecoin', 'DOGE', a), () => blockchair('dogecoin', 'Dogecoin', 'DOGE', a)),
  dash: a => firstOf(() => blockcypher('dash', 'Dash', 'DASH', a), () => blockchair('dash', 'Dash', 'DASH', a)),
  bch: a => blockchair('bitcoin-cash', 'Bitcoin Cash', 'BCH', a.replace(/^bitcoincash:/, '')),
  trx: tron,
  xrp,
  sol: solana,
  ada: cardano,
  ton,
};
const EVM_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'op', 'base']; // no keyless Avalanche source yet
export const SUPPORTED = new Set([...Object.keys(ADAPTERS), ...EVM_CHAINS]);

// One wallet -> { chain, address, networks: [result...], errors: [{network, code, message}], checked, at }.
// A 0x address is checked on every supported EVM network; only networks with activity are kept.
export async function walletVolume(chain, address) {
  const at = new Date().toISOString();
  if (/^0x[0-9a-fA-F]{40}$/.test(address)) {
    const settled = await Promise.allSettled(EVM_NETWORKS.map(n => n.run(address)));
    const networks = [], errors = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') { if (hasActivity(s.value)) networks.push(s.value); }
      else errors.push({ network: EVM_NETWORKS[i].network, code: s.reason?.code || 'error', message: s.reason?.message || String(s.reason) });
    });
    const checked = EVM_NETWORKS.filter((_, i) => settled[i].status === 'fulfilled').map(n => n.network);
    return { chain, address, networks, errors, checked, at };
  }
  const adapter = Object.prototype.hasOwnProperty.call(ADAPTERS, chain) ? ADAPTERS[chain] : null;
  if (!adapter) return { chain, address, networks: [], errors: [{ network: chain, code: 'unsupported', message: 'No explorer for this chain' }], checked: [], at };
  try {
    const r = await adapter(address);
    return { chain, address, networks: [r], errors: [], checked: [r.network], at };
  } catch (e) {
    return { chain, address, networks: [], errors: [{ network: chain, code: e.code || 'error', message: e.message || String(e) }], checked: [], at };
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
// usdPartial marks a total that is only a lower bound (capped histories or failed pages).
export function addUsd(vol, prices) {
  for (const r of vol.networks) {
    const p = prices[r.asset];
    r.usdReceived = p && r.received !== null ? r.received * p : null;
    r.usdBalance = p && r.balance !== null ? r.balance * p : null;
    const stableIn = r.tokens.reduce((s, t) => s + (t.received || 0), 0);
    const stableBal = r.tokens.reduce((s, t) => s + (t.balance || 0), 0);
    if (stableIn) r.usdReceived = (r.usdReceived || 0) + stableIn;
    if (stableBal) r.usdBalance = (r.usdBalance || 0) + stableBal;
  }
  vol.usdReceived = vol.networks.some(r => r.usdReceived !== null && r.usdReceived !== undefined)
    ? vol.networks.reduce((s, r) => s + (r.usdReceived || 0), 0) : null;
  vol.usdPartial = vol.networks.some(r => r.partial);
  vol.pricesAt = new Date().toISOString();
  return vol;
}
