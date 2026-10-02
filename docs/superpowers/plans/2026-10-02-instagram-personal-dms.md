# Personal Instagram DMs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add isolated personal Instagram connections, dashboard login, and read/send tools to hosted SaaS MCP.

**Architecture:** Node owns account storage, consent, policies, encryption, deadlines, and send deduplication. A persistent Python subprocess wraps pinned instagrapi through bounded JSON frames. Telegram interfaces remain compatible.

**Tech Stack:** TypeScript, node:sqlite, Express, MCP SDK, Python 3.11+ and instagrapi 3.0.18.

**Spec:** `docs/superpowers/specs/2026-10-02-instagram-personal-dms-design.md`

## Global Constraints

- Hosted SaaS only; `MCP_INSTAGRAM_ENABLED=1`, disabled by default.
- Five Instagram slots per owner, read-only by default, explicit UUID account selection.
- Decimal external IDs up to 64 digits; 100 allowed threads; chat limit 1–20, message limit 1–50, send text 1–1,000 Unicode code points.
- No persisted passwords/codes or raw upstream output. Session plaintext 64 KiB, envelope 96 KiB; frames 256 KiB.
- Shared process budget, one upstream operation per connection, four queued requests; startup 10 seconds, tools 45 seconds, login 5 minutes.
- UUID send keys retained for 24 hours, at most 2,000 per connection; uncertain writes never retried.
- Unsupported challenges require official-app verification; no QR promise, realtime subscriptions, or new conversations.
- Russian dashboard; no deployment or live send without separate authorization.

## Review Focus

- Late login completion after disconnect must not recreate a cleared session (Task 2).
- Internal dependency retries must not duplicate writes (Task 1).
- Mixed Telegram/Instagram selectors must fail at actual dispatch (Task 3).
- Account deletion during an active login must drain before database teardown (Tasks 2–3).
- Instagram-only users must reach MCP setup and OAuth continuation (Task 4).

---

### Task 1: Contracts, persistence, Python adapter, and packaging

**Files:** Create `src/instagram/types.ts`, `policy.ts`, `store.ts`, `vault.ts`, `worker.py`, `src/__tests__/instagram-store.test.ts`, `src/__tests__/instagram-worker.test.py`, `packaging/instagram/requirements.in`, `requirements.txt`; modify `src/saas/store.ts`, `Dockerfile`, `package.json`; create `scripts/copy-instagram-worker.mjs`.

**Interfaces:** `InstagramStore(db, activeOwner, invalidate)` owns transactional connection mutations and send requests. `InstagramVault(key).encrypt(owner,id,state)/decrypt(owner,id,envelope)` isolates encrypted settings. Python accepts init/login/code/tool/shutdown frames and returns ready/event/result/session frames. `InstagramPolicy.visible(name)` and `.authorize(name,args)` enforce profile/thread scope.

- [ ] Write store tests for two-owner denial, five-slot capacity, duplicate verified identities, version-4 migration, ciphertext swapping, unknown settings, deduplication and retention limits. Write Python tests with injected clients/transports for restore without password login, CAA/2FA state, no read receipt mutation, bounded responses, safe error mapping, and disabled write retries.
- [ ] Run `npx tsx --test src/__tests__/instagram-store.test.ts` and `python3.12 -m unittest discover -s src/__tests__ -p 'instagram-worker.test.py'`; expect missing-module failures before implementation.
- [ ] Implement contracts and storage, including cooldown and removal markers; expose `SaasStore.instagram` over the existing database after transactional schema-5 migration. Implement the domain-separated vault and Python adapter, normalize only supported outputs, and keep credential state transient.
- [ ] Pin instagrapi and lock dependencies with hashes in a Python virtualenv; validate imports and tagged version. Package the worker in build/npm outputs and the read-only production runtime.
- [ ] Re-run the two focused test commands; expect all passing. Commit the Task 1 files with `feat: add Instagram storage and Python adapter`.

### Task 2: Supervisor and login lifecycle

**Files:** Create `src/instagram/supervisor.ts`, `login-attempts.ts`, `protocol.ts`, `src/__tests__/instagram-supervisor.test.ts`, and `fixtures/instagram-worker.mjs`; modify `src/saas/worker-budget.ts` and `main.ts`.

**Interfaces:** `InstagramSupervisor({store,vault,budget,python,workerPath,filesRoot,idleMs,spawn?})` provides `validateRuntime()`, `status(owner,id)`, `call(owner,id,name,args,{signal?})`, `startLogin(owner,id,credentials)`, `submitCode(owner,id,attempt,code)`, `attempt(owner,id,attempt)`, `cancelLogin(owner,id,attempt)`, `stop(id)`, `clearOwner(owner)`, `evictIdle()` and `close()`.

