/* Static configuration and default settings. */
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  root.BB = root.BB || {};
  root.BB.config = mod;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DEFAULT_BASE_URL = 'https://sdb.netherportal3.com/api/v1';

  return {
    DEFAULT_BASE_URL,
    DOCS_URL: 'https://sdb.netherportal3.com/docs',
    SPEC_FILE: 'openapi.json',
    SPEC_MAX_AGE_MS: 6 * 60 * 60 * 1000,
    REQUEST_TIMEOUT_MS: 15000,
    MAX_WALLETS_PER_PAGE: 30,
    MAX_PAGE_TEXT_CHARS: 200000,
    MAX_CACHE_ENTRIES: 3000,
    WALLET_CHECK_CONCURRENCY: 4,

    DEFAULT_SETTINGS: {
      baseUrl: DEFAULT_BASE_URL,
      specUrl: '', // empty = <baseUrl>/openapi.json
      liveDomainCheck: true,
      blockScamSites: true,
      warnSuspicious: true,
      autoWalletScan: true,
      serverWalletExtraction: false,
      highlightWallets: true,
      sendFullUrl: false,
      cacheMinutes: 30,
      trustedDomains: [],
      endpointOverrides: {},
    },
  };
});
