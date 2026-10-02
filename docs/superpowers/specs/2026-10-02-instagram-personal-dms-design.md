# Personal Instagram DMs in the hosted MCP cabinet

Date: 2026-10-02
Status: Proposed design; awaiting the user's review before implementation planning.

## Intent and scope

The user wants to connect a personal Instagram account to this project, read its chats, and send replies through MCP, like the existing Telegram integration. The priorities are quick delivery through an existing GitHub project and reliable account isolation and message handling. The user approved using `subzeroid/instagrapi` with a persistent Python worker as the basis for this design.

The first release supports the hosted SaaS cabinet and its existing OAuth-protected MCP endpoint. It adds Instagram connection management and five tools: account listing, status, chat listing, recent message reading, and text sending to an existing thread. A text sent into a thread is a reply in that conversation; quoted replies are outside this release. Telegram remains available in the same cabinet and endpoint.

Scope exclusions: new Instagram conversations, media uploads/downloads, reactions, message deletion, posts, analytics, automatic responses, Telegram-to-Instagram forwarding, realtime subscriptions, and Instagram support in stdio, daemon, or single-owner HTTP mode. These are separate follow-up features. This phase connects Instagram to AI clients, rather than forwarding messages between networks.

Repository research supports the dependency choice but does not prove live login or message delivery. Personal Instagram access uses unofficial APIs. Verification challenges, account restrictions, and upstream protocol changes remain possible and must be reported accurately.

## Dependency decision

Use `instagrapi==3.0.18`, released on 2026-10-02 at commit `2ece2362a968166f502a867108f05ed4db275ff9`, as the candidate implementation baseline. Its tagged source exposes `direct_threads_chunk`, `direct_thread`, `direct_send`, `account_info`, `get_settings`, and `set_settings`, and its LICENSE is MIT. A failed compatibility check is grounds to revise this design; do not silently upgrade the dependency during implementation.

Alternatives considered:

- `mautrix/meta` is the maintained Instagram bridge and supports extensive DM functionality. Its normal deployment introduces a Matrix homeserver and bridge configuration; extracting its Go protocol client would require a larger custom adapter. It is a fallback if the direct library cannot satisfy the account smoke check.
- `supreme-gg-gg/instagram-cli` offers useful one-turn JSON commands, but its TypeScript client depends on the older `dilame/instagram-private-api` and includes terminal UI and global local-session behavior that would require adaptation for this SaaS.
- `mautrix/instagram` is archived and deprecated; do not use it.

Primary references checked:

- https://github.com/subzeroid/instagrapi/releases/tag/3.0.18
- https://github.com/subzeroid/instagrapi/blob/3.0.18/LICENSE
- https://github.com/subzeroid/instagrapi/blob/3.0.18/instagrapi/mixins/auth.py
- https://github.com/subzeroid/instagrapi/blob/3.0.18/instagrapi/mixins/direct.py
- https://github.com/subzeroid/instagrapi/blob/3.0.18/docs/usage-guide/best-practices.md
- https://github.com/mautrix/meta
- https://docs.mau.fi/bridges/go/setup.html?bridge=instagram
- https://github.com/supreme-gg-gg/instagram-cli/blob/main/package.json
- https://github.com/mautrix/instagram

## Architecture and files

Keep the Telegram client and Telegram worker protocol intact. Add a separate Instagram supervisor and Python worker, and compose their capabilities at the SaaS identity and hosted tool catalog boundaries.

New modules belong under `src/instagram/`: schemas and tool definitions, permission evaluation, the TypeScript supervisor, login-attempt lifecycle, session serialization validation, and `worker.py`. The Python worker wraps only the supported `instagrapi` methods. TypeScript owns authentication, authorization, encrypted persistence, process admission, and MCP response formatting.

Extend `src/saas/store.ts` and `src/saas/types.ts` with Instagram records and browser DTOs. Compose the supervisor and browser routes in `src/saas/main.ts` and `src/saas/routes.ts`. Route Instagram tools separately in `src/saas/identity.ts`, and register their schemas in `src/http/tool-catalog.ts`. Preserve the `GatewayIdentity` interface where possible: its existing `ToolPolicy` return type can be implemented by a SaaS policy subclass that delegates Instagram names to the new Instagram policy.

