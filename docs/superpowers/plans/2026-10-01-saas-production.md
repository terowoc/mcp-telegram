# SaaS Production Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the reviewed free SaaS frontend/backend through existing GitHub Actions with isolated deployment and tested rollback.

**Architecture:** A multi-stage image combines pinned frontend assets and Node backend, exposing only the existing localhost port through nginx/Cloudflare. A stopped-service snapshot contains both OAuth/SaaS stores and worker state; immutable image deployments retain existing restricted SSH delivery.

**Tech Stack:** Node 24.15+, Docker Compose, nginx, GHCR/GitHub Actions, existing TLS/Cloudflare hostname rule.

**Spec:** `docs/superpowers/specs/2026-10-01-web-a-saas-design.md`; requires foundation and Web A UI plans complete.

## Global Constraints

- `tg-mcp.azimboev.uz`, only Compose project mcp-telegram, current localhost port 18770; keep all other projects unchanged.
- Initial SaaS defaults 100 users/4 server workers, bounded aggregate CPU/RAM checked before enabling; no unlimited queues.
- Frontend credentials are explicit app build inputs, independent from private server credentials.
- Encryption master key stable across versions and held outside DB snapshots; backup is private, never Git/image/log output.
- GPL notices/corresponding source accompany frontend distribution. No inherited npm/upstream namespace publication.
- Real Telegram login is human QR; no live message sends without a user instruction.

## Review Focus

- SPA fallback must not convert unauthorized API/OAuth/MCP/discovery requests into 200 HTML (Task 1).
- A failed deployment after auth migration must restore one coherent snapshot and matching image, not mix DB generations (Task 2).
- Stopping only the gateway must also stop every child before snapshot; no worker writes during copy (Task 2).
- Cloudflare/nginx/CSP/cache behavior must support Web A workers and native OAuth without widening unrelated origins (Tasks 1–2).
- A free public service must return a capacity response before exhausting other VPS projects' resources (Task 2).

---

### Task 1: Serve frontend and build complete immutable image

**Files:** Create `src/saas/static.ts`; Modify `src/saas/main.ts`, `Dockerfile`, `.dockerignore`, `.github/workflows/{ci,deploy-vps}.yml`; Test `src/__tests__/saas-static.test.ts`, `web-package.test.ts`.

**Interfaces:** `mountSaasFrontend(app:express.Express, {root:string,origin:string,csp:string}):void`; runs after explicit API/OAuth/MCP/discovery routes, static files served from `/app/web`. Build arguments `WEB_TELEGRAM_API_ID`, `WEB_TELEGRAM_API_HASH`; never pass server env/key file into frontend builder.

- [x] **Step 1:** Write failing HTTP tests `reserved_routes_are_never_spa_fallback`, `assets_and_source_archive_are_available`, `csp_separates_frontend_and_oauth`, `anonymous_frontend_does_not_reveal_owner`. Assert 401 API/MCP stays JSON; unknown reserved route404; root serves branded Web A; account/QR responses remain no-store.

```ts
assert.equal(unauthorizedMcp.status, 401);
assert.match(unauthorizedMcp.headers.get('content-type'), /json/);
assert.equal(unknownSaasRoute.status, 404);
assert.match(homeHtml, /TG Bridge/);
assert.match(qrResponse.headers.get('cache-control'), /no-store/);
```
- [x] **Step 2:** Run targeted tests; observe red.
- [x] **Step 3:** Add frontend builder with own lockfile and source packaging, supported Node/npm version, explicit app inputs. Copy built assets/source/license into non-root runtime; preserve backend-only commands. Add CI web mocked build/check/tests and Playwright fixtures; production build requires explicit frontend app credentials configured for distribution. Keep PR jobs free of deployment secrets. Forward pinned output CSP per response route, preserve existing auth strict CSP; immutable fingerprinted assets may cache, index/auth/API may not.
- [x] **Step 4:** Run backend/web tests, types/lint/docs, build Docker with synthetic frontend credential fixtures and fake Telegram backend env; HTTP smoke checks routes/assets/CSP/health. Verify private secret sentinel is absent in image/frontend archive. Expect all checks pass.
- [x] **Step 5:** Commit `feat: build and serve the complete free SaaS image`.

