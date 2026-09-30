# SaaS Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A testable SaaS backend with isolated users, encrypted Telegram sessions, QR/2FA and user-bound MCP OAuth.

**Architecture:** A control process owns SQLite, browser authentication, encryption and OAuth. It supervises at most four independent Telegram worker processes, each fixed to one user; workers use authenticated parent IPC for session persistence and never receive the encryption key. Single-owner modes remain compatible.

**Tech Stack:** Node 24.15+, TypeScript, Express, node:sqlite/crypto/child_process, existing oidc-provider, GramJS, node:test/tsx.

**Spec:** `docs/superpowers/specs/2026-10-01-web-a-saas-design.md`

## Global Constraints

- Free, public registration; default 100 accounts, 4 active workers, 1 server Telegram account per SaaS user.
- No billing, SMTP or external identity service. Passwords use scrypt; one-time recovery codes are hashed.
- AES-256-GCM sessions with unique nonce and user ID as AAD; no plaintext session files or legacy migration in SaaS.
- Separate user file roots; 20 MiB media and existing 1 MiB HTTP/2 MiB response ceilings.
- Secure/HttpOnly/SameSite browser cookie, CSRF and Origin protection, bounded per-user and aggregate load.
- Only the existing Compose project/vhost may change. No Docker socket, global prune or unrelated restarts.
- No real outbound messages in tests. Live QR is performed by the human user.

## Review Focus

- Concurrent recovery/registration at a capacity boundary must consume a code once and never exceed 100 accounts (Task 1).
- Injected store failures must fail login/persistence visibly instead of reporting success with an unsaved session (Task 2).
- A delayed worker exit or old IPC response after respawn must not mutate the replacement user's state (Task 3).
- Changing rights or deleting a user while a request is in flight must deny new operations and revoke existing grants (Tasks 4–5).
- Cancellation, QR expiry or another user's attempt ID must not release a password into the wrong attempt (Task 4).

## File Map

- `src/saas/types.ts`: shared user/policy/login/status and IPC contracts, no secrets in public DTOs.
- `src/saas/store.ts`: transactional users, browser sessions, recovery codes, encrypted-session records and grant bindings.
- `src/saas/session-vault.ts`: encryption envelope and key loading from a private file.
- `src/saas/auth.ts`: registration/login/recovery, opaque browser session and CSRF tokens.
- `src/telegram-session-store.ts`: injected session storage interface, with existing file mode compatibility.
- `src/saas/worker.ts`, `src/saas/worker-protocol.ts`, `src/saas/supervisor.ts`: fixed-user execution and lifecycle.
- `src/saas/routes.ts`, `src/saas/login-attempts.ts`: protected browser APIs and transient QR/2FA.
- `src/http/identity.ts`, `src/http/mcp-handler.ts`: reusable identity boundary and MCP transport.
- `src/saas/identity.ts`, `src/saas/main.ts`: SaaS identity implementation and CLI composition.

---

### Task 1: Transactional accounts, authentication and vault

**Files:** Create `src/saas/{types,store,auth,session-vault}.ts`; Test `src/__tests__/saas-{store,auth,vault}.test.ts`; reuse `src/http/owner.ts` password functions.

**Interfaces:**
- `UserPolicy = { profile: 'read' | 'full'; chatIds: string[]; version: number }`.
- `UserRecord = { id: string; login: string; passwordHash: string; policy: UserPolicy; disabled: boolean }`.
- `SaasStore` supplies `register(login,passwordHash,recoveryHashes): UserRecord`, `findUser(id)`, `findByLogin(login)`, `consumeRecovery(login,codeHash,newPasswordHash): boolean`, `putBrowserSession(idHash,userId,csrfHash,expiresAt)`, `findBrowserSession(idHash)`, `revokeUserSessions(userId)`, `getEncryptedSession(userId)`, `putEncryptedSession(userId,envelope)`, `deleteEncryptedSession(userId)`, `updatePolicy(userId,policy): number`, `bindGrant(userId,grantId,clientId,version)`, `findGrant(grantId)`, `revokeUserGrants(userId): string[]`, `disableUser(userId)` and `close()`.
- `createSaasStore(path: string, options?: { maxUsers?: number }): SaasStore`; registered IDs are random UUIDs, not user-supplied directory names.
- `SessionVault(key: Buffer)` supplies `encrypt(userId,session): string`, `decrypt(userId,envelope): string`; `loadVaultKey(path): Promise<Buffer>` validates an existing private 32-byte key, never regenerates on malformed/missing production input.
- `SaasAuth(store,{csrfKey:Buffer})` supplies `register(login,password): Promise<{ userId; sessionToken; csrfToken; recoveryCodes: string[] }>`, `login(login,password): Promise<{userId;sessionToken;csrfToken}|undefined>`, `authenticate(sessionToken): { userId; csrfHash; csrfToken } | undefined`, `recover(login,code,newPassword): Promise<boolean>`, `logout(sessionToken)`; session/recovery tokens are 32 random bytes and only SHA-256 hashes are stored. CSRF token is HMAC-SHA256 of the raw browser session token under a persistent server-only cookie key, so `/me` regenerates it and concurrent tabs share the same valid token without storing plaintext.