Update `apps/dashboard/api.ts`, `app.ts`, and `style.css` with an Instagram section. Update the build/package scripts to copy `worker.py` into the runtime distribution. Add a Python dependency input and a complete dependency lock with hashes under `packaging/instagram/`. Extend the Dockerfile, SaaS environment example, deployment configuration, and deployment guide for the optional runtime.

Enable the integration with `MCP_INSTAGRAM_ENABLED=1`; it is disabled by default. Disabled deployments expose no Instagram routes or MCP tools and never spawn Python. Existing Telegram behavior must continue to work with the feature disabled. An enabled deployment must validate the configured executable and pinned library version at startup, with a clear configuration error on failure. Use `MCP_INSTAGRAM_PYTHON` for the executable path; the production image supplies its absolute virtualenv interpreter path.

## Data, ownership, and migration

Add an `instagram_connections` table with a private UUID connection ID, cabinet owner ID, label, verified Instagram user ID and username, encrypted session envelope, policy JSON and version, connection generation, cooldown-until timestamp, and a persistent removal marker. The owner references `users(id)`. Instagram connections are service identities and cannot authenticate as cabinet users or overwrite Telegram identity records.

Support up to five Instagram connection slots per cabinet, independently of the existing Telegram limit. Pending and removal-pending slots count toward capacity. Duplicate verified Instagram user IDs in the same cabinet are rejected before saving; the same external identity in different cabinets is not treated as authorization to share a worker or session. A disconnected slot retains its verified identity and can reconnect only to that identity; switching identity requires removing the slot and creating another. Mutations are serialized by owner and enforce capacity transactionally.

Instagram session storage uses the existing master key through a domain-separated derived key and authenticated context containing both owner ID and connection ID. Store only a validated allowlist of session/device settings needed by the pinned library. Persist no passwords, verification codes, challenge URLs, or full upstream responses. Cap the serialized plaintext at 64 KiB and its envelope at 96 KiB. Use a dedicated Instagram codec so the Telegram vault's existing 16 KiB limit and format remain unchanged.

Add an `instagram_send_requests` table for durable send deduplication. It contains connection ID, connection generation, request UUID, payload HMAC, state, creation/expiry timestamps, and confirmed message ID/timestamp if available. It stores no message text. Requests expire after 24 hours; the tool description states the deduplication window. Limit retained requests to 2,000 per connection; when unexpired entries fill capacity, reject new sends rather than evicting deduplication protection.

Migration advances the database schema from version 4 to version 5 transactionally, preserving existing users, Telegram sessions, policies, connections, recovery codes, and grants. The old binary rejects schema 5, so rollback requires the existing deployment's matching pre-migration auth/database snapshot as well as its old image. Document that sessions created after that snapshot need reconnecting after rollback. Do not claim that image-only rollback is sufficient.

## Python process and session lifecycle

Spawn one persistent Python process per active Instagram connection, using `spawn` with an argument array and no shell. Do not send credentials through arguments or environment variables. Use bounded newline-delimited JSON on stdin/stdout; stdout contains protocol frames only. Every frame carries a process generation and request ID, and login frames also carry an attempt ID. Reject malformed, oversized, unknown-generation, or unexpected-phase frames. The maximum frame is 256 KiB; oversized tool output returns a bounded error.

Workers receive only their connection's decrypted settings and sanitized configuration. They receive no master key, database path, Telegram session, or unrelated account data. Give each process a private working directory. Disable Python bytecode writes and sanitize stderr; never log raw exceptions or library request debug output. Force TLS verification and server-controlled transport deadlines/retry settings after restoring saved settings; stored session state cannot weaken those controls.

On restore, call `set_settings` and validate the identity through `account_info`, then compare the verified user ID with the persisted account. Do not call `login` to restore an established session: the pinned implementation requires a password and can attempt a new login. An expired session changes status to `needs-login`; a transport error or rate limit does not erase an otherwise reusable session. Persist valid refreshed settings only after generation and ownership checks.

