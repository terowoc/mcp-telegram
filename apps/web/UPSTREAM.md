# TG Bridge — Telegram Web A fork

Upstream: https://github.com/Ajaxy/telegram-tt
Pinned commit: `28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80`
Upstream release: 12.0.45
License: GPL-3.0-or-later (see LICENSE). Upstream copyright and third-party notices are preserved.

TG Bridge adds a separate MCP account panel to the existing Telegram Web A chat application. Browser Telegram sessions remain inside Web A; server MCP device sessions are independent. The backend elsewhere in this repository retains its MIT license. Do not label this frontend as MIT.

## Reproduce the frontend

Use Node 24.15+ or Node 26 and npm 11 or 12:

```sh
npm --prefix apps/web ci --allow-git=all
npm run web:build:mocked
npm run web:check
# Explicit browser application credentials, separate from server credentials:
WEB_TELEGRAM_API_ID=your_browser_app_id WEB_TELEGRAM_API_HASH=your_browser_app_hash npm run web:build
```

The root builder copies only explicit frontend inputs to the isolated frontend process. Vite does not load local dotenv files. Server TELEGRAM_API_*, 2FA passwords, vault paths and MCP credentials are not forwarded. Never run the upstream auto-push release script. Local .env files, dependencies, caches, checked-in dist and Tauri build outputs are excluded from this fork import.

Corresponding source: https://github.com/terowoc/mcp-telegram/tree/main/apps/web
A release source archive with the build scripts and lockfile is distributed with the frontend.

## Fork changes

- Isolated root build wrapper and frontend credential example.
- TG Bridge title, manifest and original SVG app marks.
- MCP onboarding/access panel, same-origin browser API and source link.
- Explicit service-worker bypass for SaaS, MCP, OAuth and discovery routes.

To update upstream, record a new exact commit here, preserve the lockfile and licensing notices, and review the MCP/menu/cache integration against the new Teact UI and service worker before publishing.

## Changed integration files

- `index.html`, public manifests/marks, `vite.config.ts`, `package.json`, `package-lock.json`, `.env.example`: branding and explicit isolated build.
- `src/components/{common/MainMenuDropdown,left/main/LeftSideMenuItems}.tsx`, `src/bundles/extra.ts`: lazy MCP menu/panel.
- `src/components/mcp/`, localization fallback and generated language types: SaaS authentication, independent QR device, grants, rights and client help.
- `src/components/ui/Modal.tsx`, `src/util/captureKeyboardListeners.ts`: native dialog keyboard/cancel listeners are installed before paint and take priority over background handlers.
- `src/serviceWorker/{saasCache,service.worker}.ts`: private-route cache bypass.
- `src/lib/gramjs/client/MockClient.ts`, synthetic mcp scenario/middleware, `tests/`: offline acceptance harness.
- `SOURCE_FILES.json`: exact distribution inventory; root `scripts/{build-web,package-web-source}.mjs`: reproducible build/archive entrypoints.

The source archive is made from the current build inputs, with stable tar timestamps, ownership and gzip output. Only inventory files enter it. Updating the fork requires updating this inventory with reviewed public source files. `/source/README.md`, `LICENSE.txt`, `UPSTREAM.md` and `SHA256SUMS` accompany the downloadable archive.
