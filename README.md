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
| On-chain volume | Lifetime received and sent, balance, transaction count and last activity for each wallet, with a USD estimate at today's prices. For Tron it also sums USDT-TRC20 transfers in and out; for 0x addresses it checks Ethereum, BNB Chain, Polygon, Arbitrum, Optimism and Base and shows the networks with activity. Shown in the popup and the widget, and can be included in a submission as a `wallet_volume` check. | Public explorers (see Privacy) |
| Scope classification | Sends the page HTML to the hub's own classifier: in scope / out of scope / inconclusive. An in-scope result pre-fills the submit form. | `POST /scope` |
| Submission | One bundle with verdict, reasons, selected wallets, comment, gzip'd HTML snapshot, the scope result and an optional "I reported it" submission record. | `POST /ingest` |
| Claim | Claim or release a domain for 24 h. | `POST/DELETE /domains/{d}/claim` |
| Look up anything | Domain, URL, wallet, IP, urlscan id, fingerprint. | `GET /lookup` |
| Key rotation | **Settings → Rotate API key** issues a new key and switches the extension to it. The old key stops working everywhere at once. The new key stays on screen, with a Copy button, until you confirm you saved it, even if the popup closes. | `POST /me/rotate` |

Optional automation (off by default, in **Settings**):

- **Auto-add new wallets** adds high-confidence addresses found on a site to the hub, but only for sites the hub already flags as `scam` or `suspected`. These are attributed to your key.
- **Auto-classify** sends a page's HTML to `/scope` when a site the hub doesn't know shows wallet addresses.

## Footprint

- The toolbar popup opens in the top corner (360 px wide).
- The on-page widget is pinned to the top-right corner. It is at most 300 px wide and 40% of the
  viewport tall, and can be minimised to a small pill or hidden. By default it appears only on
  flagged sites or pages with wallets. You can set it to always (minimised) or never.

## Install

```sh
node build.mjs          # builds dist/chrome, dist/firefox and a .zip of each
```

- **Chrome / Edge / Brave:** go to `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and pick `dist/chrome`.
- **Firefox (128+):** go to `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on**, and pick `dist/firefox/manifest.json`.
  For a permanent install, sign `dist/beaverbusters-checker-firefox-*.zip` through addons.mozilla.org (it can be unlisted).

Then click the toolbar icon (badge `KEY`), paste your hub API key, and press **Verify and save**.

## Privacy and security

- The key is kept in `storage.local` on this device only (never synced), and is sent only in the `X-Api-Key` header to `sdb.netherportal3.com`.
  The extension-page CSP blocks any other connection.
- All API calls run in the background worker. Web pages and content scripts never see the key.
- With **Check every site I visit** on, the hostname of every http(s) site you visit is sent to the hub.
  Turn it off to check only on demand. Sites in the ignored list get no wallet scan and no widget.
  Explorers and the hub itself are ignored by default.
- Page HTML leaves the browser only when you click **Classify page**, submit with **Attach page HTML** ticked, or turn on auto-classify.
- **On-chain volume** sends wallet addresses (never your key or the page) to public explorers: mempool.space, litecoinspace.org, blockcypher.com, blockchair.com, ethplorer.io, binplorer.com, blockscout.com, trongrid.io, xrpscan.com, xrplcluster.com, the Solana public RPC, koios.rest, tonapi.io, toncenter.com, and coingecko.com for prices. By default this happens only when you open the popup; **Settings → On-chain volume** can make it automatic or turn it off. Results are cached for 30 minutes.
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