Use one shared process budget for both protocols, with protocol-qualified lease keys. Leases cover startup, active use, and shutdown and are released only after process exit. Admission may reclaim an idle worker from either supervisor. Bound per-connection work to one in-flight upstream operation and at most four queued operations. Reuse the configured idle eviction duration. Status/account listing must not start a worker or contact Instagram merely to render the dashboard.

Use a 10-second worker startup deadline, a 5-minute login-attempt lifetime, a 45-second tool deadline, and a bounded HTTP transport timeout that fits the tool deadline. Login-start and verification submissions acknowledge promptly, and the dashboard polls attempt state. On caller cancellation or timeout, retain the operation reservation until settlement or forced process exit. A timed-out mutation becomes `unknown` even if its result frame arrives later; never dispatch another send with the same key.

## Login and browser API

Authentication happens in the cabinet over HTTPS. Provide username/password login and 2FA code submission; there is no Instagram QR promise. Hold password and codes only in the active browser submission and worker memory. Clear input values immediately after submission. Cancellation, expiration, logout, recovery, disconnect, and deletion clear active credential state and stop any blocked login worker.

Attempt states are `starting`, `needs-code`, `needs-verification`, `connected`, `failed`, `cancelled`, and `expired`. Support authenticator and login-code flows exposed by the pinned library. The TypeScript/Python adapter tests must verify that the actual CAA/2FA error paths map to `needs-code`; do not assume that every verification event raises `TwoFactorRequired`.

For unsupported challenges such as selfie/CAPTCHA or account review, show a clear instruction to verify in the official Instagram app and retry. Do not invent a challenge bypass or loop through password logins. Only use email/SMS code callbacks when the pinned flow provides a supported, bounded continuation; otherwise classify the flow as `needs-verification`. No user-provided challenge URL is fetched by the server.

The API under `/api/saas/instagram` provides these routes:

| Method and path | Behavior |
| --- | --- |
| `GET /accounts` | List owned slots and safe connection/policy status. |
| `POST /accounts` | Create an empty slot with a trimmed label of 1–80 characters. |
| `PATCH /accounts/:accountId` | Rename a slot. |
| `PUT /accounts/:accountId/policy` | Set profile and thread allowlist. |
| `POST /accounts/:accountId/login` | Start one attempt with username/password; return safe attempt state. |
| `GET /accounts/:accountId/login/:attemptId` | Poll safe attempt state without credentials. |
| `POST /accounts/:accountId/login/:attemptId/code` | Submit a supported login code for the matching active attempt. |
| `DELETE /accounts/:accountId/login/:attemptId` | Cancel the attempt and clear transient credential state. |
| `POST /accounts/:accountId/disconnect` | Clear the local session and stop the worker. |
| `DELETE /accounts/:accountId` | Remove the slot through persistent teardown. |

Every request resolves ownership from the cabinet session; a foreign or unknown ID returns the same 404. Mutations require the existing Origin/CSRF protections and owner mutation lock. Login submissions additionally require recent cabinet authentication within five minutes. If that window expires, return `reauthentication-required` and let the user sign in again through the existing cabinet login screen; do not persist an Instagram password to resume across that sign-in. Credential submissions use bounded fields (username up to 64 characters, password up to 1,024, code up to 32) and reject unknown fields.

Disconnect immediately blocks new operations, invalidates the generation, revokes access, drains/stops the worker, and deletes local session material. It guarantees local disconnect, not successful remote Instagram session revocation; the UI can direct the user to Instagram's session-management page for remote revocation. Removing a slot persists its removal marker before teardown so maintenance can retry after a crash. Cabinet deletion must stop and purge Instagram workers and records before deleting the owner. Browser logout preserves established connections while cancelling active login attempts, matching the existing cabinet behavior.

## Permissions, OAuth, and MCP tools

