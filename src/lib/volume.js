// On-chain money flow for a wallet, read from public block explorers (no API keys).
// The hub has no on-chain endpoint, so these calls go straight from the background worker to
// each explorer. Every adapter returns the same shape (see `result()`); missing figures are null.
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
//   sol   Solana public RPC (+ USDT/USDC balances)
//   ada   koios
//   ton   tonapi                   -> toncenter

export const USDT_TRC20 = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const SOL_MINTS = { Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT', EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC' };
const STABLES = new Set(['USDT', 'USDC', 'DAI', 'BUSD', 'FDUSD', 'TUSD', 'USDD']);
const TRC20_PAGES = 5; // up to 1,000 transfers each way, then the total is marked partial

// CoinGecko ids for the native asset of each network, for the USD estimate.
const PRICE_IDS = {
  BTC: 'bitcoin', LTC: 'litecoin', DOGE: 'dogecoin', DASH: 'dash', BCH: 'bitcoin-cash', ETH: 'ethereum',
  BNB: 'binancecoin', POL: 'polygon-ecosystem-token', TRX: 'tron', XRP: 'ripple', SOL: 'solana', ADA: 'cardano', TON: 'the-open-network',
};

// ---------- polite per-host fetching ----------

const HOST_GAP_MS = {
  'mempool.space': 250, 'litecoinspace.org': 250, 'api.blockcypher.com': 400, 'api.blockchair.com': 1100,
  'api.ethplorer.io': 600, 'api.binplorer.com': 600, 'api.trongrid.io': 350, 'api.xrpscan.com': 300,
  'xrplcluster.com': 300, 'api.mainnet-beta.solana.com': 300, 'api.koios.rest': 300, 'tonapi.io': 1100,
  'toncenter.com': 1100, 'api.coingecko.com': 2500,
};
const nextSlot = new Map();
const blockedUntil = new Map();

export class VolumeError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function getJson(url, { method = 'GET', body, timeoutMs = 15000 } = {}) {
  const host = new URL(url).host;
  const blocked = (blockedUntil.get(host) || 0) - Date.now();
  if (blocked > 0) throw new VolumeError('rate_limited', `${host} asked us to slow down; try again in ${Math.ceil(blocked / 1000)} s`);
  const gap = HOST_GAP_MS[host] ?? 300;
  const now = Date.now();
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + gap);
  if (at > now) await new Promise(r => setTimeout(r, at - now));

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
  if (res.status === 429) {
    const wait = (Number(res.headers.get('retry-after')) || 60) * 1000;
    blockedUntil.set(host, Date.now() + wait);
    throw new VolumeError('rate_limited', `${host} rate limit reached`);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new VolumeError('http_' + res.status, `${host} answered HTTP ${res.status}`);
  try { return await res.json(); } catch { throw new VolumeError('bad_json', `${host} sent an unreadable answer`); }
}

// ---------- shared helpers ----------

// Integer base units (string, number or BigInt) -> decimal number of whole coins.
export function units(raw, decimals) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') return raw / 10 ** decimals;
  let s = String(raw).trim();
  if (!/^-?\d+$/.test(s)) { const n = Number(s); return Number.isFinite(n) ? n / 10 ** decimals : null; }
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  const whole = s.length > decimals ? s.slice(0, s.length - decimals) : '0';
  const frac = s.padStart(decimals + 1, '0').slice(-decimals) || '0';
  const n = Number(`${whole}.${frac}`);
  return neg ? -n : n;
}

const iso = v => {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  const d = new Date(/^\d{4}-\d\d-\d\d \d/.test(v) ? v.replace(' ', 'T') + 'Z' : v);
  return isNaN(d) ? null : d.toISOString();
};
const latest = (...dates) => dates.filter(Boolean).sort().pop() || null;
const num = v => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

function result(fields) {
  return {
    network: null, asset: null, received: null, sent: null, balance: null, txCount: null,
    firstSeen: null, lastActivity: null, tokens: [], source: null, explorer: null, partial: false, note: null,
    ...fields,
  };
}

// ---------- adapters ----------

