# Telegram Web A MCP UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real Telegram Web A chats with a native-looking MCP panel for the free SaaS.

**Architecture:** Vendor the fixed upstream Web A source in apps/web and preserve its browser MTProto/chat lifecycle. Add a lazily opened panel using Teact and existing UI components; a same-origin API client consumes the foundation contract without exporting browser Telegram session keys. Foundation plan must pass before live panel integration.

**Tech Stack:** Upstream Teact/TypeScript/Vite/SCSS, Node 24.15+, npm 11+, Vitest and Playwright mocked Telegram client.

**Spec:** `docs/superpowers/specs/2026-10-01-web-a-saas-design.md`

## Global Constraints

- Pin upstream Ajaxy/telegram-tt commit `28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80`.
- apps/web is GPL-3.0; preserve copyright, LICENSE, third-party notices and publicly available corresponding source/build instructions.
- Keep real upstream chats, search, media and light/dark themes. New MCP copy is Russian; mobile panel has a back action.
- SaaS is free/open registration; backend foundation supplies personal sessions/rights and capacity defaults 100/4.
- Browser Telegram authorization and server MCP authorization are separate. Never export browser auth keys or embed server secrets.
- No fake connected status, no private tokens in links/instructions, no real outbound test messages.

## Review Focus

- Web A account switching while a panel request is pending must not silently change the SaaS identity (Task 2).
- A expired SaaS cookie or QR must clear private panel state, display re-login/expired state and stop polling (Task 2).
- Service-worker upgrades must not serve cached auth/API/MCP responses (Task 3).
- Small screens and keyboard focus must keep menu/back/2FA/confirmation controls reachable (Task 2).
- A production build missing frontend-specific app credentials must fail instead of using upstream test credentials (Tasks 1 and 3).

## File Map

- `apps/web/UPSTREAM.md`, LICENSE/package-lock/build files: reproducible fork and notices.
- `apps/web/src/components/left/main/LeftSideMenuItems.tsx`: MCP menu entry.
- `apps/web/src/components/mcp/{McpPanel,McpAuth,McpTelegram,McpAccess,McpClients,McpConnectionHelp}.tsx`: focused panel views.
- `apps/web/src/components/mcp/McpPanel.module.scss`: existing-theme responsive layout.
- `apps/web/src/components/mcp/{api,types,useMcpPanel}.ts`: same-origin transport, DTOs and cancellable state.
- `apps/web/src/components/common/MainMenuDropdown.tsx`: panel open/close ownership without modifying chat reducers.
- `apps/web/vite.config.ts`, index/manifest/icons, service worker source discovered in pinned tree: deployment/branding/cache boundaries.
- `apps/web/src/components/mcp/__tests__/` and `apps/web/tests/mcp.spec.ts`: unit/browser regressions.

---

### Task 1: Reproducible Web A fork and build

**Files:** Import pinned source into `apps/web` (exclude .git, checked-in dist, local env, caches and Tauri build outputs); create `UPSTREAM.md`, `.env.example`; Modify root `.gitignore`, package scripts, README licensing notices.

**Interfaces:** `npm --prefix apps/web ci`, `npm --prefix apps/web run build:mocked`, `build:production`, `check`, `test:playwright`; root scripts `web:build`, `web:check`, `web:test`. Build receives `WEB_TELEGRAM_API_ID/HASH` as explicit frontend values mapped to upstream TELEGRAM env only within frontend builder, plus `BASE_URL=https://tg-mcp.azimboev.uz`, `APP_TITLE=TG Bridge`, `APP_NAME=TG Bridge`.

- [x] **Step 1:** Write failing packaging tests `fork_records_exact_upstream_and_license`, `release_requires_frontend_credentials`, `server_secret_inputs_are_not_accepted`; assert pinned SHA/notices and no default/sample credentials. Fixtures supply synthetic app credentials, never production values.

```ts
assert.match(upstreamNotice, /28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80/);
assert.match(frontendLicense, /GNU GENERAL PUBLIC LICENSE/);
assert.notEqual(buildWithoutFrontendCredentials.exitCode, 0);
assert.equal(bundle.includes(serverSecretSentinel), false);
```
- [x] **Step 2:** Run `npx tsx --test src/__tests__/web-package.test.ts`; observe red.
- [x] **Step 3:** Import source, read its applicable AGENTS.md before editing, preserve upstream lockfile/Git-pinned dependencies. Review install scripts before npm ci; never invoke upstream auto-push/release scripts. Add root wrappers with isolated env mapping, replace official branding/icons with own simple SVG assets, record changes/license/source link. Keep backend npm/Bun lockfiles separate and unaffected.
- [x] **Step 4:** Install/build under supported Node 24.15+/npm 11+, run mocked build/upstream checks and packaging tests. Record pre-existing upstream failures explicitly; don't suppress them. No product Telegram network or secrets needed for mocked build.
- [x] **Step 5:** Commit `feat: add pinned GPL Telegram Web A frontend`.

### Task 2: MCP panel, authentication and real backend integration

**Files:** Create MCP view/api/state/types/style files above; Modify `LeftSideMenuItems.tsx`, `MainMenuDropdown.tsx`; Test `apps/web/src/components/mcp/__tests__/api.test.ts`, `state.test.ts`, `apps/web/tests/mcp.spec.ts`.

