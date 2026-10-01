# Production audit and fixes

> Execution: implement in this session, with a separate final code review.

**Goal:** Make the existing free Telegram MCP cabinet reliable under retries, interrupted login, shared client IPs, and expired OAuth data.

**Constraints:** Keep registration → server Telegram QR → MCP. No browser Telegram client or new dependencies. Keep Actions image/deploy only; run tests locally. Deploy only the dedicated mcp-telegram Compose project. Preserve existing accounts, credentials, sessions, backups, and unrelated VPS containers.

User authorized the audit, all necessary fixes, and deployment. This is a set of bounded corrections to existing flows, not a new product architecture.

## Tasks

- [x] Telegram login admission: reproduce duplicate start and already-linked start; return the current attempt for retries and reject replacing a linked Telegram session. Preserve owner isolation and cancellation.
- [x] Cabinet recovery: resume the current attempt after account login; recover when `/me` fails after a successful QR; discard stale asynchronous replies and account-specific state when accounts switch. Add behavior tests using the real frontend module with browser boundary doubles.
- [x] MCP limits: reproduce two authenticated accounts sharing an IP competing for one quota. Apply 120/min independently per account and preserve the anonymous IP quota. Revalidate access after tool completion before returning data.
- [x] OAuth storage: periodically remove expired rows while idle, index expiry queries, and remove authentication-stale rows on read. Verify active registrations, tokens and other accounts survive.
- [ ] Run complete tests, backend/frontend builds and lint; independent code review; fix material findings.
- [ ] Create and merge PR, deploy via Actions, verify production HTTP/OAuth/MCP and other VPS containers; archive worktree.

## Review focus

- A retry must not start a second Telegram QR or consume the new-login quota.
- A browser login must resume an existing owner-bound QR without requiring reload.
- A transient status fetch failure after QR success must eventually show MCP setup.
- A stale response must not restore an old attempt after logout, cancellation, or account switch.
- Expiry cleanup must not delete active OAuth clients or tokens.
- Revocation during a pending tool request must suppress its returned data.

## Baseline

756 tests pass. npm audit reports zero vulnerabilities. Production was healthy before this audit. No account data is reset by this work.

## Review corrections

Independent review reproduced overlapping client-list/account-switch responses, stale focus 401 clearing new recovery codes, and retries during worker preparation spending QR quota. Added regression tests; account-scoped completions and errors are fenced by epoch, and connect requests wait in a bounded account queue with quota counted only after admission. Other account mutations keep fail-fast behavior.