- [ ] **Step 1:** Write failing behavior tests: `registration_capacity_is_atomic`, `recovery_code_is_single_use`, `passwords_and_tokens_are_not_plaintext`, `session_expiry_and_disabled_user`, `ciphertext_is_bound_to_user_and_detects_tampering`. Assert 101st registration fails at maxUsers=100, two recovery attempts yield one success, recovery revokes all sessions/grants, two encryptions differ, decrypt with another user/key or changed tag throws.

```ts
assert.equal([firstRecovery, secondRecovery].filter(Boolean).length, 1);
assert.equal(auth.authenticate(oldSessionToken), undefined);
assert.notEqual(vault.encrypt(userA, session), vault.encrypt(userA, session));
assert.throws(() => vault.decrypt(userB, vault.encrypt(userA, session)));
```
- [ ] **Step 2:** Run `npx tsx --test src/__tests__/saas-{store,auth,vault}.test.ts`; observe missing modules/contracts failing.
- [ ] **Step 3:** Implement transactional SQLite store under `data/auth/saas.sqlite`, WAL/busy timeout and schema version. Normalize login as lowercase ASCII `[a-z0-9_]{3,32}`, password 16–1024 characters; initial policy read/unrestricted. Browser sessions expire after 24 hours, create 8 recovery codes, recovery purges their prior set atomically. Use parameterized SQL; grant revocation marker is committed before any asynchronous provider cleanup. Encrypt envelope version/nonce/tag/ciphertext with `userId` AAD; secret files 0600 and directories 0700.
- [ ] **Step 4:** Run the three tests, `npm run typecheck`, `npm run lint`; expected pass. Verify reopened SQLite preserves valid users/encrypted data and expired rows are denied.
- [ ] **Step 5:** Commit `feat: add isolated SaaS accounts and encrypted session vault`.

### Task 2: Injectable Telegram session persistence and transient 2FA

**Files:** Create `src/telegram-session-store.ts`; Modify `src/telegram-client.ts`; Test `src/__tests__/saas-telegram-session.test.ts`, extend `src/__tests__/two-factor-login.test.ts`.

**Interfaces:**
- `TelegramSessionStore = { load(): Promise<string | undefined>; save(session: string): Promise<void>; clear(): Promise<void>; hasSession(): boolean }`.
- Add optional `sessionStore?: TelegramSessionStore` to TelegramService constructor options. `sessionPath` remains available for unique operational identity/file-root compatibility, but injected mode does not read, write or unlink it.
- Add optional fourth argument `loginOptions?: { requestPassword?: (signal: AbortSignal) => Promise<string | undefined> }` to `startQrLogin`; injected callback takes precedence and never falls back to process env.
- Existing file mode, standalone QR/CLI and API signatures retain current behavior.

- [ ] **Step 1:** Write failing tests `injected_store_never_touches_plaintext_or_legacy_file`, `logout_clears_only_injected_store`, `failed_save_fails_qr_login`, `two_factor_password_wait_is_cancellable`. Assert a sentinel legacy file remains unchanged; another user's store survives logout; failed persistence cannot produce successful login; callback receives attempt's signal, cancellation tears down transport and no env password is used.

