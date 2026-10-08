# AGENTS.md

## What this repo is

MITM-based iOS location spoofing, in two halves:

- **Root**: `location-spoofer.js` — a proxy-app script that rewrites Apple `/clls/wloc` protobuf responses — plus platform module wrappers that all reference it: `.sgmodule` (Shadowrocket), `-surge.sgmodule`, `.lnplugin` (Loon), `.snippet` (Quantumult X), `.stoverride` (Stash), `-ios12.sgmodule`. `location-spoofer-qx.js` is the Quantumult X variant.
- **`location-picker/`**: optional map-picker web service feeding coordinates to the modules via `configUrl`. Four API-compatible implementations: `server.js` (Node self-hosted), `worker/` (Cloudflare Worker, Wrangler), `cloudflare-webui/` (single-file Worker for dashboard paste), `vercel/` (Vercel Edge Function + Upstash Redis REST).

## Verify changes

No lint/format config, no root package.json, no CI — these tests are the whole safety net:

- `node test-ios12-compat.js` — core-script regression (BigInt-free varint checked against a BigInt oracle).
- `node --test` in `location-picker/worker/` — page-parity regex tests + Vercel adapter smoke tests; runs on any Node ≥ 18.
- `node tests/module-links.cjs` — integration test; spawns `location-picker/server.js`, **requires Node ≥ 24** (`node:sqlite`). The default `node` on this machine is v20, so this fails locally with `Cannot find module 'node:sqlite'` unless a newer Node is invoked.

## Hard constraints

- **`location-spoofer.js` must parse on iOS 12 JavaScriptCore**: no BigInt syntax (int64 is hand-rolled), ES5 style (`var`, single IIFE). It is dual-mode: exports a CommonJS API when `module` exists (tests rely on this), otherwise runs `runShadowrocket()`. `location-spoofer-qx.js` follows the same pattern.
- **Minimal rewrite is deliberate**: `patchLocation` replaces only Location fields 1/2/3 (lat/lng/horizontalAccuracy); every other field passes through raw. Rewriting more fields makes iOS reject the response ("定位不可用"). `DEFAULT_CONFIG` / `location-spoofer-config.json` still carry altitude/motion keys — legacy, not used by the rewrite path.
- **Duplicated artifacts kept in sync by tests**:
  - The 5-domain MITM hostname list and `argument=` strings are copy-pasted across all six module files; the Loon plugin's argument list is regex-asserted by `worker/test/favorites-and-loon.test.mjs`.
  - `location-spoofer-qx.js` (root) and `location-picker/quantumult-x-template.js` (server template, `__LOCATION_CONFIG_URL__` placeholder) must produce byte-identical rewrites — enforced by `tests/module-links.cjs`.
  - The picker map page exists in **four** copies: embedded in `location-picker/server.js`, `location-picker/worker/src/page.js` (canonical source), `location-picker/cloudflare-webui/worker.js` (**generated merge of `worker/src/page.js` + `worker/src/index.js` — do not hand-edit; no merge script exists in the repo**), and `location-picker/vercel/lib/page.js`. Feature parity is enforced by `worker/test/*.test.mjs`; change one copy, change all.
  - `location-picker/vercel/api/[[...path]].js` is a line-by-line port of `location-picker/worker/src/index.js` (CF KV/env → `process.env` + Upstash REST). Keep route behavior in sync; it is smoke-tested by `worker/test/vercel-adapter.test.mjs`.
- **Zero npm dependencies outside `location-picker/worker/`** (wrangler there is dev-only). `server.js` uses Node built-ins only; the Vercel adapter talks to Upstash over plain `fetch`. Don't add dependencies or a package.json elsewhere.

## Docs & workflow

- Docs and most code comments are Chinese; `README.md` (zh) is canonical. `README.en.md` lags behind (e.g. it still claims motion-state/altitude rewriting that the code no longer does) — trust the code, and update `README.md` first when behavior changes.
- `origin` is a fork (`github-h/ios-location-spoofer`); the module files load scripts from `raw.githubusercontent.com/mekos2772/ios-location-spoofer/main/...` (upstream). Script edits only reach installed modules after landing on upstream `main`.
- Never commit `location-picker/app.db`, `.env`, or `archive/` (gitignored; archives contain user IPs and searched place names).
- Per-platform deploy guides live next to each adapter: `location-picker/worker/README.md`, `location-picker/cloudflare-webui/README.md`, `location-picker/vercel/README.md`, `location-picker/RAILWAY.md`.