// mempool.space-style (Esplora) API: btc and ltc.
async function esplora(base, network, asset, explorer, address) {
  const a = await getJson(`${base}/api/address/${address}`);
  if (!a) return result({ network, asset, received: 0, sent: 0, balance: 0, txCount: 0, source: new URL(base).host, explorer });
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
  return result({ network, asset, received: funded / 1e8, sent: spent / 1e8, balance: (funded - spent) / 1e8, txCount, lastActivity, source: new URL(base).host, explorer });
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
    source: 'blockchair.com', explorer: `https://blockchair.com/${slug}/address/${address}`,
  });
}

async function blockcypher(coin, network, asset, address) {
  const j = await getJson(`https://api.blockcypher.com/v1/${coin}/main/addrs/${address}?limit=1`);
  if (!j) return result({ network, asset, received: 0, sent: 0, balance: 0, txCount: 0, source: 'blockcypher.com' });
  return result({
    network, asset,
    received: units(j.total_received, 8), sent: units(j.total_sent, 8),
    balance: units((j.final_balance ?? j.balance), 8),
    txCount: num(j.final_n_tx ?? j.n_tx),
    lastActivity: latest(iso(j.txrefs?.[0]?.confirmed), j.unconfirmed_txrefs?.length ? new Date().toISOString() : null),
    source: 'blockcypher.com', explorer: `https://live.blockcypher.com/${coin}/address/${address}/`,
  });
}

// Ethplorer-style API (Ethereum: ethplorer.io, BNB Chain: binplorer.com). Gives native totals in and out.
async function ethplorer(host, network, asset, explorerBase, address) {
  const j = await getJson(`https://${host}/getAddressInfo/${address}?apiKey=freekey&showETHTotals=true`);
  if (!j || j.error) throw new VolumeError('no_data', j?.error?.message || `${host} returned no data`);
  const tokens = (j.tokens || [])
    .filter(t => STABLES.has(String(t.tokenInfo?.symbol || '').toUpperCase()))
    .map(t => {
      const dec = Number(t.tokenInfo.decimals) || 0;
      return {
        symbol: t.tokenInfo.symbol.toUpperCase(),
        balance: units(t.rawBalance ?? t.balance, dec),
        received: t.totalIn !== undefined ? units(t.totalIn, dec) : null,
        sent: t.totalOut !== undefined ? units(t.totalOut, dec) : null,
      };
    });
  const e = j.ETH || {};
  const last = await getJson(`https://${host}/getAddressTransactions/${address}?apiKey=freekey&limit=1`).catch(() => null);
  return result({
    network, asset,
    received: num(e.totalIn), sent: num(e.totalOut), balance: num(e.balance),
    txCount: num(j.countTxs),
    lastActivity: Array.isArray(last) && last[0] ? iso(last[0].timestamp) : null,
    tokens, source: host.replace(/^api\./, ''), explorer: `${explorerBase}${address}`,
  });
}