```ts
assert.equal(await readFile(legacyPath, 'utf8'), legacySentinel);
assert.equal(await userBStore.load(), userBSession);
assert.equal(failedPersistenceLogin.success, false);
assert.equal(passwordCallbackSignal.aborted, true);
```
- [ ] **Step 2:** Run `npx tsx --test src/__tests__/saas-telegram-session.test.ts src/__tests__/two-factor-login.test.ts`; observe failures before implementing.
- [ ] **Step 3:** Route load/save/clear/diagnostics and logout verification through the injected store. Persist session before reporting QR success; clear/destroy temporary client on failure. Await callback only after `SESSION_PASSWORD_NEEDED`; dispose transient reference at settlement. Preserve current file mode migration and tests.
- [ ] **Step 4:** Run those tests plus `npx tsx --test src/__tests__/client-teardown.test.ts src/__tests__/telegram-logout.test.ts`; expected pass.
- [ ] **Step 5:** Commit `feat: inject Telegram session storage and transient two factor input`.

### Task 3: Fixed-user workers and bounded supervisor

**Files:** Create `src/saas/{worker-protocol,worker,supervisor}.ts`; Test `src/__tests__/saas-workers.test.ts` and `src/__tests__/saas-worker-integration.test.ts`; reuse ToolExecutor/FilePolicy/ToolPolicy.

**Interfaces:**
- `WorkerInit = { userId; generation: string; apiId: number; apiHash: string; fileRoot: string; policy: UserPolicy; session?: string }`.
- Parent requests: `{ generation,id,kind:'tool',name,args }`, `{ generation,id,kind:'login-start',attemptId }`, `{ generation,id,kind:'login-password',attemptId,password }`, `{ generation,id,kind:'cancel' }`, `{ generation,id,kind:'shutdown' }`.
- Child messages: correlated result/error/qr/needs-password/ready, and `session-save`/`session-clear` requiring parent ACK before success. Validate with zod, frame limit 4 MiB; passwords/session values never logged.
- `WorkerSupervisor({store,vault,apiId,apiHash,filesRoot,maxWorkers?:4,idleMs?:300000,spawn?})` supplies `call(userId,name,args,{signal}?)`, `startLogin(userId,attemptId,onEvent)`, `submitPassword(userId,attemptId,password)`, `cancelLogin(userId,attemptId)`, `status(userId)`, `stopUser(userId)`, `close()`.
- `spawn` seam has type `typeof import('node:child_process').fork`; default forks the compiled worker entry with explicit execArgv/environment. Test fixtures may substitute Node ChildProcess-compatible IPC or a transpiled test worker; production does not inherit arbitrary parent execArgv.
- `LoginEvent = { type:'qr'; dataUrl; expiresAt } | { type:'needs-password' } | { type:'success'; account:{ id; username? } } | { type:'error'; code }`.

- [ ] **Step 1:** Write failing tests `workers_never_share_identity_policy_or_session`, `capacity_includes_starting_and_stopping_workers`, `stale_generation_cannot_save_session`, `cancelled_call_retains_settlement_exclusivity`, `idle_worker_releases_slot`, `shutdown_waits_for_workers`. Assert 5th simultaneous admission fails with CapacityError/retryAfter; cancelled pending acquisition consumes no slot; A/B tool calls use distinct instances/files, parent's source binding rejects spoofed IDs and old generation ACKs.

```ts
assert.equal(fakeChildren.length, 4);
await assert.rejects(supervisor.call(fifthUser, 'telegram-status', {}), /capacity/i);
assert.equal(store.getEncryptedSession(userA), currentCiphertext);
assert.notEqual(childForA.pid, childForB.pid);
```
- [ ] **Step 2:** Run `npx tsx --test src/__tests__/saas-workers.test.ts src/__tests__/saas-worker-integration.test.ts`; observe red.
- [ ] **Step 3:** Implement child_process.fork with a minimal environment allowlist; no inherited vault key/owner password/2FA. Set fixed user roots and policy before tool imports; use captured handler ToolExecutor, shared lock, existing 28-second deadline/5-second fail-stop, no unbounded wait queue. Reserve slots synchronously during spawn/stop, unique generation, 10-second startup deadline, SIGTERM then SIGKILL after 5 seconds. Stop idle settled workers after 5 minutes; never idle-kill active QR/tool. Node worker heap limit 256 MiB; container supplies total RSS bound. Parent encrypts acknowledged writes atomically. Shutdown forbids admission and drains/stops all children before database close.
- [ ] **Step 4:** Run tests and real fork fixture using mocked Telegram transport (no Telegram network). Assert two children and correct teardown; typecheck/lint pass.
- [ ] **Step 5:** Commit `feat: supervise isolated bounded Telegram workers`.

