# BeaverBusters-web-extension

A web extension for the BeaverBusters workflow: website checking, submission, wallet checking and more, for Chrome and Firefox.
It talks to the hub API at `https://sdb.netherportal3.com/api/v1`.

Nothing works until you enter an API key. The popup shows a key prompt first, and the key is
checked against the hub's `GET /me` before it is saved.

## What it does

| Feature | How | Hub endpoint |
|---|---|---|
| Live domain check | Every http(s) site you visit is checked and the toolbar badge shows `SCAM`, `SUS`, `OK`, `OOS` or the count of wallets on the page. If the hub doesn't know a subdomain, its parent domain is checked too. | `GET /check` |
| Submitted check | Shows whether the site has been submitted, who submitted it, its points and any claim. | `GET /check` |
| Wallet finding | Finds candidate addresses in page text, input values, copy-button attributes, `bitcoin:`/`tron:` style links and QR image URLs, and addresses the user copies. Rescans when the page changes, so deposit addresses revealed later are caught. Every candidate must pass full validation (below) before it is shown or submitted. | — |
| Wallet validation | `src/lib/wallets.js`, a port of the ScamHunt CTF validator ([benpinpop/urlscan-dashboard `wallet_validation/`](https://github.com/benpinpop/urlscan-dashboard/tree/main/wallet_validation)): Base58Check with version bytes (BTC, LTC, DOGE, DASH, TRX), Bech32/Bech32m SegWit and Taproot, CashAddr (BCH), Cardano Shelley headers, XRP Ledger Base58Check, EIP-55 for mixed-case 0x addresses. Additions for chains the hub accepts: TON (CRC16) and Solana (32-byte key; Solana has no checksum). Extra addresses typed into the Submit form are checked as you type, and the background refuses to submit any address that fails. | — |
| Wallet check | Each address is looked up: new, on N scam sites, already submitted, excluded. | `GET /wallets/{address}` |
| On-chain volume | Money in and out of each wallet: lifetime received and sent, balance, transaction count and last activity, with USD estimates (in and moved out) at today's prices. Bitcoin uses **blockchain.com** first (all of a page's Bitcoin wallets in one request, as blockchain.com asks for at most one request every 10 seconds), then mempool.space and blockchair. Tron uses **Tronscan** first (account totals plus USDT-TRC20 in and out, summed from transfers), then TronGrid; an optional Tronscan API key can be set in Settings. Bitcoin Cash uses blockchain.com, then blockchair. 0x addresses are checked on Ethereum and BNB Chain (native coin plus USDT, USDC and DAI in and out, from each stablecoin's latest 100 transfers) and on Polygon, Arbitrum, Optimism and Base (balances only). With an **Etherscan API key** (Settings) they are read from Etherscan API V2 instead, on every chain the key's plan covers (also Avalanche): transaction and token-transfer counts, native in and out (including internal transfers), stablecoins, balance and last activity from the latest 1,000 records of each kind; chains outside the plan (the free plan leaves out BNB Chain, Base, Optimism and Avalanche) and Etherscan failures fall back to the explorers above. Each wallet on a page shows its transaction count (summed over networks; "+" when that is a lower bound). Applies to wallets found on pages and to wallets typed into **Look up anything**; can be included in a submission as a `wallet_volume` check. | Public explorers (see Privacy) |
| Wallet insights | From the same explorer data: **likely exchange / service wallets** (an explorer name tag such as Tronscan's "Binance-Hot 3", or more transactions or more USD received or held than the limits in **Settings → Flag as likely exchange from**: default 1,000 transactions or $1,000,000, and 0 turns a limit off) get a *likely exchange* chip, are left unticked for submission and are skipped by auto-add; **distinct senders** counts the addresses that paid the wallet more than dust, from the transfer history read ("+" when the history is longer); **address poisoning** flags look-alike addresses (same first 3 and last 4 characters as a real counterparty) that only moved dust. Included in the `wallet_volume` submission check. | Public explorers (see Privacy) |
| Scope classification | Sends the page HTML to the hub's own classifier: in scope / out of scope / inconclusive. An in-scope result pre-fills the submit form. | `POST /scope` |
| Submission | One bundle with verdict, reasons, selected wallets, comment, gzip'd HTML snapshot, the scope result and an optional "I reported it" submission record. | `POST /ingest` |
| Claim | Claim or release a domain for 24 h. | `POST/DELETE /domains/{d}/claim` |
| Look up anything | Domain, URL, wallet, IP, urlscan id, fingerprint. | `GET /lookup` |
| Key rotation | **Settings → Rotate API key** issues a new key and switches the extension to it. The old key stops working everywhere at once. The new key stays on screen, with a Copy button, until you confirm you saved it, even if the popup closes. | `POST /me/rotate` |
| I4G switch | **Check & submit with: Hub / I4G** at the top of the popup. With I4G selected, the I4G ScamBusters API (scambuster.intelligenceforgood.org) does everything it offers: the site check (popup, badge and corner widget show *Reported to I4G* active/pending/dead, wallets on record, stale), **Submit to I4G** (site URL without query string plus up to 30 ticked wallets with I4G chain codes; 0x addresses get a network picker preset from the on-chain volume; TON and Avalanche X-Chain are refused, as I4G does not take them), **My I4G submissions** (points per submission, valid/invalid wallets; one request a minute) and site lookups. Wallet lookups, claims, classifying, key rotation, auto-add and auto-classify stay on the hub (the two automations pause while I4G is selected). The I4G key (`sb_` + 32 hex, from `/get-api-key` in Discord) is verified with a read-only check, kept in this browser and sent only to I4G. | `GET /api/check`, `POST /api/submit`, `GET /api/submission_history` (I4G) |

Optional automation (off by default, in **Settings**):

- **Auto-add new wallets** adds high-confidence addresses found on a site to the hub, but only for sites the hub already flags as `scam` or `suspected`. These are attributed to your key.
- **Auto-classify** sends a page's HTML to `/scope` when a site the hub doesn't know shows wallet addresses.

## Footprint

- The toolbar popup opens in the top corner (360 px wide).
- The on-page widget is pinned to the top-right corner. It is at most 300 px wide and 40% of the
  viewport tall, and can be minimised to a small pill or hidden. By default it appears only on
  flagged sites or pages with wallets. You can set it to always (minimised) or never.

## Install

The `src` folder is a working extension in both browsers, so no build step is needed:

- **Chrome / Edge / Brave:** go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick the `src` folder.
- **Firefox (128+):** go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and pick `src/manifest.json`.

For packages without cross-browser manifest warnings, or to publish, build them:

```sh
node build.mjs          # builds dist/chrome, dist/firefox and a .zip of each
```

Then load `dist/chrome` or `dist/firefox/manifest.json` the same way. For a permanent Firefox
install, sign `dist/beaverbusters-checker-firefox-*.zip` through addons.mozilla.org (it can be unlisted).

Then click the toolbar icon (badge `KEY`), paste your hub API key, and press **Verify and save**.

**If the key check says it cannot reach sdb.netherportal3.com:** the hub does not answer browser
cross-origin (CORS) checks, so the extension can only reach it when the browser has given it access
to the site. Chrome does this at install unless site access is set to "On click"; Firefox may not.
**Verify and save** asks for access first, and an **Allow access** banner appears whenever it is
missing. Accept the browser's prompt (in Firefox the popup may close; open it again). You can also
grant it by hand: Firefox `about:addons` → BeaverBusters → Permissions, or Chrome
`chrome://extensions` → Details → Site access → On all sites.

## Privacy and security

- The key is kept in `storage.local` on this device only (never synced), and is sent only in the `X-Api-Key` header to `sdb.netherportal3.com`.
  The extension-page CSP blocks any other connection.
- All API calls run in the background worker. Web pages and content scripts never see the key.
- With **Check every site I visit** on, the hostname of every http(s) site you visit is sent to the hub.
  Turn it off to check only on demand. Sites in the ignored list get no wallet scan and no widget.
  Explorers and the hub itself are ignored by default.
- Page HTML leaves the browser only when you click **Classify page**, submit with **Attach page HTML** ticked, or turn on auto-classify.
- **I4G switch:** with I4G selected, the domains you visit (when "Check every site I visit" is on), the sites you submit and the wallets you tick go to scambuster.intelligenceforgood.org with your I4G key instead of the hub.
- **On-chain volume** sends wallet addresses (never your hub key or the page) to public explorers: blockchain.com (blockchain.info), Tronscan (apilist.tronscanapi.com), mempool.space, litecoinspace.org, blockcypher.com, blockchair.com, ethplorer.io, binplorer.com, blockscout.com, explorer.optimism.io, api.etherscan.io (only with an Etherscan key, which it also receives), trongrid.io, xrpscan.com, xrplcluster.com, the Solana public RPC, koios.rest, tonapi.io, toncenter.com, and coingecko.com for prices. By default this happens only when you open the popup; **Settings → On-chain volume** can make it automatic or turn it off. Results are cached for 30 minutes.
- Lookups are cached for 10–30 minutes, and the extension backs off when the key's per-minute limit gets low.

## Layout

```
src/manifest.json      shared manifest (build.mjs adds the per-browser background + Firefox id)
src/background.js      API calls, caching, badge, auto-submit, submission bundles
src/lib/api.js         hub client (rate-limit aware)
src/lib/settings.js    defaults, reason codes, storage helpers
src/lib/wallets.js     chain detection + checksum validation (shared by page, background, popup)
src/lib/volume.js      on-chain volume from public explorers
src/content.js         wallet finder + corner widget (shadow DOM)
src/popup/             key prompt, status, submit form, lookup, settings
```
