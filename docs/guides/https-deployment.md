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

After deployment, run `docker compose --env-file deployment.env -f compose.yaml -p mcp-telegram exec mcp node dist/cli.js login` from `/opt/mcp-telegram` through SSH. Scan the QR in Telegram → Settings → Devices → Link Desktop Device. If Telegram requests a two-factor password, enter it in that private terminal. QR login communicates with the running owner through IPC; it must not start a second MTProto session.

Use authenticated `telegram-status` to verify the account, then restart only this Compose service and check that the session and OAuth access survive. `/healthz` reports gateway/IPC readiness without exposing account details; it can be healthy before first Telegram authorization.

## Runtime options

`MCP_PUBLIC_URL` is a canonical HTTPS origin, `MCP_AUTH_DIR` stores OAuth state, and `MCP_OWNER_PASSWORD_HASH_FILE` points to the private hash. `MCP_ALLOWED_ORIGINS` is a comma-separated browser origin allowlist. HTTP mode trusts one proxy hop; publish its container port only on host loopback and configure nginx to replace forwarding headers. A standalone HTTP listener must use an equivalent trusted ingress. Local stdio and daemon modes remain available.
