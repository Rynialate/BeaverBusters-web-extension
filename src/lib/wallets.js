// Wallet chain detection and checksum validation.
//
// A JavaScript port of the ScamHunt CTF validator as published in
// benpinpop/urlscan-dashboard (wallet_validation/codecs.py + wallets.py, incl. its XRP addition).
// Rules, error wording and canonical forms follow that code so results match it address for address.
// Additions beyond it, for chains the hub accepts: Base (EVM), Solana and TON.
//
// Plain script (no import/export) so the same file runs as a content script and is imported
// for its side effect by the background and popup modules. Everything is synchronous.
(() => {
  // ------------------------------------------------------------------ SHA-256

  const K256 = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);

  function sha256(data) {
    const len = data.length;
    const total = ((len + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(total);
    buf.set(data);
    buf[len] = 0x80;
    const bits = len * 8;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, Math.floor(bits / 0x100000000));
    dv.setUint32(total - 4, bits >>> 0);
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const w = new Uint32Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const t1 = (hh + S1 + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, h[i]);
    return out;
  }
  const doubleSha256 = data => sha256(sha256(data));

  // -------------------------------------------------------------- Keccak-256
  // Ethereum's Keccak (0x01 padding, not NIST SHA3's 0x06). 64-bit lanes as BigInt.

  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
    0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
    0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
    0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
    0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [[0, 36, 3, 41, 18], [1, 44, 10, 45, 2], [62, 6, 43, 15, 61], [28, 55, 25, 21, 56], [27, 20, 39, 8, 14]];
  const M64 = (1n << 64n) - 1n;
  const rol64 = (v, s) => (s ? ((v << BigInt(s)) | (v >> BigInt(64 - s))) & M64 : v);

  function keccakF(a) {
    for (const rc of RC) {
      const c = [0, 1, 2, 3, 4].map(x => a[x][0] ^ a[x][1] ^ a[x][2] ^ a[x][3] ^ a[x][4]);
      const d = [0, 1, 2, 3, 4].map(x => c[(x + 4) % 5] ^ rol64(c[(x + 1) % 5], 1));
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] ^= d[x];
      const b = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y][(2 * x + 3 * y) % 5] = rol64(a[x][y], ROT[x][y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) a[x][y] = b[x][y] ^ ((~b[(x + 1) % 5][y] & M64) & b[(x + 2) % 5][y]);
      a[0][0] ^= rc;
    }
  }

  function keccak256(data) {
    const rate = 136;
    const padLen = rate - (data.length % rate);
    const padded = new Uint8Array(data.length + padLen);
    padded.set(data);
    padded[data.length] = 0x01;
    padded[padded.length - 1] |= 0x80;
    const a = [0, 1, 2, 3, 4].map(() => [0n, 0n, 0n, 0n, 0n]);
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let j = 7; j >= 0; j--) lane = (lane << 8n) | BigInt(padded[off + 8 * i + j]);
        a[i % 5][Math.floor(i / 5)] ^= lane;
      }
      keccakF(a);
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 4; i++) {
      let lane = a[i % 5][Math.floor(i / 5)];
      for (let j = 0; j < 8; j++) { out[i * 8 + j] = Number(lane & 0xffn); lane >>= 8n; }
    }
    return out;
  }

  const ascii = s => Uint8Array.from(s, ch => ch.charCodeAt(0));
  const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

  function eip55Checksum(hex40) {
    const lower = hex40.toLowerCase();
    const digest = hex(keccak256(ascii(lower)));
    let out = '0x';
    for (let i = 0; i < lower.length; i++) {
      const ch = lower[i];
      out += /[a-f]/.test(ch) && parseInt(digest[i], 16) >= 8 ? ch.toUpperCase() : ch;
    }
    return out;
  }

  // ------------------------------------------------------------------ Base58

  class DecodeError extends Error {}

  const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const B58_INDEX = new Map([...B58_ALPHABET].map((c, i) => [c, BigInt(i)]));

  function b58decode(text) {
    let n = 0n;
    for (const ch of text) {
      const v = B58_INDEX.get(ch);
      if (v === undefined) throw new DecodeError(`invalid Base58 character '${ch}'`);
      n = n * 58n + v;
    }
    const body = [];
    while (n > 0n) { body.push(Number(n & 0xffn)); n >>= 8n; }
    body.reverse();
    let zeros = 0;
    while (zeros < text.length && text[zeros] === '1') zeros++;
    return Uint8Array.from([...new Array(zeros).fill(0), ...body]);
  }

  function b58encode(data) {
    let n = 0n;
    for (const b of data) n = (n << 8n) | BigInt(b);
    let out = '';
    while (n > 0n) { out = B58_ALPHABET[Number(n % 58n)] + out; n /= 58n; }
    let zeros = 0;
    while (zeros < data.length && data[zeros] === 0) zeros++;
    return '1'.repeat(zeros) + out;
  }

  const bytesEqual = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

  function b58checkDecode(text) {
    const raw = b58decode(text);
    if (raw.length < 5) throw new DecodeError('too short for Base58Check');
    const payload = raw.slice(0, -4);
    if (!bytesEqual(doubleSha256(payload).slice(0, 4), raw.slice(-4))) throw new DecodeError('Base58Check checksum mismatch');
    return payload;
  }

  function b58checkEncode(payload) {
    const out = new Uint8Array(payload.length + 4);
    out.set(payload);
    out.set(doubleSha256(payload).slice(0, 4), payload.length);
    return b58encode(out);
  }

  // ------------------------------------------------------- Bech32 / Bech32m

  const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const BECH32_CONST = 1;
  const BECH32M_CONST = 0x2bc830a3;
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

  function bech32Polymod(values) {
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = (((chk & 0x1ffffff) << 5) ^ v) >>> 0;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk = (chk ^ GEN[i]) >>> 0;
    }
    return chk;
  }
  const hrpExpand = hrp => [...[...hrp].map(c => c.charCodeAt(0) >> 5), 0, ...[...hrp].map(c => c.charCodeAt(0) & 31)];

  function bech32CreateChecksum(hrp, data, spec) {
    const c = spec === 'bech32m' ? BECH32M_CONST : BECH32_CONST;
    const pm = (bech32Polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ c) >>> 0;
    return [0, 1, 2, 3, 4, 5].map(i => (pm >>> (5 * (5 - i))) & 31);
  }

  function bech32Encode(hrp, data, spec = 'bech32') {
    return hrp + '1' + [...data, ...bech32CreateChecksum(hrp, data, spec)].map(d => BECH32_CHARSET[d]).join('');
  }

  function bech32Decode(text, maxLength = 90) {
    if ([...text].some(ch => ch.charCodeAt(0) < 33 || ch.charCodeAt(0) > 126)) throw new DecodeError('invalid character');
    if (text.toLowerCase() !== text && text.toUpperCase() !== text) throw new DecodeError('mixed upper and lower case');
    text = text.toLowerCase();
    const pos = text.lastIndexOf('1');
    if (pos < 1 || pos + 7 > text.length || text.length > maxLength) throw new DecodeError('invalid Bech32 length or separator');
    const rest = text.slice(pos + 1);
    if (![...rest].every(ch => BECH32_CHARSET.includes(ch))) throw new DecodeError('invalid Bech32 character');
    const hrp = text.slice(0, pos);
    const data = [...rest].map(ch => BECH32_CHARSET.indexOf(ch));
    const c = bech32Polymod([...hrpExpand(hrp), ...data]);
    let spec;
    if (c === BECH32_CONST) spec = 'bech32';
    else if (c === BECH32M_CONST) spec = 'bech32m';
    else throw new DecodeError('Bech32 checksum mismatch');
    return [hrp, data.slice(0, -6), spec];
  }

  function convertbits(data, frombits, tobits, pad = true) {
    let acc = 0, bits = 0;
    const ret = [];
    const maxv = (1 << tobits) - 1;
    const maxAcc = (1 << (frombits + tobits - 1)) - 1;
    for (const value of data) {
      if (value < 0 || value >> frombits) return null;
      acc = ((acc << frombits) | value) & maxAcc;
      bits += frombits;
      while (bits >= tobits) { bits -= tobits; ret.push((acc >> bits) & maxv); }
    }
    if (pad) { if (bits) ret.push((acc << (tobits - bits)) & maxv); }
    else if (bits >= frombits || ((acc << (tobits - bits)) & maxv)) return null;
    return ret;
  }

  function segwitDecode(hrp, address) {
    const [hrpGot, data, spec] = bech32Decode(address);
    if (hrpGot !== hrp) throw new DecodeError(`expected prefix ${hrp}1, got ${hrpGot}1`);
    if (!data.length) throw new DecodeError('empty witness data');
    const program = convertbits(data.slice(1), 5, 8, false);
    if (program === null || program.length < 2 || program.length > 40) throw new DecodeError('invalid witness program length');
    const version = data[0];
    if (version > 16) throw new DecodeError('invalid witness version');
    if (version === 0 && program.length !== 20 && program.length !== 32) throw new DecodeError('invalid v0 witness program length');
    if ((version === 0 && spec !== 'bech32') || (version !== 0 && spec !== 'bech32m')) {
      throw new DecodeError('wrong checksum variant for this witness version (Bech32 vs Bech32m)');
    }
    return [version, Uint8Array.from(program)];
  }

  function segwitEncode(hrp, version, program) {
    return bech32Encode(hrp, [version, ...convertbits(program, 8, 5)], version === 0 ? 'bech32' : 'bech32m');
  }

  // ---------------------------------------------------------------- CashAddr

  const CASHADDR_SIZES = [20, 24, 28, 32, 40, 48, 56, 64];
  const CASH_GEN = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];

  function cashaddrPolymod(values) {
    let c = 1n;
    for (const d of values) {
      const c0 = c >> 35n;
      c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
      for (let i = 0; i < 5; i++) if ((c0 >> BigInt(i)) & 1n) c ^= CASH_GEN[i];
    }
    return c ^ 1n;
  }
  const cashPrefixExpand = prefix => [...[...prefix].map(c => c.charCodeAt(0) & 0x1f), 0];

  function cashaddrDecode(address, defaultPrefix = 'bitcoincash') {
    if (address.toLowerCase() !== address && address.toUpperCase() !== address) throw new DecodeError('mixed upper and lower case');
    address = address.toLowerCase();
    const i = address.lastIndexOf(':');
    const [prefix, payload] = i < 0 ? [defaultPrefix, address] : [address.slice(0, i), address.slice(i + 1)];
    if (!payload || ![...payload].every(ch => BECH32_CHARSET.includes(ch))) throw new DecodeError('invalid CashAddr character');
    const data = [...payload].map(ch => BECH32_CHARSET.indexOf(ch));
    if (data.length < 9 || cashaddrPolymod([...cashPrefixExpand(prefix), ...data]) !== 0n) throw new DecodeError('CashAddr checksum mismatch');
    const decoded = convertbits(data.slice(0, -8), 5, 8, false);
    if (!decoded || !decoded.length) throw new DecodeError('invalid CashAddr padding');
    const version = decoded[0];
    const hash = Uint8Array.from(decoded.slice(1));
    if (version & 0x80) throw new DecodeError('invalid CashAddr version byte');
    const type = (version >> 3) & 0x0f;
    if (CASHADDR_SIZES[version & 0x07] !== hash.length) throw new DecodeError('CashAddr hash length does not match its version byte');
    return [prefix, type, hash];
  }

  function cashaddrEncode(prefix, type, hash) {
    const version = (type << 3) | CASHADDR_SIZES.indexOf(hash.length);
    const payload = convertbits([version, ...hash], 8, 5, true);
    const checksum = cashaddrPolymod([...cashPrefixExpand(prefix), ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
    for (let i = 0; i < 8; i++) payload.push(Number((checksum >> BigInt(5 * (7 - i))) & 0x1fn));
    return prefix + ':' + payload.map(d => BECH32_CHARSET[d]).join('');
  }

  // ------------------------------------------------------------------ chains

  const CHAINS = {
    eth: 'Ethereum', bsc: 'BNB Smart Chain', matic: 'Polygon', arb: 'Arbitrum', avax: 'Avalanche', op: 'Optimism',
    base: 'Base', // addition
    btc: 'Bitcoin', trx: 'Tron (TRC-20)', ltc: 'Litecoin', doge: 'Dogecoin', bch: 'Bitcoin Cash', ada: 'Cardano',
    dash: 'Dash', xrp: 'XRP Ledger',
    sol: 'Solana', ton: 'TON', // additions
  };
  const EVM_CHAINS = ['eth', 'bsc', 'matic', 'arb', 'avax', 'op', 'base']; // ETH first = default for 0x
  const chainLabel = code => CHAINS[code] || code;

  const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
  const XRP_TO_B58 = new Map([...XRP_ALPHABET].map((c, i) => [c, B58_ALPHABET[i]]));
  const xrpToB58 = s => [...s].map(c => XRP_TO_B58.get(c) ?? c).join('');
  const reEsc = s => s.replace(/[\\^$.*+?()[\]{}|-]/g, '\\$&');
  const XRP_CLASSIC_RE = new RegExp(`^r[${reEsc(XRP_ALPHABET)}]{24,34}$`);
  const XRP_X_ADDRESS_RE = new RegExp(`^[XT][${reEsc(XRP_ALPHABET)}]{46}$`);
  const XRP_DEST_TAG_MAX = 2 ** 32 - 1;

  const EVM_RE = /^0x[0-9a-fA-F]{40}$/;
  const B58_RE = new RegExp(`^[${B58_ALPHABET}]+$`);
  const BARE_CASHADDR_RE = /^[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/;
  const SOL_RE = new RegExp(`^[${B58_ALPHABET}]{32,44}$`);
  const TON_RE = /^[EU]Q[A-Za-z0-9_\-+/]{46}$/;

  const B58_VERSIONS = {
    0x00: ['btc', 'P2PKH (legacy)'], 0x05: ['btc', 'P2SH'], 0x41: ['trx', 'Base58Check'],
    0x30: ['ltc', 'P2PKH (L…)'], 0x32: ['ltc', 'P2SH (M…)'], 0x1e: ['doge', 'P2PKH (D…)'], 0x4c: ['dash', 'P2PKH (X…)'],
  };
  const B58_FIRST_CHAR = { 1: 'btc', 3: 'btc', T: 'trx', L: 'ltc', M: 'ltc', D: 'doge', X: 'dash' };

  const detection = (chain, candidates = [], note = '') => ({ chain, candidates, note });

  function detectChain(raw) {
    const address = (raw || '').trim();
    if (!address) return detection(null);
    if (EVM_RE.test(address)) {
      return detection('eth', EVM_CHAINS, '0x addresses look identical on every EVM chain — pick the network the site actually uses.');
    }
    const lower = address.toLowerCase();
    if (lower.startsWith('x-avax1')) return detection('avax', ['avax'], 'Avalanche X-Chain address');
    if (lower.startsWith('bc1')) return detection('btc', ['btc']);
    if (lower.startsWith('ltc1')) return detection('ltc', ['ltc']);
    if (lower.startsWith('addr1')) return detection('ada', ['ada']);
    if (lower.startsWith('bitcoincash:') || BARE_CASHADDR_RE.test(lower)) return detection('bch', ['bch']);
    if (XRP_CLASSIC_RE.test(address)) return detection('xrp', ['xrp'], 'XRP Ledger address — a destination tag is required.');
    if (XRP_X_ADDRESS_RE.test(address)) return detection('xrp', ['xrp'], 'XRP X-address — enter the classic r… address and the tag instead.');
    if (B58_RE.test(address)) {
      let match = null;
      try {
        const payload = b58checkDecode(address);
        match = payload.length === 21 ? B58_VERSIONS[payload[0]] || null : null;
      } catch (e) { if (!(e instanceof DecodeError)) throw e; }
      // The first-letter fallback only applies at those chains' lengths (25–35), so longer
      // Base58 strings such as Solana keys starting with D/L/M/T/X/1/3 are not claimed (addition).
      const chain = match ? match[0] : (address.length <= 35 ? B58_FIRST_CHAR[address[0]] : undefined);
      if (chain === 'btc') return detection('btc', ['btc', 'bch'], 'Legacy format is shared by Bitcoin and Bitcoin Cash.');
      if (chain) return detection(chain, [chain]);
    }
    // --- additions (only reached when nothing above matched)
    if (TON_RE.test(address)) return detection('ton', ['ton']);
    if (SOL_RE.test(address)) return detection('sol', ['sol'], 'Solana addresses have no checksum; only the length is verified.');
    return detection(null);
  }

  // Each validator returns [canonical, format, keyForm, checksum-verified?] or throws DecodeError.

  function validateEvm(address) {
    if (!EVM_RE.test(address)) throw new DecodeError('expected 0x followed by 40 hexadecimal characters');
    const body = address.slice(2);
    const checksummed = eip55Checksum(body);
    let fmt, verified;
    if (body.toLowerCase() === body || body.toUpperCase() === body) { fmt = 'EVM (no checksum casing)'; verified = false; }
    else if (address === checksummed) { fmt = 'EVM (EIP-55 checksum verified)'; verified = true; }
    else throw new DecodeError('EIP-55 checksum mismatch — check for a typo in the mixed-case address');
    return [checksummed, fmt, '0x' + body.toLowerCase(), verified];
  }

  function validateAvaxX(address) {
    if (!address.toLowerCase().startsWith('x-')) throw new DecodeError('expected an 0x C-Chain address or an X-avax1… X-Chain address');
    const [hrp, data, spec] = bech32Decode(address.slice(2));
    const program = convertbits(data, 5, 8, false);
    if (hrp !== 'avax' || spec !== 'bech32' || program === null || program.length !== 20) throw new DecodeError('invalid X-Chain address');
    const canonical = 'X-' + address.slice(2).toLowerCase();
    return [canonical, 'Avalanche X-Chain (Bech32)', canonical.toLowerCase(), true];
  }

  function base58Versions(address, allowed, prefixHint) {
    if (!B58_RE.test(address)) throw new DecodeError(`expected a Base58 address starting with ${prefixHint}`);
    const payload = b58checkDecode(address);
    if (payload.length !== 21 || !(payload[0] in allowed)) throw new DecodeError(`wrong version byte — expected an address starting with ${prefixHint}`);
    return [address, allowed[payload[0]], address, true];
  }

  function validateBtc(address) {
    if (address.toLowerCase().startsWith('bc1')) {
      const [version] = segwitDecode('bc', address);
      const fmt = version === 0 ? 'SegWit v0 (Bech32)' : version === 1 ? 'Taproot (Bech32m)' : `SegWit v${version}`;
      return [address.toLowerCase(), fmt, address.toLowerCase(), true];
    }
    return base58Versions(address, { 0x00: 'P2PKH (legacy)', 0x05: 'P2SH' }, '1, 3 or bc1');
  }

  function validateLtc(address) {
    if (address.toLowerCase().startsWith('ltc1')) {
      const [version] = segwitDecode('ltc', address);
      return [address.toLowerCase(), version === 0 ? 'SegWit (Bech32)' : `SegWit v${version}`, address.toLowerCase(), true];
    }
    return base58Versions(address, { 0x30: 'P2PKH (L…)', 0x32: 'P2SH (M…)' }, 'L, M or ltc1');
  }

  function validateTrx(address) {
    if (address.length !== 34 || !address.startsWith('T')) throw new DecodeError('expected 34 characters starting with T');
    return base58Versions(address, { 0x41: 'Base58Check' }, 'T');
  }

  const validateDoge = a => base58Versions(a, { 0x1e: 'P2PKH (D…)' }, 'D');
  const validateDash = a => base58Versions(a, { 0x4c: 'P2PKH (X…)' }, 'X');

  function validateBch(address) {
    const lower = address.toLowerCase();
    if (lower.startsWith('bitcoincash:') || BARE_CASHADDR_RE.test(lower)) {
      const [prefix, type, hash] = cashaddrDecode(address);
      if (prefix !== 'bitcoincash') throw new DecodeError('expected the bitcoincash: prefix');
      if (type !== 0 && type !== 1) throw new DecodeError('unknown CashAddr type');
      const canonical = cashaddrEncode('bitcoincash', type, hash);
      return [canonical, 'CashAddr ' + (type === 0 ? 'P2PKH' : 'P2SH'), canonical, true];
    }
    if (B58_RE.test(address) && '13'.includes(address[0])) {
      const payload = b58checkDecode(address);
      if (payload.length !== 21 || (payload[0] !== 0x00 && payload[0] !== 0x05)) throw new DecodeError('wrong version byte for a legacy address');
      const canonical = cashaddrEncode('bitcoincash', payload[0] === 0x00 ? 0 : 1, payload.slice(1));
      return [canonical, 'Legacy (converted to CashAddr)', canonical, true];
    }
    throw new DecodeError('expected bitcoincash:q…/p…, a bare q…/p… CashAddr, or a legacy 1…/3… address');
  }

  function validateAda(address) {
    if (!address.toLowerCase().startsWith('addr1')) throw new DecodeError('expected a mainnet Shelley address starting with addr1');
    const [hrp, data, spec] = bech32Decode(address, 1023); // Cardano exceeds Bech32's 90-char limit
    const payload = convertbits(data, 5, 8, false);
    if (hrp !== 'addr' || spec !== 'bech32' || !payload || !payload.length) throw new DecodeError('invalid Bech32 payload');
    const header = payload[0];
    const type = header >> 4, network = header & 0x0f;
    if (network !== 1) throw new DecodeError('not a mainnet address');
    const expected = { 0: 57, 1: 57, 2: 57, 3: 57, 6: 29, 7: 29 };
    if (type in expected && payload.length !== expected[type]) throw new DecodeError('wrong length for its address type');
    if ((type === 4 || type === 5) && payload.length < 32) throw new DecodeError('pointer address too short');
    if (type > 7) throw new DecodeError('not a payment address');
    const kinds = { 0: 'base', 1: 'base', 2: 'base', 3: 'base', 4: 'pointer', 5: 'pointer', 6: 'enterprise', 7: 'enterprise' };
    return [address.toLowerCase(), `Shelley ${kinds[type]} address`, address.toLowerCase(), true];
  }

  function validateXrp(address) {
    if (XRP_X_ADDRESS_RE.test(address)) {
      throw new DecodeError("X-addresses aren't accepted — enter the classic r… address and put the destination tag in its own field");
    }
    if (!XRP_CLASSIC_RE.test(address)) throw new DecodeError('expected a classic XRP Ledger address starting with r');
    const payload = b58checkDecode(xrpToB58(address));
    if (payload.length !== 21 || payload[0] !== 0x00) throw new DecodeError('wrong version byte — expected an account address starting with r');
    return [address, 'XRP Ledger classic address (Base58Check)', address, true];
  }

  function validateXrpDestTag(raw) {
    const tag = (raw || '').trim();
    if (!tag) return [null, 'Enter the destination tag (memo) shown with this XRP address.'];
    if (!/^[0-9]+$/.test(tag)) return [null, 'A destination tag is a whole number (digits only).'];
    const value = BigInt(tag);
    if (value > BigInt(XRP_DEST_TAG_MAX)) return [null, `A destination tag is at most ${XRP_DEST_TAG_MAX}.`];
    return [value.toString(), null];
  }

  // --- additions -------------------------------------------------------------

  // Solana addresses are raw 32-byte ed25519 public keys in Base58: no checksum exists.
  function validateSol(address) {
    if (!SOL_RE.test(address)) throw new DecodeError('expected 32 to 44 Base58 characters');
    if (b58decode(address).length !== 32) throw new DecodeError('does not decode to a 32-byte public key');
    return [address, 'Solana (32-byte key, no checksum)', address, false];
  }

  // TON user-friendly address: base64(url) of flags(1) + workchain(1) + hash(32) + CRC16-XMODEM(2).
  function crc16xmodem(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b << 8;
      for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
    return crc;
  }
  function validateTon(address) {
    if (!TON_RE.test(address)) throw new DecodeError('expected a 48-character user-friendly TON address (EQ…/UQ…)');
    let bin;
    try { bin = atob(address.replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new DecodeError('invalid base64'); }
    const raw = Uint8Array.from(bin, ch => ch.charCodeAt(0));
    if (raw.length !== 36) throw new DecodeError('wrong length');
    const crc = crc16xmodem(raw.slice(0, 34));
    if (((crc >> 8) & 0xff) !== raw[34] || (crc & 0xff) !== raw[35]) throw new DecodeError('TON checksum mismatch');
    const flags = raw[0];
    if (flags & 0x80) throw new DecodeError('testnet address');
    if ((flags & 0x7f) !== 0x11 && (flags & 0x7f) !== 0x51) throw new DecodeError('unknown address flags');
    if (raw[1] !== 0x00 && raw[1] !== 0xff) throw new DecodeError('unknown workchain');
    const key = (raw[1] === 0xff ? '-1' : '0') + ':' + hex(raw.slice(2, 34));
    return [address, (flags & 0x40 ? 'non-bounceable' : 'bounceable') + ' TON address (CRC16 verified)', key, true];
  }

  const VALIDATORS = {
    btc: validateBtc, ltc: validateLtc, trx: validateTrx, doge: validateDoge, dash: validateDash,
    bch: validateBch, ada: validateAda, xrp: validateXrp, sol: validateSol, ton: validateTon,
  };

  function friendlyError(chain, det, reason) {
    let message = `Not a valid ${chainLabel(chain)} address: ${reason}.`;
    if (det.chain && !det.candidates.includes(chain)) message += ` It looks like a ${chainLabel(det.chain)} address.`;
    return message;
  }

  // The hard gate: decode, verify the chain's checksum and version/prefix. Mirrors validate_wallet().
  function validateWallet(chain, raw) {
    const address = (raw || '').trim();
    const det = detectChain(address);
    const check = { chain, input: address, valid: false, canonical: null, key: null, format: null, checksum: false, errors: [], detected: det };
    if (!(chain in CHAINS)) { check.errors.push(`Unsupported chain '${chain}'.`); return check; }
    if (!address) { check.errors.push('Enter a wallet address.'); return check; }
    if (/\s/.test(address)) { check.errors.push('The address contains spaces.'); return check; }
    if (address.length > 128) { check.errors.push('That is too long to be a wallet address.'); return check; }
    let result;
    try {
      if (chain === 'avax' && address.toLowerCase().startsWith('x-')) result = validateAvaxX(address);
      else if (EVM_CHAINS.includes(chain)) result = validateEvm(address);
      else result = VALIDATORS[chain](address);
    } catch (e) {
      if (!(e instanceof DecodeError)) throw e;
      check.errors.push(friendlyError(chain, det, e.message));
      return check;
    }
    [check.canonical, check.format, , check.checksum] = result;
    check.key = `${chain}:${result[2]}`;
    check.valid = true;
    return check;
  }

  // Convenience for scanned text: detect, then validate against the detected chain.
  // Returns null when the string is not a valid address of any supported chain.
  function checkDetected(raw) {
    const det = detectChain(raw);
    if (!det.chain) return null;
    const c = validateWallet(det.chain, raw);
    return c.valid ? c : null;
  }

  // The form the hub stores and matches: BCH without its "bitcoincash:" prefix, the rest canonical.
  const hubAddress = c => (c.chain === 'bch' ? c.canonical.replace(/^bitcoincash:/, '') : c.canonical);

  globalThis.BBWallets = {
    CHAINS, EVM_CHAINS, XRP_ALPHABET, XRP_DEST_TAG_MAX, DecodeError, chainLabel,
    detectChain, validateWallet, validateXrpDestTag, checkDetected, hubAddress,
    // codecs, exported for tests
    codecs: {
      sha256, keccak256, eip55Checksum, b58decode, b58encode, b58checkDecode, b58checkEncode,
      bech32Encode, bech32Decode, convertbits, segwitDecode, segwitEncode, cashaddrDecode, cashaddrEncode, crc16xmodem, hex,
    },
  };
})();
