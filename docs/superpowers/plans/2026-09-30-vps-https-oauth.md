# HTTPS MCP Deployment Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task. User approved the specification and requested execution in this session.

**Goal:** Deploy an authenticated HTTPS Telegram MCP endpoint and connect GitHub Actions without affecting existing VPS projects, then complete the audit improvements.

**Architecture:** A stateless Streamable HTTP gateway proxies tools to the existing single Telegram owner over IPC. An established OIDC provider handles OAuth/PKCE with SQLite persistence; nginx provides HTTPS. Docker Compose and a dedicated deploy script update one service by immutable digest with rollback.

**Tech Stack:** TypeScript, Node.js 24, MCP SDK, oidc-provider 9.12.2, Express, node:sqlite, Docker Compose, nginx, GitHub Actions/GHCR.

**Spec:** `docs/superpowers/specs/2026-09-30-vps-https-oauth-design.md`

## Global Constraints

- Public URL `https://tg-mcp.azimboev.uz/mcp`; OAuth issuer ends in `/oauth`.
- One owner account, scope `mcp:tools`, PKCE S256, dynamic registration, refresh/revocation.
- Compose project `mcp-telegram`; directory `/opt/mcp-telegram`; host bind `127.0.0.1:18770`.
- Session, auth and file storage are separate; permitted media root `/data/files`.
- No secrets in Git, image, command output or logs; no other project restarts/prune.
- HTTP anonymous access is limited to discovery, login, and minimal health; MCP requires OAuth.
- Runtime image uses Node 24, production dependencies and UID 1000.
- CI deploys only verified main or manually selected trusted ref, with serialized deployments.
- Never run old and new Telegram owners concurrently against one session.

## Review Focus

- An expired/revoked token or wrong audience must not reach a tool handler (Task 2).
- Interrupted login/consent, hostile client name, and replayed form must not grant access (Task 2).
- Restart must preserve OAuth grants, signing keys, and owner password verification (Tasks 1–2).
- Failed image health must restore the previous image without touching other services (Task 5).
- A media path must not disclose session/auth files or overwrite an existing file (Task 3).

### Task 1: Persistent OAuth storage and owner authentication

Files: `src/http/storage.ts`, `src/http/owner.ts`, `src/__tests__/http-storage.test.ts`, `src/__tests__/http-owner.test.ts`, dependency manifests.

Interfaces: `createAdapter(databasePath)` returns an oidc-provider adapter class; `hashPassword(password)` and `verifyPassword(password, hash)` use scrypt; `loadOrCreateSecrets(directory)` returns persistent cookie keys and signing JWKS.

- [ ] Write tests for SQLite persistence, expiry, consume, grant revoke and alternate lookups; password match/mismatch and malformed hashes; persistent secrets.
- [ ] Observe each test fail against missing functionality.
- [ ] Implement SQLite-backed adapter with transactional operations and private file permissions; implement asynchronous scrypt verification.
- [ ] Run focused tests and the existing suite; commit Task 1.

### Task 2: OAuth and authenticated Streamable HTTP gateway

Files: `src/http/oauth.ts`, `src/http/gateway.ts`, `src/http/main.ts`, `src/cli.ts`, `src/client.ts`, `src/__tests__/http-gateway.test.ts`, `src/__tests__/http-oauth.test.ts`.

Interfaces: `createHttpGateway(options)` returns Express app and shutdown handle; options include canonical public URL, persistent auth directory, owner hash, version and IPC-backed tool caller. `runHttp(apiId, apiHash, version)` owns Telegram and starts the gateway. Export existing `wireIpcProxies` for reuse rather than reproducing it.

- [ ] Write end-to-end local HTTP tests: discovery, unauthorized initialize, DCR, owner login/consent, PKCE success/failure, replay/mismatch rejection, refresh/revoke and valid tools/list/call.
- [ ] Observe failing tests.
- [ ] Configure oidc-provider with persistent adapter, required PKCE, resource-bound opaque tokens, registration and owner interaction forms.
- [ ] Implement CSRF-bound interactions, escaped output and auth rate limiting; use private persistent secrets.
- [ ] Implement bounded HTTP gateway, strict host/origin checks, bearer verification, stateless JSON MCP transport and anonymous health.
- [ ] Add CLI mode and startup/shutdown lifecycle using the existing Telegram owner and shared IPC client.
- [ ] Run focused tests and the full suite; commit Task 2.

