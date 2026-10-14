# BeaverBusters web extension

A Chrome and Firefox extension (Manifest V3) for the BeaverBusters workflow. It checks websites and crypto wallet addresses against the BeaverBusters scam database API, finds wallet addresses on pages automatically, and lets you report scams and track your submissions.

The extension stays inactive until an API key is entered.

## Features

| Feature | What happens |
| --- | --- |
| **API key prompt** | On install the settings page opens with a key prompt. The popup shows the same prompt until a key is saved. The key is checked against the API before it is stored, and the toolbar badge reads `KEY` until then. |
| **Live domain checking** | Every top-level navigation is checked as it starts. The badge shows `!` (scam), `?` (suspicious), `✓` (no threats) or a count of flagged wallets. |
| **Scam site blocking** | Known scam sites are replaced by a warning page with "Get me out of here" (returns to the last safe page) and an explicit "continue anyway". Suspicious sites get a banner instead. |
| **Automatic wallet finding** | Pages are scanned for BTC, EVM, Solana, Tron, Litecoin, Dogecoin, XRP, TON, Cardano, BCH and Monero address candidates. They are checked in one batch request when the API has a batch endpoint. Flagged addresses are outlined on the page and listed in the popup. |
| **Wallet checking** | Check any address from the popup, or right-click selected text and choose "Check with BeaverBusters". |
| **Submitted check** | Lookups show whether a domain, wallet or submission ID has already been reported, and its status. The report form warns before you file a duplicate. |
| **Submission** | Report a website or wallet from the popup or the right-click menu. The form fields, required fields and dropdown options come from the API's own schema. |
| **History** | Lists your submissions from the server (if the API supports it) and from this browser, each with a status check. |

## How it uses the API

The extension does as little as possible locally. Lookups, verdicts, wallet validation, chain detection and submissions all happen on the server.

It reads the API's OpenAPI description at runtime (default `https://sdb.netherportal3.com/api/v1/openapi.json`) instead of hard-coding paths:

- Each feature (domain check, wallet check, batch check, page extraction, submit, submission status, list submissions, key verification) is matched to the best endpoint by its path, operation ID, summary and parameters. Destructive and admin endpoints are never chosen.
- Requests are built from the endpoint's declared parameters and request-body schema.
- The API key is sent the way the spec's `securitySchemes` says (for example an `X-API-Key` header or a Bearer token).
- **Settings → Endpoint mapping** shows which endpoint each feature uses and lets you override it. If the server doesn't publish its description, you can import `openapi.json` from a file.

When the server adds an endpoint (a batch check, server-side extraction and so on), the extension picks it up without an update.

### What is sent to the API

- The **domain name** of each page you visit. Full URLs are sent only if you turn on "Send full page URLs".
- **Wallet address candidates** found on pages.
- **Page text**, only if you turn on "Server-side extraction" and the API offers an extraction endpoint. Firefox asks for consent first.
- Whatever you type into a report.

Nothing is sent for local/private addresses, the API's own host, or domains on your trusted list. Results are cached for 30 minutes (configurable). The API key is kept in the extension's local storage and is only ever sent to the API.

## Install

### Build

```sh
npm test         # unit tests (no dependencies needed)
npm run build    # writes dist/chrome, dist/firefox and store-ready .zip files
```

### Chrome / Edge / Brave

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select `dist/chrome`.

### Firefox (140 or newer)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and select `dist/firefox/manifest.json`.

For a permanent install, sign `dist/beaverbusters-firefox-*.zip` through addons.mozilla.org. If Firefox did not grant website access at install, the settings page shows a **Grant access** button.

`src/` can also be loaded unpacked directly while developing. Its manifest carries both the Chrome and the Firefox background keys, so the browser may warn about the one it ignores.

## Development

```
src/
  manifest.json        cross-browser manifest (build trims it per browser)
  background.js        live checks, badge, block page, context menus, message hub
  lib/
    openapi.js         reads the OpenAPI document, maps features to endpoints, builds requests
    api.js             spec loading, auth, caching, feature calls
    verdict.js         turns API responses into scam / suspicious / safe / unknown
    wallets.js         wallet address patterns, domain normalisation (incl. defanged URLs)
    storage.js, config.js, compat.js
  content/             page scanner, highlighting, in-page warnings (shadow DOM)
  popup/               toolbar popup: Site, Wallets, Lookup, Report, History
  options/             API key, settings, API connection, endpoint mapping
  warning/             block page for known scam sites
test/                  node:test unit tests; fixtures/ holds synthetic OpenAPI specs
scripts/build.mjs      per-browser build + zip
scripts/make-icons.py  regenerates icons (Pillow)
```

- `npm run lint:firefox` runs Mozilla's `web-ext lint` on the Firefox build.
- All API traffic goes through the background script. Extension pages and content scripts only send it messages, and content scripts are limited to the page-related ones.

## Status

The API host could not be reached from the environment this was built in, so the endpoint matching has only been exercised against the synthetic specs in `test/fixtures/`. After loading the extension with a real key, open **Settings → Endpoint mapping** to confirm each feature points at the intended endpoint, and override any that don't.
