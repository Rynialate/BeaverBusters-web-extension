// Shared constants and storage helpers used by the background and the popup.

export const ext = globalThis.browser ?? globalThis.chrome;

export const DEFAULT_SETTINGS = {
  autoCheck: true,          // check every visited domain against the hub
  walletScan: true,         // find wallet addresses on pages and check them
  widget: 'alerts',         // on-page corner widget: 'alerts' | 'always' | 'never'
  autoSubmitWallets: false, // add newly found wallets to domains the hub already flags as scam/suspected
  autoScope: false,         // send page HTML to the hub's scope classifier when an unknown site shows wallets
  volume: 'popup',          // on-chain volume from public explorers: 'popup' (when the popup opens) | 'auto' | 'off'
  ignore: [
    'sdb.netherportal3.com',
    'etherscan.io', 'bscscan.com', 'polygonscan.com', 'arbiscan.io', 'basescan.org',
    'tronscan.org', 'solscan.io', 'blockchair.com', 'blockchain.com', 'mempool.space',
    'blockstream.info', 'xrpscan.com', 'tonviewer.com', 'tonscan.org', 'cardanoscan.io',
    'urlscan.io', 'github.com',
  ],
};

export const VERDICTS = ['scam', 'suspected', 'not_scam', 'out_of_scope', 'unknown'];

export const REASON_CODES = [
  'unrealistic_returns', 'guaranteed_profit', 'fake_exchange', 'fake_investment_platform',
  'kit_fingerprint', 'wallet_reuse', 'infra_overlap', 'impersonation', 'fake_regulation',
  'fake_reviews', 'victim_report', 'withdrawal_blocked', 'recovery_scam', 'pig_butchering',
  'task_scam', 'fake_bank', 'phishing', 'other',
];

export async function getConfig() {
  const { apiKey = '', me = null, settings = {} } = await ext.storage.local.get(['apiKey', 'me', 'settings']);
  return { apiKey, me, settings: { ...DEFAULT_SETTINGS, ...settings } };
}

export async function saveSettings(patch) {
  const { settings } = await getConfig();
  const next = { ...settings, ...patch };
  await ext.storage.local.set({ settings: next });
  return next;
}
