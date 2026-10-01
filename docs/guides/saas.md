# Free public SaaS mode

TG Bridge provides passwordless Telegram cabinets and OAuth access to Telegram MCP. Start the backend with `node dist/cli.js saas`. The existing `http`, `serve`, `login` and stdio modes remain available. The browser frontend is built separately from the server.

## Unified Telegram sign in

Sign into Telegram Web A and optionally select **Также подключить MCP** (unchecked by default). Chat-only sign in creates no server account or MCP session. The authorized browser accepts a fresh server login token; the server verifies its own `getMe`, binds the numeric Telegram identity and creates a passwordless cabinet with read access. Browser and server keep independent MTProto keys. The browser session is never exported.

An existing browser Telegram account can use **Подключить MCP к этому аккаунту** in the MCP section. Telegram may require a separate server 2FA confirmation; that password is cleared after submission and never reused from Web A. **Запасной способ: отдельный QR** remains available if the bridge cannot finish. The MCP session stays active after closing the browser until explicitly disconnected.

Existing password cabinets remain available through **Войти в прежний кабинет**. Linking requires its current cabinet cookie and a freshly verified password; a server-verified Telegram ID resolves ownership. Duplicate legacy cabinets for one Telegram account are never merged automatically. A linked cabinet keeps its policy and saved session. Disconnect removes server access and grants but preserves the identity; deletion removes the cabinet and identity. Passwordless deletion requires explicit confirmation and server authentication within five minutes. If a fresh login is required, confirm deletion again afterward.

AI clients connect to `/mcp`. An open cabinet supplies OAuth authentication; the client still requires an explicit access confirmation. `prompt=login` and `max_age` require fresh authentication where applicable. Expired or cancelled login continuations must be restarted from the client. Web A logout or account switching cancels bootstrap login contexts and revokes the former cabinet cookie; persistent MCP access ends only on disconnect or account deletion.

## Storage and configuration