### Task 2: Scoped Compose, coherent rollback and deployment verification

**Files:** Modify `packaging/compose.production.yaml`, `scripts/deploy-vps.sh`; Create `packaging/saas.env.example` if not already created by foundation, `docs/guides/saas-deployment.md`; Test `src/__tests__/deploy-script.test.ts` and `saas-main.test.ts`.

**Interfaces:** Compose runs `saas`, existing auth root includes `oauth.sqlite` and `saas.sqlite`; separate readonly `/run/secrets/session-key` (0600 source), user files volume. `MCP_SESSION_KEY_FILE` points to mounted private key. Graceful close terminates all workers before container stops. Snapshot entire `data/auth` under deployment lock; restore only after replacement is stopped. Image reference remains ghcr.io/terowoc/mcp-telegram@sha256.

- [x] **Step 1:** Write failing tests `snapshot_waits_for_all_workers`, `rollback_restores_matching_user_and_oauth_state`, `encryption_key_is_not_replaced_on_deploy`, `worker_capacity_preserves_http_health`; assert no write occurs during copy, unhealthy replacement restores previous coherent DBs, key identity unchanged and no global Docker mutations.

```ts
assert.ok(events.indexOf('last-worker-exit') < events.indexOf('snapshot-start'));
assert.equal(restoredUserDbVersion, previousUserDbVersion);
assert.equal(restoredOAuthDbVersion, previousOAuthDbVersion);
assert.equal(keyFingerprintAfter, keyFingerprintBefore);
assert.equal(healthAtCapacity.status, 200);
```
- [x] **Step 2:** Run deploy/main test files; observe red.
- [x] **Step 3:** Set default total container memory 3 GiB/CPU1/PIDs128 (4 workers + control), graceful timeout45s with supervisor bounded cleanup; validate actual available VPS resources before applying and reduce maxWorkers/memory if the measured headroom is insufficient. Validate key/config before stopping previous image. Add isolated first-run initialization (master key generation/private backup, no owner grant migration), avoid destructive schema migrations during normal deploy, document schema-version rollback requirement. Compose rollback must restore previous configuration as well as DB/image when changing single-owner→SaaS mode; keep versioned release config and immutable previous pointer.
- [x] **Step 4:** Run synthetic Docker/Compose rollback probe with no real users, including cancellation/worker shutdown and failed migration. Check no unrelated container IDs change, target returns healthy, original key reads persisted sessions. Preflight native production verifies current deploy baseline and memory headroom before any mutation.
- [x] **Step 5:** Commit `feat: deploy SaaS with coherent worker-aware rollback`.

### Task 3: Final review, integration and live handoff

**Files:** Update README/deployment docs and plan checkboxes; follow native executor's ledger/review requirements.

- [x] **Step 1:** Run final full backend tests, typecheck/lint/build/docs plus web check/unit/Playwright and production-like image smoke. Compare tests to spec acceptance, review root/frontend notices and exact pinned source provenance. No claim of exhaustive upstream feature correctness.
- [ ] **Step 2:** Request the one fresh whole-branch review required by native execution. Give reviewer spec, all plans, branch diff and evidence; fix Important/Critical findings with regression tests before integration.
- [ ] **Step 3:** Create/update PR for this feature and attach it to the task; confirm CI. After authorized integration, monitor immutable GitHub Actions deploy and verify public HTTPS/Web A assets/OAuth/MCP, protected SaaS registration/status with isolated test accounts, genuine rollback probe, unchanged unrelated containers.
- [ ] **Step 4:** Show desktop/mobile/light/dark UI screenshots. Ask the human to perform browser Telegram login and separate MCP QR; verify protected status and server session persistence after target-only restart. Do not send real messages to verify chat delivery. Provide endpoint/registration and client setup links; clearly distinguish any remaining human login from completed deployment.
- [ ] **Step 5:** Record verification and any concrete blocker; do not claim whole SaaS complete if credentials, human QR, CI or acceptance still remain.
