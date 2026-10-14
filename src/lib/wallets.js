/*
 * Crypto wallet address candidate detection and domain normalisation.
 *
 * These are deliberately cheap, permissive patterns. They only find
 * *candidates* in page text; checksum validation, chain confirmation and
 * reputation lookups are offloaded to the API.
 */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.BB = root.BB || {};
  root.BB.wallets = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const B58 = '1-9A-HJ-NP-Za-km-z';
  const XRP_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
  // Token boundaries: an address must not be glued to other word characters.
  const PRE = '(?<![A-Za-z0-9_])';
  const POST = '(?![A-Za-z0-9_])';

  // Base58 patterns marked `ambiguous` overlap with Solana's alphabet and
  // length range, so their chain is only a hint.
  // Random base58/base64 strings essentially always mix upper and lower case.
  // Requiring that filters out long numbers and ordinary words.
  const mixedCase = (s) => /[a-z]/.test(s) && /[A-Z]/.test(s);

  const PATTERNS = [
    { chain: 'evm', label: 'Ethereum / EVM', re: `0x[a-fA-F0-9]{40}`, caseInsensitive: true },
    { chain: 'btc', label: 'Bitcoin', re: `(?:bc1|BC1)[ac-hj-np-zAC-HJ-NP-Z02-9]{11,71}`, caseInsensitive: true },
    { chain: 'ltc', label: 'Litecoin', re: `ltc1[ac-hj-np-z02-9]{11,71}`, caseInsensitive: true },
    { chain: 'ada', label: 'Cardano', re: `addr1[a-z0-9]{53,110}` },
    { chain: 'bch', label: 'Bitcoin Cash', re: `(?:bitcoincash:)?[qp][02-9ac-hj-np-z]{41}`, validate: (s) => /[0-9]/.test(s) },
    { chain: 'ton', label: 'TON', re: `(?:EQ|UQ)[A-Za-z0-9_-]{46}`, pre: '(?<![A-Za-z0-9_-])', post: '(?![A-Za-z0-9_-])', validate: mixedCase },
    { chain: 'xmr', label: 'Monero', re: `[48][0-9AB][${B58}]{93}`, validate: mixedCase },
    { chain: 'btc', label: 'Bitcoin', re: `[13][${B58}]{25,34}`, validate: mixedCase, ambiguous: true },
    { chain: 'trx', label: 'Tron', re: `T[${B58}]{33}`, validate: mixedCase, ambiguous: true },
    { chain: 'doge', label: 'Dogecoin', re: `D[5-9A-HJ-NP-U][${B58}]{32}`, validate: mixedCase, ambiguous: true },
    { chain: 'ltc', label: 'Litecoin', re: `[LM][${B58}]{26,33}`, validate: mixedCase, ambiguous: true },
    { chain: 'xrp', label: 'XRP', re: `r[${XRP_ALPHABET}]{24,34}`, validate: (s) => mixedCase(s) && /[0-9]/.test(s), ambiguous: true },
    { chain: 'sol', label: 'Solana', re: `[${B58}]{32,44}`, validate: (s) => mixedCase(s) && /[0-9]/.test(s), ambiguous: true },
  ];

  const CHAIN_LABELS = PATTERNS.reduce((acc, p) => { acc[p.chain] = p.label; return acc; }, {});

  function compile(p, flags) {
    return new RegExp((p.pre || PRE) + p.re + (p.post || POST), flags);
  }
  const GLOBAL_RES = PATTERNS.map((p) => compile(p, 'g'));
  const ANCHORED_RES = PATTERNS.map((p) => new RegExp('^' + p.re + '$'));

  function dedupeKey(chain, address) {
    const p = PATTERNS.find((x) => x.chain === chain && x.caseInsensitive);
    return chain + ':' + (p ? address.toLowerCase() : address);
  }

  /**
   * Find wallet address candidates in free text.
   * Earlier (more specific) patterns win over later, broader ones.
   * @returns {{address: string, chain: string, label: string}[]}
   */
  function findWallets(text, options) {
    const limit = (options && options.limit) || 50;
    const out = [];
    if (!text) return out;
    const taken = []; // [start, end) spans already claimed
    const seen = new Set();
    for (let i = 0; i < PATTERNS.length; i++) {
      const p = PATTERNS[i];
      const re = GLOBAL_RES[i];
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const start = m.index;
        const end = start + m[0].length;
        if (taken.some(([s, e]) => start < e && end > s)) continue;
        if (p.validate && !p.validate(m[0])) continue;
        taken.push([start, end]);
        const address = m[0].replace(/^bitcoincash:/, '');
        const key = dedupeKey(p.chain, address);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ address, chain: p.chain, label: p.label, ambiguous: !!p.ambiguous });
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Classify a single string as a wallet address, or return null. */
  function classifyAddress(input) {
    const s = String(input || '').trim().replace(/^(ethereum|bitcoin|solana|tron|litecoin|dogecoin):/i, '');
    for (let i = 0; i < PATTERNS.length; i++) {
      const p = PATTERNS[i];
      if (ANCHORED_RES[i].test(s) && (!p.validate || p.validate(s))) {
        return { address: s.replace(/^bitcoincash:/, ''), chain: p.chain, label: p.label, ambiguous: !!p.ambiguous };
      }
    }
    return null;
  }

  /** Undo common "defanging" used when sharing malicious links: hxxp, [.], (dot). */
  function refang(s) {
    return String(s || '')
      .trim()
      .replace(/^hxxp(s?)/i, 'http$1')
      .replace(/\[\s*\.\s*\]|\(\s*\.\s*\)|\{\s*\.\s*\}|\[dot\]|\(dot\)/gi, '.')
      .replace(/\[\s*:\s*\]/g, ':')
      .replace(/\[\s*\/\s*\]/g, '/');
  }

  const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

  /** Turn a URL, defanged URL or bare host into a lowercase hostname, or '' if it is not one. */
  function normalizeDomain(input) {
    let s = refang(input);
    if (!s) return '';
    try {
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'http://' + s;
      const u = new URL(s);
      const host = u.hostname.replace(/\.$/, '').toLowerCase();
      return DOMAIN_RE.test(host) ? host : '';
    } catch (e) {
      return '';
    }
  }

  function looksLikeDomain(input) {
    return normalizeDomain(input) !== '';
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  function looksLikeSubmissionId(input) {
    const s = String(input || '').trim();
    return UUID_RE.test(s) || /^\d{1,12}$/.test(s) || /^(sub|rep|report|submission|ticket)[_-][A-Za-z0-9_-]{3,64}$/i.test(s);
  }

  /** Decide what a free-form lookup query refers to. */
  function detectQuery(input) {
    const raw = String(input || '').trim();
    if (!raw) return { kind: 'empty', value: '' };
    const wallet = classifyAddress(raw);
    if (wallet) return { kind: 'wallet', value: wallet.address, chain: wallet.chain, label: wallet.label };
    if (looksLikeSubmissionId(raw)) return { kind: 'submission', value: raw };
    const domain = normalizeDomain(raw);
    if (domain) return { kind: 'domain', value: domain, url: /^(https?|hxxps?):\/\//i.test(raw) ? refang(raw) : '' };
    return { kind: 'unknown', value: raw };
  }

  function isPrivateHost(host) {
    if (!host) return true;
    if (host === 'localhost' || /\.(localhost|local|internal|lan|home|test|invalid)$/.test(host)) return true;
    if (host.startsWith('[') || host.includes(':')) return true; // IPv6 literal
    const m = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }

  function hostMatches(host, domain) {
    if (!host || !domain) return false;
    const d = domain.replace(/^\*\./, '').toLowerCase();
    return host === d || host.endsWith('.' + d);
  }

  return {
    PATTERNS,
    CHAIN_LABELS,
    findWallets,
    classifyAddress,
    refang,
    normalizeDomain,
    looksLikeDomain,
    looksLikeSubmissionId,
    detectQuery,
    isPrivateHost,
    hostMatches,
  };
});