### Task 4: Protected SaaS browser APIs and QR state machine

**Files:** Create `src/saas/{routes,login-attempts}.ts`; Test `src/__tests__/saas-routes.test.ts`.

**Interfaces:** `createSaasRoutes({auth,store,supervisor,publicUrl,revokeGrants}): express.Router`; all DTOs in `types.ts` exclude session keys/hash/password.
- POST `/api/saas/register` `{login,password}`; POST `/login` same; POST `/recover` `{login,recoveryCode,newPassword}`; POST `/logout`.
- GET `/me` returns `{user:{id,login},csrfToken,policy,telegram,mcpUrl}` or 401.
- POST `/telegram/login` creates attempt; GET `/telegram/login/:attemptId` returns latest user-bound state; POST `/telegram/login/:attemptId/password`; DELETE same path cancels.
- GET `/clients`; DELETE `/clients/:grantId`; PUT `/policy` `{profile,chatIds}`; POST `/telegram/disconnect`; DELETE `/account` with current password confirmation.
- Successful register/login sets `__Host-mcp-saas` cookie; mutations require same-origin and X-CSRF-Token except initial register/login/recover, which still require same Origin. Never derive user ID from request JSON.

- [ ] **Step 1:** Write failing HTTP tests `anonymous_and_cross_origin_mutations_are_denied`, `foreign_attempt_and_grant_return_404`, `qr_password_cancel_and_expiry`, `policy_change_revokes_grants_and_stops_worker`, `delete_account_purges_active_access`, `capacity_has_retry_after`. Assert no QR/password reaches B's worker, stale attempt cannot restart login, disconnect clears only A's server session and revokes grants; browser Web A session is unaffected.

```ts
assert.equal(anonymousMe.status, 401);
assert.equal(crossOriginMutation.status, 403);
assert.equal(foreignAttempt.status, 404);
assert.equal(capacityResponse.status, 503);
assert.ok(capacityResponse.headers.get('retry-after'));
```
- [ ] **Step 2:** Run `npx tsx --test src/__tests__/saas-routes.test.ts`; observe red.
- [ ] **Step 3:** Implement login attempts with one per user, 6-minute TTL, 5-minute Telegram QR deadline, event state hidden behind authenticated polling/no-store. Password route max 8 KiB, callback waits under attempt abort signal. Generic auth/recovery errors avoid login enumeration. Apply per-IP login/recovery 10 attempts/15 minutes, register 5/hour plus aggregate 20/hour, QR 3/10 minutes per user, authenticated API 120/minute per user plus aggregate 600/minute. Policy change commits new version/revoked bindings before worker stop; existing operation may settle but new calls fail. Recovery/disconnect/delete coordinate grant invalidation and worker stop; account disable precedes purge. DTOs redact internal errors.
- [ ] **Step 4:** Run HTTP tests with two cookie jars and fake supervisor; expected pass. Inspect responses/log capture for secrets; typecheck/lint pass.
- [ ] **Step 5:** Commit `feat: add protected SaaS onboarding and access controls`.

### Task 5: Reusable gateway identity and user-bound OAuth MCP

**Files:** Create `src/http/{identity,mcp-handler}.ts`, `src/saas/identity.ts`; Modify `src/http/gateway.ts`; Test `src/__tests__/saas-oauth.test.ts`, retain `http-gateway.test.ts`.

**Interfaces:**
- `GatewayIdentity`: `findAccount(id:string,grantId?:string): {accountId:string;claims:()=>Promise<{sub:string}>}|undefined`, `authenticate({login?,password}): Promise<string|undefined>`, `isActive(id): boolean`, `bindGrant(accountId,grantId,clientId): void`, `isGrantValid(accountId,grantId): boolean`, `toolPolicy(accountId): ToolPolicy`, `callTool(accountId,name,args,options?): Promise<unknown>`.
- Optional `identity?: GatewayIdentity` on GatewayOptions; absence adapts existing ownerPasswordHash/callTool, preserving owner tests.
- `createSaasIdentity(store,auth,supervisor): GatewayIdentity`; validates stored grant owner/current policy version on EVERY MCP request.
- Gateway exposes `revokeGrants(ids: string[]): Promise<void>` via provider adapter; database validity markers make failed async cleanup fail closed.