Each Instagram connection has `read` or `full` access and an optional allowlist of at most 100 Instagram thread IDs. New connections default to `read`; the user can explicitly enable sending. Instagram thread/user/message IDs are decimal strings across JSON boundaries. Validate digit-only canonical IDs up to 64 digits, independently of Telegram's signed 20-digit peer validation. A private connection UUID is never interpreted as an Instagram user or thread ID.

Register these tools only in enabled SaaS mode:

| Tool | Contract |
| --- | --- |
| `instagram-list-accounts` | Return owned active connection UUIDs, labels, usernames, status, and access descriptions. No credentials or envelopes. |
| `instagram-status` | Require `instagramAccountId`; return safe local connection and last validated identity status. |
| `instagram-list-chats` | Require `instagramAccountId`; accept a limit from 1–20 and optional bounded inbox cursor; return normalized thread summaries and the next cursor. |
| `instagram-read-messages` | Require `instagramAccountId` and `threadId`; return the latest 1–50 normalized messages. State explicitly that this is bounded recent history; no invented historical pagination cursor. |
| `instagram-send-message` | Require `instagramAccountId`, `threadId`, text of 1–1,000 Unicode code points, and a UUID `requestId`. Send one plain text message to one existing allowed thread. Return its confirmed ID or a safe delivery-unknown error. |

Account selection is explicit for every account-specific Instagram tool, even with a single connection. Reject Telegram selectors on Instagram calls and Instagram selectors on Telegram calls. Browser account selection never changes MCP routing.

Normalize outputs to IDs, display names, timestamps, message kind, and text; identify unsupported media with a kind marker without downloading it. Do not return raw library models, signed media URLs, cookies, or arbitrary upstream metadata. Reading never implicitly marks a thread as seen. Under a thread allowlist, filter chat summaries before returning them and bound enumeration to three inbox pages per tool call, retaining an opaque next cursor when more pages exist. Check an explicit thread ID before upstream reads or sends. Enforce current ownership and permissions in both Node dispatch and the Python command contract; catalog visibility alone is insufficient.

Compose Instagram catalog visibility independently of Telegram policies. Read-only profiles omit sending. The hosted tool catalog must not apply the Telegram selector or Telegram peer policy to Instagram schemas. Registration into Telegram-only modes is prohibited by this phase's scope.

Include both protocols' account identities, connected state, labels, and permissions in the deterministic consent binding and access description. Adding/removing/connecting/disconnecting an Instagram account or changing its policy revokes existing cabinet OAuth grants synchronously at the store boundary before async teardown. Label changes also invalidate consent. An old grant never gains Instagram access simply because tools became available. Check grant validity again before returning results, as the existing MCP handler does.

## Sending, retries, and failure behavior

Record a send request transactionally before dispatch. The payload HMAC includes connection generation, thread ID, and exact text, and uses a domain-separated server key. Repeating a request ID with a different payload fails. Repeating a confirmed request returns the recorded result without another send. A concurrent repeat of an in-flight request returns `send-in-progress`; an uncertain request returns `delivery-unknown` without retrying.

Crashes or forced worker exits turn persisted pending sends into `unknown` during recovery. Before dispatch, authorization, capacity, and deadline failures cause no upstream mutation and can be reported as not attempted. Once the request is dispatched, an unconfirmed outcome is treated conservatively as unknown. A confirmed upstream success is recorded before exposing its result. This is bounded duplicate prevention, not an exactly-once guarantee from Instagram; a new request ID or an expired deduplication entry represents a new send.

Disable library/transport automatic retries for writes and test this with an instrumented transport; a supervisor retry policy is insufficient if the dependency retries internally. Reads may make at most one retry on a transport failure within the original deadline. Rate limits and feedback restrictions cause a persisted per-connection cooldown, using upstream retry guidance when available and a minimum 60 seconds otherwise. Challenges stop automation and require user action. No tight relogin or retry loops. Do not start realtime MQTT or continuous polling in this release.

Public errors use bounded codes such as `needs-login`, `needs-verification`, `invalid-code`, `rate-limited`, `capacity`, `not-found`, `permission-denied`, `send-in-progress`, `request-conflict`, and `delivery-unknown`. Logs contain protocol, opaque connection ID, operation, duration, and safe code only.

