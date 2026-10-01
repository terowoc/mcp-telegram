# MCP-only dashboard implementation plan

**Goal:** Registration → one server Telegram connection → MCP connection information, in a Telegram-style dashboard.

**Architecture:** Keep the existing SaaS API, isolated account workers, OAuth and encrypted Telegram storage. Replace the entire Telegram Web fork with an independent, dependency-free TypeScript dashboard. There is no browser MTProto client or Telegram session. Existing accounts and their OAuth access are removed at release, as explicitly requested by the user.

**Constraints:** Only the old accounts of this service are removed; server sessions remain encrypted. No real message operations during verification. No CI test jobs: image build and deploy only. Other VPS projects are outside scope. User's explicit request authorizes implementation and the previously agreed Actions deployment.

### Task 1: Cabinet authentication and OAuth
- [x] Remove deployed unauthenticated Telegram bootstrap/login routes and their temporary workers.
- [x] Use cabinet registration/login for OAuth continuation; preserve PKCE, consent, forced-login freshness and continuation ownership.
- [x] Verify legacy login endpoints are unavailable and new registration, QR ownership and OAuth work.

### Task 2: Dashboard and build
- [x] Replace `apps/web` with `apps/dashboard`: static TypeScript, local CSS and local SVG; no framework or new dependencies.
- [x] Implement registration/login/recovery, QR + Telegram 2FA, endpoint/config copies, policy and OAuth grant management, logout and account deletion.
- [x] Retire old browser caches and client service workers on this origin; never ship browser API credentials.
- [x] Compile through the root TypeScript dependency; update Docker and Actions to build the dashboard without browser credentials.
- [x] Replace obsolete fork-specific build assertions with dashboard security/build assertions. Verify in a browser with isolated fixtures.

### Task 3: Release
- [ ] Run local build/typecheck/lint/full backend suite, independent whole-change review and fix material findings.
- [ ] Create and attach PR, merge using previous deployment authorization, wait for Actions.
- [ ] Verify healthy production, dashboard/auth/OAuth with synthetic fixtures, no other project redeployment; clean up fixtures and worktree.