- [ ] Write real subprocess-fixture tests for framing, bounded output, stale generations, restore, cross-owner calls, capacity across both supervisors, startup failure, queue overflow, timeout/duplicate send handling, login/code/expiry/cancel, and delayed saves after disconnect.
- [ ] Run `npx tsx --test src/__tests__/instagram-supervisor.test.ts`; expect missing-supervisor failure.
- [ ] Implement Node subprocess admission and bounded framing, generation/attempt checks, sanitized configuration, session persistence, persisted send state transitions and safe cooldowns. Login-start acknowledges while the worker operates; credential submissions clear temporary Node references. All teardown paths await exit before releasing leases.
- [ ] Compose shared idle reclaim in SaaS startup. Enabled runtime validation checks interpreter and library; disabled startup never checks Python. Ensure startup errors close all resources.
- [ ] Run supervisor tests and existing worker-budget/main tests; expect all passing. Commit with `feat: supervise isolated Instagram connections`.

### Task 3: Browser routes, MCP dispatch, and consent

**Files:** Create `src/instagram/routes.ts`, `tools.ts`, `src/__tests__/instagram-routes.test.ts`, `instagram-mcp.test.ts`; modify `src/saas/routes.ts`, `identity.ts`, `types.ts`, `main.ts`, and `src/http/tool-catalog.ts`.

**Interfaces:** `registerInstagramTools(server,policy)` registers the five spec tools. `createInstagramRoutes({auth,store,supervisor,revokeGrants})` supplies the spec's account/login endpoints. Extend `createSaasIdentity` with an optional Instagram context; old callers and disabled mode continue to work.

- [ ] Write route tests for Origin/CSRF and recent authentication, foreign/unknown IDs, strict input bounds, credentials excluded from response, policy revocation, disconnect, cabinet logout/recovery/deletion, and disabled feature. Write actual hosted MCP tests for explicit account routing, mixed selectors, read-only sends, allowlist filtering, bounded history, stale grants/consent, and Instagram-only catalogs.
- [ ] Run `npx tsx --test src/__tests__/instagram-routes.test.ts src/__tests__/instagram-mcp.test.ts`; expect missing-routes/tools failures.
- [ ] Implement the spec's endpoint paths; reuse cabinet authentication/mutation boundaries, synchronously revoke store grants on changed access, and drain workers before owner deletion. Include safe Instagram summaries in `/me`.
- [ ] Compose Instagram catalog visibility and dispatch separately from Telegram schemas/policies. Include Instagram identities/policies in consent and access copy; exclude credentials and local connection management from MCP.
- [ ] Run focused tests and existing hosted catalog/OAuth/multiple-account tests; expect all passing. Commit with `feat: expose Instagram connections through hosted MCP`.

### Task 4: Dashboard and deployment documentation

**Files:** Modify `apps/dashboard/api.ts`, `app.ts`, `style.css`, `packaging/saas.env.example`, `packaging/compose.production.yaml`, `docs/guides/saas-deployment.md`, `README.md`; create `src/__tests__/dashboard-instagram.test.ts` and `instagram-packaging.test.ts`.

**Interfaces:** Cabinet DTO adds optional Instagram enabled/accounts state. Existing request helper remains same-origin; Instagram paths are never modified by selected Telegram account. Instagram navigation manages connections and their login/policy lifecycle.

- [ ] Write dashboard execution tests for add/login/code/cancel/manual-verification states, cleared credential inputs, selection, policy updates, foreign labels escaped, errors, feature-disabled navigation, and Instagram-only MCP/OAuth continuation. Write packaging checks for worker distribution, Python runtime, pinned dependencies, feature flag and rollback instructions.
- [ ] Run `npx tsx --test src/__tests__/dashboard-instagram.test.ts src/__tests__/instagram-packaging.test.ts`; expect missing-feature failures.
- [ ] Implement Russian Instagram controls using the existing dashboard style. Make MCP setup depend on any connected protocol, preserve Telegram selectors, and clear credentials before asynchronous calls. Document runtime setup, official-app challenge recovery, 24-hour send deduplication, grant reconnects, and schema-matched rollback.
- [ ] Run focused tests, `npm run web:check`, and `npm run web:build`; expect successful output. Commit with `feat: add Instagram cabinet controls`.

### Task 5: Integrated validation and review

**Files:** Add integrated regressions to the preceding tests; update plan checkboxes and the execution ledger.

**Interfaces:** The final branch implements all contracts from Tasks 1–4 and the acceptance list in the spec.

- [ ] Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run web:check`, `npm run web:build`, `npm run build`, and Python adapter tests with the pinned environment. Expect zero failing tests/checks.
- [ ] Validate the production image build when the local Docker daemon is available and inspect the packaged worker/library runtime. If unavailable, preserve reproducible build commands and report image execution as unverified; do not simulate success.
- [ ] Review the full branch against the spec, especially the five Review Focus cases, with a fresh reviewer under the executing-plans skill; address correctness findings and re-run affected checks.
- [ ] Commit any verified fixes. Report exact tests, local paths, activation configuration, and remaining live-account/image limitations. A real login/read smoke check needs user participation, and a real send needs a named authorized recipient. Do not deploy or claim live delivery without that evidence.

## Execution record

The user approved the written spec and explicitly requested implementation. Execute inline to satisfy the requested fastest path; keep implementation rulings in the execution ledger. Existing untracked `artifacts/` belongs to the user and is excluded from staging. Work in the current checkout unless an already-attached suitable isolated checkout is available; do not create an additional approval round for routine reversible setup.