Use the variables in [saas.env.example](https://github.com/terowoc/mcp-telegram/blob/main/packaging/saas.env.example). SaaS requires an HTTPS public origin, server Telegram application credentials, absolute storage paths, and a private 32-byte encryption key file. Provision the key once:

```sh
umask 077
openssl rand -out /secure/telegram-session.key 32
```

Make the key readable by the service user and mount it read-only. Do not place it inside the database backup directory. Startup refuses a missing, malformed, symlinked or publicly readable key. It never silently regenerates a key. Losing the key requires users to reconnect their Telegram accounts; replacing it also invalidates browser CSRF bindings.

Back up the complete auth directory with the service and all workers stopped, and back up the encryption key separately. The auth directory contains `saas.sqlite` and `oauth/` with its database, cookie keys and OAuth signing key. SQLite WAL files are part of live storage: copying only the main database while writes continue is unsafe. Restore the consistent auth snapshot, matching service configuration and stable encryption key together.

Server Telegram sessions are encrypted with AES-256-GCM, including the user ID as authenticated data. Browser session tokens and recovery codes are stored as hashes. Passwords use scrypt. No owner grants or owner `.telegram-session` file are implicitly imported into SaaS.

## Capacity and lifecycle

The default limit is 100 registered accounts and four active Telegram workers. Each worker has a fixed account, policy, generation and media directory; the parent process retains the encryption key. Worker environments do not inherit server secrets or a global 2FA password. Each process has a 256 MiB V8 heap limit; production containers must separately constrain total memory, CPU and PIDs.

Starting and stopping workers occupy capacity until the child exits. Idle workers stop after five minutes. Tools have a 28-second deadline and a five-second settlement watchdog. A cancelled operation cannot release its exclusivity while Telegram is still settling. Capacity replies use HTTP 503 with `Retry-After`; account or worker capacity does not change the public `/healthz` response while the control service remains healthy.

SIGTERM stops admission, cancels pending QR attempts and terminates all children before closing OAuth and account storage. Media files belong to fixed user directories; deleting an account stops its worker, removes media and deletes its database records.

## Browser API

All paths below are under `/api/saas`. Responses use `Cache-Control: no-store`. Registration and login set `__Host-mcp-saas` with Secure, HttpOnly and SameSite=Lax. Mutations require the public same Origin. Authenticated mutations also require `X-CSRF-Token` from `/me` or the successful login response. A JSON user ID never selects the account.

| Method and path | Request or result |
| --- | --- |
| `POST /telegram-auth/start` | First POST issues a five-minute bootstrap cookie and CSRF without a worker. Repeat with CSRF starts a cookie-owned attempt; optional opaque OAuth continuation. |
| `GET /telegram-auth/:id` | Public token/2FA/verified state; server proof and session remain private. Foreign contexts cannot read it. |
| `POST /telegram-auth/:id/password` | Server 2FA, bounded to five submissions. |
| `POST /telegram-auth/:id/complete` | Exclusive verified completion; optional `legacyPassword` links the authenticated old cabinet. Issues the cabinet cookie once. |
| `DELETE /telegram-auth/:id` | Cancels and reaps the temporary worker. |
| `POST /telegram-auth/revoke` | Clears the bootstrap context before awaiting worker teardown; fences old-tab completion. |
| `POST /telegram-auth/resume` | Returns only a server-validated, same-origin OAuth interaction for an authenticated cabinet. |
| `POST /register` | `{login,password}` → `{user,csrfToken,recoveryCodes}`. Show recovery codes once. |
| `POST /login` | `{login,password}` → `{user,csrfToken}`. |
| `POST /recover` | `{login,recoveryCode,newPassword}`. Revokes browser sessions and all grants; consumes all old recovery codes. |
| `POST /logout` | Ends this browser session and clears pending server QR state. |
| `GET /me` | `{user:{id,login,hasPassword},csrfToken,policy,telegram,mcpUrl}`. Telegram contains process state, busy, sessionPresent and the verified account identity when saved. |
| `POST /telegram/login` | Starts one user-bound attempt, returns `{id,state,expiresAt}` with HTTP 202. |
| `GET /telegram/login/:id` | Latest state: connecting, qr, needs-password, success, error, cancelled or expired. QR state includes a PNG data URL; success includes account ID and optional username. |
| `POST /telegram/login/:id/password` | `{password}` accepted only while that attempt is waiting for 2FA. Never persisted or included in DTOs. |
| `DELETE /telegram/login/:id` | Cancels the attempt. Foreign or expired IDs return 404. |
| `GET /clients` | `{clients:[{grantId,clientId,version}]}`. |
| `DELETE /clients/:grantId` | Revokes only the authenticated user's grant. |
| `PUT /policy` | `{profile:"read"\|"full",chatIds:string[]}`. Numeric chat IDs, at most 100. Bumps policy version, revokes grants and stops the old worker. |
| `POST /telegram/disconnect` | Removes this user's server session and grants and stops its worker. |
| `DELETE /account` | `{password}` confirms legacy deletion; passwordless accounts use `{confirm:true}` and fresh authentication. Access is disabled before storage is purged. |

Logins use 3–32 ASCII letters, digits or underscores, normalized to lowercase. Passwords require 16–1024 characters. Registration is limited to five requests per IP per hour and 20 globally per hour. Login/recovery share ten attempts per IP per 15 minutes. Authenticated API access is limited to 120 requests per user per minute and the API as a whole to 600 per minute. QR starts are limited to three per user per ten minutes, with a five-minute deadline and six-minute attempt retention.

## MCP and browser Telegram sessions

Connect MCP clients to the public `/mcp` endpoint using the advertised OAuth discovery endpoints. PKCE is required. Each consent grant binds an enabled SaaS account and policy version. The binding is checked on every MCP request and before refreshing tokens, so failed asynchronous provider cleanup cannot restore revoked access. Read-only policy filters both tool listing and calls. Before Telegram setup only `telegram-status` is available. QR login and disconnect are controlled through the browser API.

Telegram Web A keeps its browser MTProto session, while the unified login authorizes a separate server device for MCP. Logging out of TG Bridge or disconnecting MCP does not log out Telegram Web A. The UI must display both account identities and warn when they differ. Configure public browser application credentials explicitly; frontend builds never inherit server environment files. The owner may authorize the same application values for both, accepting that the browser API hash is public.

Bootstrap worker starts allow 5/15 minutes/IP and 20/hour/service, with a five-minute attempt deadline and 60 status reads/minute/context. Temporary and persistent processes share the same worker budget; promotion waits for actual temporary process exit. Schema version 3 preserves legacy records and adds nullable passwords, unique Telegram identities, credential epochs and server authentication times. Restore the whole pre-migration snapshot with its matching image when rolling back.