// Blockscout v2: balance, transaction count and stablecoin balances (no lifetime totals).
async function blockscout(host, network, asset, explorerBase, address) {
  const a = await getJson(`https://${host}/api/v2/addresses/${address}`);
  if (!a) return result({ network, asset, balance: 0, txCount: 0, source: host, explorer: `${explorerBase}${address}` });
  const [counters, tokenBalances] = await Promise.all([
    getJson(`https://${host}/api/v2/addresses/${address}/counters`).catch(() => null),
    getJson(`https://${host}/api/v2/addresses/${address}/token-balances`).catch(() => null),
  ]);
  const tokens = (Array.isArray(tokenBalances) ? tokenBalances : [])
    .filter(t => STABLES.has(String(t.token?.symbol || '').toUpperCase()))
    .map(t => ({ symbol: t.token.symbol.toUpperCase(), balance: units(t.value, Number(t.token.decimals) || 0), received: null, sent: null }));
  return result({
    network, asset,
    balance: units(a.coin_balance, 18),
    txCount: num(counters?.transactions_count),
    tokens, source: host, explorer: `${explorerBase}${address}`,
    note: 'Lifetime totals are not available from this explorer.',
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

// Sum TRC20 transfers of one token, one direction, following TronGrid's pagination.
async function trc20Total(address, contract, direction) {
  let url = `https://api.trongrid.io/v1/accounts/${address}/transactions/trc20?${direction}=true&contract_address=${contract}&limit=200`;
  let total = 0, count = 0, partial = false, lastTs = null;
  for (let page = 0; page < TRC20_PAGES && url; page++) {
    const j = await getJson(url);
    for (const t of j?.data || []) {
      total += units(t.value, Number(t.token_info?.decimals ?? 6)) || 0;
      count++;
      if (!lastTs || t.block_timestamp > lastTs) lastTs = t.block_timestamp;
    }
    url = j?.meta?.links?.next || null;
    if (url && page === TRC20_PAGES - 1) partial = true;
  }
  return { total, count, partial, lastTs };
}

async function tron(address) {
  const j = await getJson(`https://api.trongrid.io/v1/accounts/${address}`);
  const acct = j?.data?.[0];
  const explorer = `https://tronscan.org/#/address/${address}`;
  if (!acct) {
    return result({ network: 'Tron', asset: 'TRX', balance: 0, source: 'trongrid.io', explorer, note: 'Account has never been activated.' });
  }
  const usdtBal = (acct.trc20 || []).map(o => o[USDT_TRC20]).find(v => v !== undefined);
  const [inn, out] = await Promise.all([
    trc20Total(address, USDT_TRC20, 'only_to'),
    trc20Total(address, USDT_TRC20, 'only_from'),
  ]);
  return result({
    network: 'Tron', asset: 'TRX',
    balance: units(acct.balance ?? 0, 6),
    firstSeen: iso(acct.create_time),
    lastActivity: latest(iso(acct.latest_opration_time), iso(inn.lastTs), iso(out.lastTs)),
    tokens: [{ symbol: 'USDT', balance: units(usdtBal ?? 0, 6), received: inn.total, sent: out.total, transfersIn: inn.count, transfersOut: out.count }],
    partial: inn.partial || out.partial,
    source: 'trongrid.io', explorer,
    note: 'TRX lifetime totals are not available; USDT-TRC20 totals are summed from transfers.',
  });
}

async function xrp(address) {
  const explorer = `https://xrpscan.com/account/${address}`;
  try {
    const j = await getJson(`https://api.xrpscan.com/api/v1/account/${address}`);
    if (j && (j.xrpBalance !== undefined || j.account)) {
      return result({ network: 'XRP Ledger', asset: 'XRP', balance: num(j.xrpBalance), firstSeen: iso(j.inception), source: 'xrpscan.com', explorer });
    }
  } catch (e) { if (e.code === 'rate_limited') throw e; }
  const r = await getJson('https://xrplcluster.com/', { method: 'POST', body: { method: 'account_info', params: [{ account: address, ledger_index: 'validated' }] } });
  const ad = r?.result?.account_data;
  if (!ad) return result({ network: 'XRP Ledger', asset: 'XRP', balance: 0, source: 'xrplcluster.com', explorer, note: 'Account is not funded.' });
  return result({ network: 'XRP Ledger', asset: 'XRP', balance: units(ad.Balance, 6), source: 'xrplcluster.com', explorer });
}

const solRpc = (method, params) => getJson('https://api.mainnet-beta.solana.com', { method: 'POST', body: { jsonrpc: '2.0', id: 1, method, params } });

async function solana(address) {
  const [bal, sigs, tokenAccts] = await Promise.all([
    solRpc('getBalance', [address]),
    solRpc('getSignaturesForAddress', [address, { limit: 1000 }]),
    solRpc('getTokenAccountsByOwner', [address, { programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' }, { encoding: 'jsonParsed' }]).catch(() => null),
  ]);
  const list = Array.isArray(sigs?.result) ? sigs.result : [];
  const tokens = [];
  for (const acc of tokenAccts?.result?.value || []) {
    const info = acc.account?.data?.parsed?.info;
    const symbol = SOL_MINTS[info?.mint];
    if (symbol) tokens.push({ symbol, balance: num(info.tokenAmount?.uiAmountString ?? info.tokenAmount?.uiAmount), received: null, sent: null });
  }
  return result({
    network: 'Solana', asset: 'SOL',
    balance: units(bal?.result?.value ?? 0, 9),
    txCount: list.length,
    partial: list.length >= 1000,
    lastActivity: list[0]?.blockTime ? iso(list[0].blockTime) : null,
    firstSeen: list.length && list.length < 1000 && list[list.length - 1].blockTime ? iso(list[list.length - 1].blockTime) : null,
    tokens, source: 'solana.com RPC', explorer: `https://solscan.io/account/${address}`,
    note: 'Lifetime totals are not available from the public RPC.',
  });
}

async function cardano(address) {
  const [info, txs] = await Promise.all([
    getJson('https://api.koios.rest/api/v1/address_info', { method: 'POST', body: { _addresses: [address] } }),
    getJson('https://api.koios.rest/api/v1/address_txs', { method: 'POST', body: { _addresses: [address] } }).catch(() => null),
  ]);
  const a = Array.isArray(info) ? info[0] : null;
  const list = Array.isArray(txs) ? txs : [];
  const times = list.map(t => t.block_time).filter(Boolean).sort((x, y) => x - y);
  return result({
    network: 'Cardano', asset: 'ADA',
    balance: units(a?.balance ?? 0, 6),
    txCount: list.length,
    partial: list.length >= 1000,
    firstSeen: times.length && list.length < 1000 ? iso(times[0]) : null,
    lastActivity: times.length ? iso(times[times.length - 1]) : null,
    source: 'koios.rest', explorer: `https://cardanoscan.io/address/${address}`,
    note: 'Lifetime totals are not available from this explorer.',
  });
}

async function ton(address) {
  const explorer = `https://tonviewer.com/${address}`;
  try {
    const j = await getJson(`https://tonapi.io/v2/accounts/${encodeURIComponent(address)}`);
    if (j) return result({ network: 'TON', asset: 'TON', balance: units(j.balance ?? 0, 9), lastActivity: iso(j.last_activity), source: 'tonapi.io', explorer, note: j.status === 'nonexist' ? 'Account does not exist yet.' : null });
  } catch (e) { if (e.code === 'rate_limited') throw e; }
  const j = await getJson(`https://toncenter.com/api/v2/getAddressInformation?address=${encodeURIComponent(address)}`);
  return result({ network: 'TON', asset: 'TON', balance: units(j?.result?.balance ?? 0, 9), source: 'toncenter.com', explorer });
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
export const SUPPORTED = new Set([...Object.keys(ADAPTERS), 'eth', 'bsc', 'matic', 'arb', 'op', 'base', 'avax']);

const EVM = new Set(['eth', 'bsc', 'matic', 'arb', 'op', 'base', 'avax']);

// One wallet -> { chain, address, networks: [result...], errors: [{network, code, message}], at }.
// A 0x address is checked on every supported EVM network; only networks with activity are kept.
export async function walletVolume(chain, address) {
  const at = new Date().toISOString();
  if (EVM.has(chain) || /^0x[0-9a-fA-F]{40}$/.test(address)) {
    const settled = await Promise.allSettled(EVM_NETWORKS.map(n => n.run(address)));
    const networks = [], errors = [];
    settled.forEach((s, i) => {
      if (s.status === 'fulfilled') { if (hasActivity(s.value)) networks.push(s.value); }
      else errors.push({ network: EVM_NETWORKS[i].network, code: s.reason?.code || 'error', message: s.reason?.message || String(s.reason) });
    });
    const checked = EVM_NETWORKS.filter((_, i) => settled[i].status === 'fulfilled').map(n => n.network);
    return { chain, address, networks, errors, checked, at };
  }
  const adapter = ADAPTERS[chain];
  if (!adapter) return { chain, address, networks: [], errors: [{ network: chain, code: 'unsupported', message: 'No explorer for this chain' }], checked: [], at };
  try {
    const r = await adapter(address);
    return { chain, address, networks: [r], errors: [], checked: [r.network], at };
  } catch (e) {
    return { chain, address, networks: [], errors: [{ network: chain, code: e.code || 'error', message: e.message || String(e) }], checked: [], at };
  }
}

export function hasActivity(r) {
  return !!((r.txCount && r.txCount > 0) || (r.balance && r.balance > 0) || (r.received && r.received > 0)
    || r.tokens?.some(t => (t.balance && t.balance > 0) || (t.received && t.received > 0)));
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
  vol.pricesAt = new Date().toISOString();
  return vol;
}