## Dashboard and production packaging

Add an Instagram navigation section with connection cards, add/rename/remove controls, username/password and code steps, a clear verification-required state, disconnect, and per-account access settings. Use the existing dashboard visual style and Russian localization. Clearly distinguish cabinet credentials from Instagram credentials. Do not build a second inbox or full chat client in the cabinet; the first phase manages access for MCP clients.

Make the MCP setup screen usable when Instagram is connected even if Telegram is disconnected, and describe each connected protocol's permissions. OAuth continuation must be able to resume after connecting Instagram. Preserve existing Telegram setup and account-selection behavior.

Install Python 3.11 and a private virtualenv in the final production image; Python currently exists only in the builder. Lock all Python dependencies and install with hashes, retain the MIT notice, copy the worker into the image, and run it as the existing unprivileged user. No runtime package installation or separate public Python service is required. Disable worker bytecode/cache writes for the read-only filesystem. Build checks must cover every architecture used by the deployment, including required binary wheels.

Document interpreter setup for local SaaS development, the feature flag, required reconnect after consent changes, cooldown/challenge recovery, and matched-image/database rollback. Deployment remains a separate authorized action after implementation validation; this design approval does not authorize a production rollout.

## Verification and acceptance

Use fake Python protocol workers and injected dependency/transport fixtures for deterministic tests. They must exercise real supervisor framing and lifecycle boundaries, not just mirror helper functions. Run the pinned library against an instrumented local transport where needed to verify settings restoration, typed login errors, unchanged read receipts, and disabled mutation retries without contacting a real account.

Required acceptance checks:

1. Version-4 migration and restart preserve all Telegram data and existing behavior; feature-disabled startup requires no Python. Migration and rollback use matching database snapshots.
2. Two cabinet owners cannot list, operate on, restore, or receive events from each other's Instagram connections. Capacity and duplicate-account races are covered.
3. Session serialization excludes password/code fields; swapping envelopes between connections fails; stale-generation saves are rejected. Oversized state/frames fail without log leakage.
4. Login success, supported 2FA, invalid code, unsupported verification, expiration, cancellation, logout, recovery, and deletion cannot leave credentials or a login worker active indefinitely.
5. Shared budget includes both worker types through teardown. Idle eviction, startup failure, malformed frames, queue overflow, cancellation, and forced shutdown do not leak reservations.
6. Read policy blocks sends; thread restrictions filter summaries and reject direct access outside the scope. Explicit selectors are checked at actual MCP execution, and foreign IDs disclose no private metadata.
7. Existing OAuth grants never acquire added Instagram access; account/policy mutations invalidate active grants and consent continuations. Instagram-only connection can complete MCP setup.
8. Sending dispatches one upstream mutation per request key within the documented window. Concurrent duplicates, payload conflicts, timeouts, crashes, late frames, cooldowns, and underlying transport retries are covered.
9. Full server tests, server typecheck/lint, dashboard typecheck/build, and production image validation pass. Browser smoke checks cover Instagram-only setup and existing multi-account Telegram flows using fixtures.
10. A real account smoke check verifies login, restart restoration, chat listing, and recent message reading with the user's participation. A real send requires an explicitly named recipient/thread and user authorization; it is not part of an automatic test suite. If live access is unavailable, report live compatibility as unverified rather than complete.

Acceptance means the hosted cabinet can connect a verified personal Instagram account and authorized MCP clients can list/read its allowed chats and send text with the stated deduplication behavior. It does not promise uninterrupted upstream access, universal challenge support, exactly-once delivery, or feature parity with Telegram.

## Planning handoff

After the user reviews and approves this written spec, create the implementation plan and select its execution method according to the project's skill workflow. The plan should begin with pinned-library compatibility and packaging checks, then persistence/worker isolation, browser login and policies, MCP dispatch/consent, dashboard completion, and integrated verification. Compatibility failure must be surfaced before building the full UI around an unsuitable dependency.
