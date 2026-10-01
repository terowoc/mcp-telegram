# Free public SaaS mode

Telegram MCP provides a free public cabinet with a Telegram-style interface and OAuth access to MCP. Start the backend with `node dist/cli.js saas`. The `http`, `serve`, `login` and stdio modes remain available.

## Registration and Telegram connection

Register a cabinet with a login (3-32 Latin letters, digits or underscores) and a password of at least 16 characters. Save the eight recovery codes shown once. Then connect your own Telegram using the server QR; enter the Telegram cloud password if 2FA is enabled. The cabinet runs no Telegram Web client, browser MTProto worker, or browser Telegram session.

The server verifies `getMe` before persisting the encrypted session. All authorized MCP clients share that account's server session. Signing out of the cabinet keeps Telegram connected; disconnecting Telegram removes the stored session and OAuth grants. Account deletion requires the cabinet password and removes the account, grants and its media.

Retrying a connection request returns the current QR attempt instead of starting another one. Signing into the cabinet resumes an active attempt, and temporary status failures after QR approval are retried. A linked Telegram session cannot be replaced through the connect endpoint: disconnect it explicitly first.

After connecting Telegram, the cabinet displays the HTTPS `/mcp` endpoint, Streamable HTTP transport, OAuth connection instructions and example client configurations. New accounts default to full access across all their chats, including sending messages and other changes after Telegram connection and OAuth approval. Users can select read-only access, restrict chat IDs and revoke individual clients. This default does not change existing accounts’ saved permissions or grants.

AI clients authenticate through the same cabinet registration/login and still need explicit OAuth consent. `prompt=login` and `max_age` require fresh authentication when applicable. Expired continuations must be restarted from the client. Existing accounts are removed for this release by the owner's explicit request; users register again.

## Cabinet interface

The cabinet and OAuth connection pages share Telegram-style light and dark themes. Appearance follows the system by default; the theme button cycles through dark, light and automatic. The preference uses `mcp-ui-theme` browser storage and a non-authentication cookie so connection pages use the same appearance.

Cabinet sections support hash URLs and browser back/forward navigation. Mobile navigation stays at the bottom with all five sections available. Password fields can be revealed, keyboard focus remains visible, and configuration examples expand on demand.

Background refreshes and failed requests retain form input and focus within the same account and page. Account changes clear the prior account's draft state. A startup outage offers retry instead of displaying registration; client lists distinguish loading, empty results and errors. Client labels come from their OAuth registration metadata, with the client ID as fallback.

Saving unchanged permissions preserves existing client grants. Actual permission changes still revoke grants and require clients to authorize the new policy. The interface states this before saving. Connection errors and expired confirmations provide recovery actions while protocol API errors remain JSON.

## Storage and configuration

