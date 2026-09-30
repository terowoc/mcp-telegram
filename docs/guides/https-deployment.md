# HTTPS deployment

Run `mcp-telegram http` behind an HTTPS reverse proxy. The gateway uses Streamable HTTP at `/mcp` and OAuth at `/oauth`. Compatible OAuth clients discover the issuer from the `WWW-Authenticate` response. Clients must support Authorization Code with PKCE S256 and dynamic registration. Each new client needs approval from the owner. Compatibility must still be verified in each client's current version.

The owner signs in using a dedicated password, independent of the VPS password and Telegram two-factor password. Store only its scrypt hash in the mounted `owner-password.hash`; keep the original password in a password manager. There is no public account registration. OAuth clients can register without receiving access until the owner approves them. Tokens, grants and signing keys persist in `data/auth`; back up that directory together with the Telegram session and owner hash.

## VPS layout

Use a dedicated directory `/opt/mcp-telegram` with `compose.yaml`, `telegram.env`, `owner-password.hash`, `deployment.env`, and private `data/telegram`, `data/auth`, `data/files` directories. Persistent directories belong to UID 1000, permissions 0700. Compose binds only `127.0.0.1:18770`; nginx owns public HTTPS. Copy `packaging/compose.production.yaml` and configure a new vhost from `packaging/nginx.conf`. Validate nginx before reload. Provision the certificate using certbot's webroot plugin; do not modify other vhosts.

The production image uses Node 24, a non-root user, production dependencies, a read-only root filesystem and memory/CPU/PID limits. Upload paths must stay under `/data/files`; URLs and symlink escapes are rejected. Downloads create new files exclusively and reject overwrites. The default hosted media size limit is 20 MiB. HTTP request and tool response limits are 1 MiB and 2 MiB respectively; paginate large reads.

## Automated deployment

GitHub Actions checks lint, types and tests before publishing `ghcr.io/terowoc/mcp-telegram`. It deploys an immutable digest over a dedicated SSH key. The VPS command updates only the `mcp-telegram` Compose project, stops the old owner before starting a replacement, and restores the previous image if readiness fails. It takes a consistent OAuth database backup while the old service is stopped. Existing Docker projects are outside this command's scope.

Configure repository secrets `VPS_SSH_KEY` and `VPS_KNOWN_HOSTS`, and variables `VPS_HOST` and `VPS_USER`. The deploy key is constrained to `/opt/mcp-telegram/deploy-vps.sh` and cannot open a shell or forward ports. The deployment job sends its temporary GitHub token over encrypted SSH stdin to authenticate the GHCR pull; registry credentials are deleted after each deployment. The pipeline never copies Telegram credentials or sessions into GitHub.

## Telegram authorization

After deployment, run `docker compose --env-file deployment.env -f compose.yaml -p mcp-telegram exec mcp node dist/cli.js login` from `/opt/mcp-telegram` through SSH. Scan the QR in Telegram → Settings → Devices → Link Desktop Device. If the account uses two-step verification, configure `TELEGRAM_2FA_PASSWORD` privately in the server environment and recreate only this service before logging in. The daemon reads the password; the login CLI does not prompt for it. Remove the password from the environment after successful authorization and recreate the service to discard it from process memory. QR login communicates with the running owner through IPC; it must not start a second MTProto session.

Use authenticated `telegram-status` to verify the account, then restart only this Compose service and check that the session and OAuth access survive. `/healthz` reports gateway/IPC readiness without exposing account details; it can be healthy before first Telegram authorization.

## Runtime options

`MCP_PUBLIC_URL` is a canonical HTTPS origin, `MCP_AUTH_DIR` stores OAuth state, and `MCP_OWNER_PASSWORD_HASH_FILE` points to the private hash. `MCP_ALLOWED_ORIGINS` is a comma-separated browser origin allowlist. HTTP mode trusts one proxy hop; publish its container port only on host loopback and configure nginx to replace forwarding headers. A standalone HTTP listener must use an equivalent trusted ingress. Local stdio and daemon modes remain available.

## Audit hardening and migration

Restart the owner and all local IPC clients together after upgrading. Lock and socket identities now include the complete canonical session path: two session files in one directory are isolated. A live legacy daemon lock deliberately blocks startup until that old owner is stopped. Relative paths and symlink aliases resolve to one identity. Long Unix socket paths use a private per-user temporary directory.

Tool deadlines include time spent in the queue. Cancelled and expired queued calls never start. If an in-flight operation cannot stop immediately, the owner keeps its lock until it settles; after five seconds of failed settlement it exits for supervisor recovery. A timeout can mean delivery is uncertain: inspect the chat before manually resending. Raw sends retain their deduplication ID across retries; opaque high-level sends are not automatically replayed after uncertain network failures.

Set `MCP_TOOL_PROFILE=full` (default), `read`, or `curated`. Read enables tools annotated read-only; downloads, authentication changes and both transcription entry points remain writes. The raw IPC QR entry point enforces the same profile. Cancelled or expired QR operations use the same lock-retention and recovery boundary as tool calls. Curated exposes connection tools, basic reading, inbox, draft preparation and message sending. The owner enforces the profile for IPC as well as discovery.

`MCP_ALLOWED_CHAT_IDS` optionally restricts access to comma-separated canonical peer IDs: positive IDs for users, negative IDs for basic groups and `-100…` IDs for channels/supergroups. Obtain these from chat enumeration before enabling the restriction. Aliases are resolved and replaced with canonical IDs before execution; dialog and unread enumeration filter disallowed chats before returning or fetching forum details. Under an allowlist, only explicitly reviewed scoped tools are available. Global searches, account-wide state, cross-chat updates, message deletion and other unsupported scope contracts are disabled. Telegram non-channel deletion has no peer scope, so it is unavailable under chat restrictions. Alias-resolution failures return a generic error without disallowed chat names or IDs. Newly added tools are unavailable until their scope is reviewed. Clear the variable to allow all chats.

`telegram-inbox` reads at most 20 chats and 10 messages per chat; use each returned `nextOffsetId` with `telegram-read-messages` for older history. `telegram-prepare-message` returns a structured draft and resolves the destination without sending. Sending requires a separate call to `telegram-send-message`. Numeric read limits must be positive integers within the advertised schema maximum. Local, IPC and HTTP dispatch share a two-MiB output budget; narrow requests or paginate instead of requesting unbounded output.

Run `docker compose --env-file deployment.env -f compose.yaml -p mcp-telegram exec mcp node dist/cli.js doctor` for redacted readiness, login state, queue occupancy and operation counters. The same diagnostics are available as `telegram-doctor` through authenticated MCP, even when the execution queue is blocked. Public `/healthz` returns only readiness; it does not expose account identity or messages.

This fork deploys GHCR images from trusted main-branch Actions runs. It does not publish the inherited upstream npm package or MCP Registry namespace. Upstream release automation calls its publishing workflow explicitly instead of relying on a release event generated by `GITHUB_TOKEN`.

For Cloudflare proxying, the origin already terminates valid HTTPS. Use Full (strict) for this hostname, or DNS-only for its DNS record. A Flexible connection to an HTTP-to-HTTPS origin redirect can loop; configure the individual hostname rather than changing unrelated sites. See [Cloudflare redirect troubleshooting](https://developers.cloudflare.com/ssl/troubleshooting/too-many-redirects/).
