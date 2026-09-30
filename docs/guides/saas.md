# Free public SaaS mode

TG Bridge adds independent SaaS accounts and OAuth access to Telegram MCP. Start the backend with `node dist/cli.js saas`. The existing `http`, `serve`, `login` and stdio modes remain available. The browser frontend is built separately from the server.

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
| `POST /register` | `{login,password}` → `{user,csrfToken,recoveryCodes}`. Show recovery codes once. |
| `POST /login` | `{login,password}` → `{user,csrfToken}`. |
| `POST /recover` | `{login,recoveryCode,newPassword}`. Revokes browser sessions and all grants; consumes all old recovery codes. |
| `POST /logout` | Ends this browser session and clears pending server QR state. |
| `GET /me` | `{user:{id,login},csrfToken,policy,telegram,mcpUrl}`. Telegram contains process state, busy and sessionPresent only. |
| `POST /telegram/login` | Starts one user-bound attempt, returns `{id,state,expiresAt}` with HTTP 202. |
| `GET /telegram/login/:id` | Latest state: connecting, qr, needs-password, success, error, cancelled or expired. QR state includes a PNG data URL; success includes account ID and optional username. |
| `POST /telegram/login/:id/password` | `{password}` accepted only while that attempt is waiting for 2FA. Never persisted or included in DTOs. |
| `DELETE /telegram/login/:id` | Cancels the attempt. Foreign or expired IDs return 404. |
| `GET /clients` | `{clients:[{grantId,clientId,version}]}`. |
| `DELETE /clients/:grantId` | Revokes only the authenticated user's grant. |
| `PUT /policy` | `{profile:"read"\|"full",chatIds:string[]}`. Numeric chat IDs, at most 100. Bumps policy version, revokes grants and stops the old worker. |
| `POST /telegram/disconnect` | Removes this user's server session and grants and stops its worker. |
| `DELETE /account` | `{password}` confirms deletion. Access is disabled before storage is purged. |

Logins use 3–32 ASCII letters, digits or underscores, normalized to lowercase. Passwords require 16–1024 characters. Registration is limited to five requests per IP per hour and 20 globally per hour. Login/recovery share ten attempts per IP per 15 minutes. Authenticated API access is limited to 120 requests per user per minute and the API as a whole to 600 per minute. QR starts are limited to three per user per ten minutes, with a five-minute deadline and six-minute attempt retention.

## MCP and browser Telegram sessions

Connect MCP clients to the public `/mcp` endpoint using the advertised OAuth discovery endpoints. PKCE is required. Each consent grant binds an enabled SaaS account and policy version. The binding is checked on every MCP request and before refreshing tokens, so failed asynchronous provider cleanup cannot restore revoked access. Read-only policy filters both tool listing and calls. Before Telegram setup only `telegram-status` is available. QR login and disconnect are controlled through the browser API.

Telegram Web A keeps its browser MTProto session, while MCP uses a separately linked server device. Logging out of TG Bridge or disconnecting MCP does not log out Telegram Web A. The UI must display both account identities and warn when they differ. Telegram server application credentials must never be embedded into the frontend; configure a separate browser application explicitly.