Use the variables in [saas.env.example](https://github.com/terowoc/mcp-telegram/blob/main/packaging/saas.env.example). SaaS requires an HTTPS public origin, server Telegram application credentials, absolute storage paths, and a private 32-byte encryption key file. Provision the key once:

```sh
umask 077
openssl rand -out /secure/telegram-session.key 32
```

Make the key readable by the service user and mount it read-only. Do not place it inside the database backup directory. Startup refuses a missing, malformed, symlinked or publicly readable key. It never silently regenerates a key. Losing the key requires users to reconnect their Telegram accounts; replacing it also invalidates browser CSRF bindings.

Back up the complete auth directory with the service and all workers stopped, and back up the encryption key separately. The auth directory contains `saas.sqlite` and `oauth/` with its database, cookie keys and OAuth signing key. SQLite WAL files are part of live storage: copying only the main database while writes continue is unsafe. Restore the consistent auth snapshot, matching service configuration and stable encryption key together.

Server Telegram sessions are encrypted with AES-256-GCM, including the user ID as authenticated data. Browser session tokens and recovery codes are stored as hashes. Passwords use scrypt. No owner grants or owner `.telegram-session` file are implicitly imported into SaaS.

Expired OAuth rows are pruned at startup, on writes and every minute while idle. Credential-stale authentication records are discarded when read. Active client registrations remain stored; they are protocol configuration rather than Telegram account data.

## Capacity and lifecycle

The default limit is 100 registered accounts and four active Telegram workers. Each worker has a fixed account, policy, generation and media directory; the parent process retains the encryption key. Worker environments do not inherit server secrets or a global 2FA password. Each process has a 256 MiB V8 heap limit; production containers must separately constrain total memory, CPU and PIDs.

Starting and stopping workers occupy capacity until the child exits. Idle workers stop after 30 minutes (configurable with `MCP_SAAS_WORKER_IDLE_MS`) or are evicted when an idle slot is needed. Tools have a 28-second execution deadline and a five-second settlement watchdog. A cancelled operation cannot release its exclusivity while Telegram is still settling. Capacity replies use HTTP 503 with `Retry-After`; account or worker capacity does not change the public `/healthz` response while the control service remains healthy.

SIGTERM stops admission, cancels pending QR attempts and terminates all children before closing OAuth and account storage. Media files belong to fixed user directories; deleting an account stops its worker, removes media and deletes its database records.

## Browser API

All paths below are under `/api/saas`. Responses use `Cache-Control: no-store`. Registration and login set `__Host-mcp-saas` with Secure, HttpOnly and SameSite=Lax. Mutations require the public same Origin. Authenticated mutations also require `X-CSRF-Token` from `/me` or the successful login response. A JSON user ID never selects the account.

| Method and path | Request or result |
| --- | --- |
| `POST /oauth/resume` | Cabinet cookie, cabinet CSRF and a context-bound opaque continuation; returns a same-origin OAuth interaction. |
| `POST /register` | `{login,password}` → `{user,csrfToken,recoveryCodes}`. Show recovery codes once. |
| `POST /login` | `{login,password}` → `{user,csrfToken}`. |
| `POST /recover` | `{login,recoveryCode,newPassword}`. Revokes browser sessions and all grants; consumes all old recovery codes. |
| `POST /logout` | Ends this browser session and clears pending server QR state. |
| `GET /me` | `{user:{id,login,hasPassword},csrfToken,policy,telegram,mcpUrl}`. Telegram contains process state, busy, sessionPresent and the verified account identity when saved. |
| `POST /telegram/login` | Starts one user-bound attempt, returns `{id,state,expiresAt}` with HTTP 202. |
| `GET /telegram/login` | Returns the current active attempt owned by this cabinet, without starting a worker or creating a session. |
| `GET /telegram/login/:id` | Latest state: connecting, qr, needs-password, success, error, cancelled or expired. QR state includes a PNG data URL; success includes account ID and optional username. |
| `POST /telegram/login/:id/password` | `{password}` accepted only while that attempt is waiting for 2FA. Never persisted or included in DTOs. |
| `DELETE /telegram/login/:id` | Cancels the attempt. Foreign or expired IDs return 404. |
| `GET /clients` | `{clients:[{grantId,clientId,version}]}`. |
| `DELETE /clients/:grantId` | Revokes only the authenticated user's grant. |
| `PUT /policy` | `{profile:"read"\|"full",chatIds:string[]}`. Numeric chat IDs, at most 100. Bumps policy version, revokes grants and stops the old worker. |
| `POST /telegram/disconnect` | Removes this user's server session and grants and stops its worker. |
| `DELETE /account` | `{password}` confirms deletion. Access is disabled before storage is purged. |

Logins use 3–32 ASCII letters, digits or underscores, normalized to lowercase. Passwords require 16–1024 characters. Registration is limited to five requests per IP per hour and 20 globally per hour. Login/recovery share ten attempts per IP per 15 minutes. Authenticated API access is limited to 120 requests per user per minute and the API as a whole to 600 per minute. QR starts are limited to three per user per ten minutes, with a five-minute deadline and six-minute attempt retention.

## MCP and the server Telegram session

Connect MCP clients to the public `/mcp` endpoint using the advertised OAuth discovery endpoints. PKCE is required. Each consent grant binds an enabled SaaS account and policy version. The binding is checked on every MCP request and before refreshing tokens, so failed asynchronous provider cleanup cannot restore revoked access. Read-only policy filters both tool listing and calls. Before Telegram setup only `telegram-status` is available. QR login and disconnect are controlled through the cabinet API.

The dashboard talks only to its own origin. It cannot contact Telegram directly, start a browser worker or persist a browser Telegram session. Former hashed Telegram Web service worker URLs serve a one-time retirement script, and the cabinet clears the old client caches and browser session data on this origin.

Storage remains schema version 3 for coherent rollback. Back up the full stopped service auth directory and preserve the encryption key separately. Removing old accounts is a one-time owner-authorized release action; subsequent deployments never reset accounts.

## Sending files from AI clients

### Direct transfer from Claude.ai code execution

Enable code execution and network access to your MCP server's domain in Claude's capabilities settings. When available, the hosted gateway exposes `telegram-create-media-upload`: Claude computes the actual file's name, size and SHA-256 in Python, then calls the tool with that small metadata object. This tool returns an HTTPS upload URL, temporary authorization headers and `pythonCode`. Run that code with `file_path` changed to the actual sandbox file. It transfers binary chunks directly; the model never needs to copy base64.

Each `PUT` carries at most 512 KiB and `Upload-Offset` equal to the preceding response's `receivedBytes`, so the existing 1 MiB reverse-proxy limit remains sufficient. The gateway checks the complete SHA-256 before marking the file ready. Use the returned `fileId` with the Telegram send tool only after `ready:true`. Identical retries of the most recent chunk are safe; `GET uploadUrl` with the same authorization header returns status if a response was lost. Uploading does not send a Telegram message.

The temporary authorization permits one file of at most 20 MiB, expires after five minutes and remains bound to the account and OAuth grant. Read-only accounts cannot create links. Revoked grants, policy changes, disconnects and shutdown stop transfers; expired links must be recreated. An interrupted upload may leave an incomplete account-scoped file until normal cleanup. If Claude's network settings prohibit this domain, the sandbox cannot transfer the file directly. A sandbox path alone still cannot transfer a file, and a file that no longer exists must first be recovered or recreated in the client.

### Native attachments, URLs and byte uploads

The hosted server cannot read the AI app's sandbox or your computer's filesystem. Provide exactly one source when sending media: a native conversation `file`, a completed `fileId`, a public HTTPS `fileUrl`, or an absolute `filePath` already inside your account's server directory. This applies to files, voice notes, round video notes, album items, stories and profile photos; group photos retain `photoPath` for their local-path option.

For ChatGPT, these tools advertise `openai/fileParams` so the client can supply an attachment directly. The client fills `file` with `download_url` and `file_id`, plus optional `file_name` and `mime_type`; the server downloads its bytes into the account's media directory before sending. The client file ID is not a `telegram-upload-media` handle. Albums accept native attachments in the top-level `files` array. Clients that do not support native attachment parameters must provide actual bytes or a downloadable URL; a sandbox path alone cannot transfer a file.

New downloads in an album share a 20 MiB total limit, so all 2–10 attachments fit the same admission reservation. For larger albums, upload the files separately and send their completed `fileId` handles. Existing server files and uploaded handles do not consume that download budget.

```json
{"chatId":"@recipient","file":{"download_url":"https://files.example.com/download?signature=temporary","file_id":"file-client-id","file_name":"photo.png"}}
```

For a downloadable URL, one call is sufficient:

```json
{"chatId":"@recipient","fileUrl":"https://example.com/photo.png"}
```

If the AI can read the file bytes, call `telegram-upload-media` first. For a small text document:

```json
{"fileName":"hello.txt","data":"SGVsbG8K"}
```

The result includes `fileId`, `receivedBytes`, `ready` and `expiresAt`. Use the returned handle with `telegram-send-file`:

```json
{"chatId":"@recipient","fileId":"<returned fileId>","mediaType":"document"}
```

For larger files, encode each chunk separately as standard base64. Each chunk may contain at most 512 KiB of raw bytes, keeping requests below the gateway's 1 MiB JSON limit. The first call includes `fileName`, `data` and `final:false`. Continue with the returned `fileId`, `offset` equal to `receivedBytes`, and `data`. Set `final:true` on the last chunk and wait for `ready:true` before sending. Retrying an identical chunk at the same offset is safe. Uploading does not send a Telegram message. Sending retains the existing no-automatic-retry behavior to avoid duplicate messages after uncertain delivery.

Files retain their original names and extensions. Photos and videos use automatic detection; `mediaType:"document"` sends the original bytes as an attachment. The default per-file limit is 20 MiB. Account and aggregate disk quotas apply to staging as well as downloads. File handles are private to the authenticated account, survive worker restarts and expire after one hour. The gateway removes expired files at startup and every five minutes, with a one-minute grace period for active sends. Account deletion also removes staged files.

Use direct download URLs, including signed HTTPS URLs. HTML sharing pages, AI-only `sandbox:` links, private addresses and redirects into private networks are rejected. If an AI app exposes neither bytes nor a downloadable URL, its sandbox attachment cannot be transferred by the MCP tool alone; the client must make one of those sources available. Read-only access disables uploads and sending. After updating the server, reconnect the AI client to refresh its tool schemas.


## Multiple Telegram connections

The hosted cabinet supports up to five isolated Telegram connections per cabinet. See [Multiple Accounts](./multiple-accounts.md) for QR/2FA setup, account-specific permissions, explicit AI sender selection and removal recovery. `telegram-list-accounts` and the optional `telegramAccountId` selector are SaaS-only; stdio and owner HTTP retain their single-session behavior.

OAuth pages declare an explicit script policy so oidc-provider can authorize its automatic form submission through an exact SHA-256 hash. Registered callback origins are allowed for form POST responses. Cloudflare's analytics script and ingestion host are explicitly permitted on cabinet/OAuth pages; arbitrary inline scripts remain blocked.