**Interfaces:**
- `mcpRequest<T>(path:string, options:{method?,body?,csrfToken?,signal?}): Promise<T>` permits only `/api/saas/` relative paths, cookies same-origin, JSON/no-store; throws typed `McpApiError(status,code,retryAfter?)`.
- `useMcpPanel({isOpen,browserTelegramId?})` returns public state/actions for register/login/recover/logout, start/cancel/submit QR password, update policy/revoke grant/disconnect/delete account; creates fresh AbortControllers per identity/request. One polling request at a time, 2-second interval only while visible and attempt alive.
- `McpPanel({isOpen,onClose,browserTelegramId?})` renders state; ephemeral secrets/recovery codes stay in panel memory and are cleared on close/logout/401. Do not store tokens/passwords/codes in Web A global persistent state.
- Backend endpoints/DTOs come from foundation Task 4, copied as public frontend types without importing server Node code.

- [x] **Step 1:** Write failing tests `api_rejects_external_urls_and_adds_csrf`, `closing_panel_cancels_poll_and_clears_secrets`, `account_switch_preserves_saas_identity_and_warns_mismatch`, `late_result_cannot_restore_previous_identity`, `qr_expiry_and_401_do_not_claim_connection`. Assert request logs contain no browser Telegram session export; password only goes to current attempt body, not query/global cache.

```ts
await expect(mcpRequest('https://other.invalid/api/saas/me', {})).rejects.toThrow();
expect(lastRequest.headers['X-CSRF-Token']).toBe(csrfToken);
expect(stateAfterClose.recoveryCodes).toBeUndefined();
expect(stateAfterAccountSwitch.user.id).toBe(saasUserId);
expect(stateAfterExpiredQr.telegram.state).not.toBe('connected');
```
- [x] **Step 2:** Run frontend Vitest test files; observe red.
- [x] **Step 3:** Add menu entry and lazy overlay following existing UI/Teact hooks. Use upstream Button/Modal/Input conventions and theme variables. Views: register/login/recover + one-time recovery-code display; distinct browser/server Telegram states; QR/2FA/cancel/error/retry; read/full and canonical chat IDs with confirmation; client consent/revocation; disconnect/delete current-password confirmation; copy MCP URL and client-specific OAuth guidance. On uncertain mutation timeout refresh status, never automatically replay. Account switching warns on mismatch and never reassigns server session. Initial `/me`401 is signed-out, not global error. Escape/render metadata as text.
- [x] **Step 4:** Browser tests use upstream mocked Telegram and fixture SaaS HTTP responses: open menu/back, registration, QR→2FA→connected, mismatch, expired cookie, grant revoke, recovery and confirmations. Verify keyboard focus and 390px/1440px widths in dark/light themes; capture screenshots. Assert chats still list/read/send via mock transport while panel opens/closes. Run one integration browser flow against foundation's fake-worker backend, not only static route stubs.
- [x] **Step 5:** Commit `feat: add Telegram Web A MCP onboarding and access panel`.

### Task 3: Runtime cache, security and distributable source

**Files:** Modify `apps/web/vite.config.ts`, service worker implementation identified via pinned source, `index.html`, manifests; Create source/license view and `docs/guides/web-a.md`; extend `web-package.test.ts`/Playwright.

**Interfaces:** `apps/web/dist` is production artifact; root `scripts/package-web-source.mjs` emits corresponding-source archive and license notices into frontend assets, excluding .env/node_modules/caches/credentials; `UPSTREAM.md` documents fork updates and exact changed files. SaaS API/MCP/OAuth are never service-worker cached or SPA navigations.

- [x] **Step 1:** Write failing tests `worker_bypasses_saas_oauth_mcp_and_discovery`, `source_archive_contains_build_inputs_not_secrets`, `production_base_is_our_origin`, `frontend_build_has_no_server_secret_sentinels`.

```ts
assert.equal(cachedPaths.some((path) => path.startsWith('/api/saas')), false);
assert.equal(archivePaths.includes('.env'), false);
assert.equal(archivePaths.includes('LICENSE'), true);
assert.equal(productionManifest.start_url.startsWith('https://web.telegram.org'), false);
```
- [x] **Step 2:** Run packaging/browser tests; observe red.
- [x] **Step 3:** Keep upstream asset/Telegram caching, explicitly bypass `/api/saas`, `/oauth`, `/interaction`, `/mcp`, `/.well-known`. Use existing upstream CSP endpoint needs plus same-origin API, derive static CSP from pinned build; don't relax OAuth policy. Ensure production asset/base/manifest URLs target our hostname. Provide source archive/LICENSE/UPSTREAM/build instructions with source link visible in MCP panel. A deployment version change clears outdated panel data without disturbing browser Telegram sessions.
- [x] **Step 4:** Run web check/unit/Playwright/mocked build and packaging assertions. Run production build with synthetic credential fixtures to test non-mocked bundling, no real login; source archive reproducible and downloadable. Root backend tests still pass.
- [x] **Step 5:** Commit `feat: package Web A sources and secure SaaS runtime caching`.