### Task 3: Media policy required for hosted deployment

Files: `src/file-policy.ts`, media methods in `src/telegram-client.ts`, media annotations/schemas, `src/__tests__/file-policy.test.ts`.

Interfaces: async upload validation and private file creation enforce optional `MCP_TELEGRAM_FILE_ROOT`; max upload/download bytes is explicit. Existing local installations retain ordinary local paths while URL and unsafe path validation is shared.

- [ ] Write tests for permitted files, URL/traversal/pseudo-filesystem rejection, symlink escape, size cap and existing-file overwrite.
- [ ] Observe failures.
- [ ] Apply policy at service boundaries for every path-consuming media method; move download tools to write classification.
- [ ] Run focused and full tests; update docs manifest counts if annotations change; commit Task 3.

### Task 4: Production container and nginx configuration

Files: `Dockerfile`, `.dockerignore`, `packaging/compose.production.yaml`, `packaging/http.env.example`, `packaging/nginx.conf`, `docs/guides/https-deployment.md`.

- [ ] Build a Node 24 image with production dependencies, non-root user and healthcheck.
- [ ] Validate Compose with temporary nonsecret configuration; validate nginx configuration on VPS before reload.
- [ ] Configure resource limits, localhost port and separate persistent mounts.
- [ ] Document private owner credential retrieval and QR authorization; run docs build.
- [ ] Commit Task 4.

### Task 5: Safe deployment and GitHub Actions

Files: `scripts/deploy-vps.sh`, `.github/workflows/deploy-vps.yml`, fork guards on inherited publish workflows, `src/__tests__/deploy-script.test.ts`.

Interfaces: `deploy-vps.sh IMAGE_DIGEST` changes only the mcp-telegram project; preserves previous deployment metadata and restores it on failed bounded health checks.

- [ ] Run the deploy script against a controlled docker executable; assert update scope, success and rollback behavior.
- [ ] Observe failures, implement script, then observe passing tests.
- [ ] Add CI checks, build/push immutable image, known-host verification, secret-based SSH and concurrency.
- [ ] Provision a dedicated restricted deploy key and GitHub secrets without printing credentials.
- [ ] Publish branch/PR and integrate the user-authorized deployment changes; attach any created PR.
- [ ] Run Actions, verify image and deployment, configure only the new vhost/certificate, compare existing container baseline.
- [ ] Commit Task 5; record exact deployment digest and verification results.

### Task 6: Telegram onboarding and live verification

- [ ] Ask user to scan the private QR; keep independent checks moving while waiting.
- [ ] Verify protected telegram-status and persistence after restarting only this service.
- [ ] Exercise protected MCP discovery and a harmless status call; never send messages as a deployment test.
- [ ] Verify rollback and a subsequent successful automated deploy.
- [ ] Run a fresh whole-branch review and address important findings; report exact verified capabilities and remaining user action.

### Task 7: Audit follow-through after deployment

Subsequent independently testable changes: full session-path isolation, stable send randomIds, queue deadlines and common executor, streaming UTF-8/frame bounds, single-flight connection lifecycle, bounded reads/structured output, server-enforced profiles and chat allowlists, inbox and message preparation, doctor/metrics, service decomposition, dependency updates and release hardening. Keep backward-compatible tool schemas where possible; add regression tests before behavior changes. Each feature retains the approved audit scope and is logged separately rather than being declared complete with the initial deployment.

- [ ] Create task-specific tests and exact interfaces for each audit change as the earlier deployed interfaces settle.
- [ ] Implement and verify each change, redeploy using the new pipeline, and update user documentation.
- [ ] Complete a final review and report shipped results, tests and any real limitations.