- [ ] **Step 1:** Write failing PKCE HTTP tests `tokens_route_to_their_owner`, `old_owner_grant_never_becomes_guest_grant`, `policy_change_invalidates_existing_access_and_refresh`, `inactive_account_and_foreign_grant_are_denied`, `read_profile_list_and_call_agree`. Assert two users' tools reach only their worker; impersonation via tool args cannot alter routing; token resource mismatch fails; rights checks apply to initialize/list/call.

```ts
assert.equal(lastWorkerUser, authenticatedUserA);
assert.equal(oldGrantMcpResponse.status, 401);
assert.equal(oldGrantRefreshResponse.status, 400);
assert.equal((await oldGrantRefreshResponse.json()).error, 'invalid_grant');
assert.equal(readTools.some((tool) => tool.name === 'telegram-send-message'), false);
```
- [ ] **Step 2:** Run `npx tsx --test src/__tests__/saas-oauth.test.ts src/__tests__/http-gateway.test.ts`; observe new failures with legacy tests green.
- [ ] **Step 3:** Extract only identity-dependent login/consent/token routing and MCP transport, reuse protocol safeguards/provider. SaaS interaction displays login plus password and current read/full/chat policy; escapes client metadata, same CSRF binding. Register each consent grant in SaasStore. Filter tools/list and execution consistently with current user policy; SaaS MCP hides telegram-login/logout (browser API owns onboarding/disconnect). Before setup only telegram-status is available. Reject inactive user or invalid grant and revoke provider record before allowing refresh; no token query parameters. Keep anonymous health redacted.
  Pass `token?.grantId` from oidc-provider's `findAccount(ctx,id,token)` to the identity lookup: a bound stale/revoked grant returns no account. Installed provider calls this lookup before generating refreshed tokens; test refresh denial even when asynchronous provider cleanup deliberately fails. Authorization requests without a token still require active account.
- [ ] **Step 4:** Run both gateway suites, `npm test`, `npm run typecheck`, `npm run lint`, `npm run build`; expected pass with baseline regressions preserved.
- [ ] **Step 5:** Commit `feat: bind hosted MCP OAuth access to SaaS users`.

### Task 6: SaaS entry point and deployable backend contract

**Files:** Create `src/saas/main.ts`, `packaging/saas.env.example`; Modify `src/cli.ts`; Test `src/__tests__/saas-main.test.ts`; docs `docs/guides/saas.md`.

**Interfaces:** CLI `node dist/cli.js saas`; required `MCP_PUBLIC_URL`, `MCP_AUTH_DIR`, `MCP_SESSION_KEY_FILE`, `MCP_TELEGRAM_FILE_ROOT`, Telegram server credentials. `MCP_SAAS_MAX_USERS=100`, `MCP_SAAS_MAX_WORKERS=4`; validated positive bounds, HTTP port uses existing option. Testable `startSaas(config,{spawn?}): Promise<{app,close}>`.

- [ ] **Step 1:** Write failing tests `missing_key_fails_before_worker_start`, `auth_reopen_and_two_user_persistence`, `shutdown_closes_workers_before_store`, `single_owner_modes_are_unchanged`.

```ts
await assert.rejects(startSaas(configWithMissingKey, { spawn: fakeSpawn }), /key/i);
assert.equal(spawnCount, 0);
assert.ok(shutdownEvents.indexOf('last-child-exit') < shutdownEvents.indexOf('db-close'));
```
- [ ] **Step 2:** Run `npx tsx --test src/__tests__/saas-main.test.ts`; observe red.
- [ ] **Step 3:** Compose vault/store/auth/supervisor/identity/gateway/routes; explicit graceful SIGTERM and healthy control process. Capacity alone does not mark whole service unhealthy; diagnostics contain no accounts/secrets. Do not migrate owner grants/Telegram file implicitly. Document API DTOs for the next plan and key backup/recovery, bounded defaults and separate browser/server sessions.
- [ ] **Step 4:** Run all backend tests, typecheck/lint/build, docs build; verify localhost SaaS smoke with fake workers. No production merge/deploy until frontend/integration plans and final review complete.
- [ ] **Step 5:** Commit `feat: expose standalone SaaS service mode`.
