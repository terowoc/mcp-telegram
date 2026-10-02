# Personal Instagram messages

The hosted SaaS cabinet can connect up to five personal Instagram accounts
per owner and expose their DMs through the existing OAuth-protected MCP URL.
Telegram connections remain separate. Instagram is disabled by default.

## Enable the server

The production image includes Python 3.11 and a private environment with
`instagrapi==3.0.18` and hashed, pinned dependencies. Set
`MCP_INSTAGRAM_ENABLED=1` in the Compose environment, then recreate the
service through the normal deployment process. The image supplies
`MCP_INSTAGRAM_PYTHON=/opt/instagram/bin/python`.

For local SaaS development, use Python 3.11 or later:

```sh
python3.12 -m venv .venv-instagram
.venv-instagram/bin/pip install --require-hashes -r packaging/instagram/requirements.txt
npm run build
MCP_INSTAGRAM_ENABLED=1 MCP_INSTAGRAM_PYTHON="$PWD/.venv-instagram/bin/python" node dist/cli.js saas
```

Existing SaaS environment variables and Telegram server API credentials
are still required. When enabled, startup checks the interpreter and exact
library version before accepting traffic. No public Python API is exposed.
Both protocols share `MCP_SAAS_MAX_WORKERS` and idle worker eviction.

## Connect an account

Sign into your cabinet, open **Instagram**, add a named connection, and
enter the Instagram username and password. Supply a login code if prompted.
Passwords/codes are transient; the server persists an encrypted session
bound to the owner and private connection UUID. This uses Instagram's
unofficial private API and does not provide Telegram-style QR login.

Login requires cabinet authentication within the previous five minutes.
If prompted to authenticate again, sign back into the cabinet and retry.
If Instagram asks for a selfie, CAPTCHA, or another unsupported review,
complete it in the official app and retry here. Do not repeatedly restart
login. Rate limits impose a cooldown of at least 60 seconds.

Each slot reconnects to its originally verified identity. To switch the
Instagram identity, remove that slot and add another. A personal Instagram
account can appear only once within a cabinet. Sessions are never shared
between cabinets.

New connections permit reading only. Enable **Чтение и отправка сообщений**
to allow text replies; optionally enter up to 100 allowed thread IDs.
Changing account membership, connection state, labels, or permissions
revokes existing OAuth grants. Reconnect your AI clients to confirm access.

## Use MCP

Call `instagram-list-accounts` and choose its private UUID explicitly as
`instagramAccountId` on every account-specific call. Dashboard selection
does not change the AI sender. Telegram account selectors cannot be used
on Instagram calls.

- `instagram-status`: local session and worker status.
- `instagram-list-chats`: up to 20 allowed thread summaries and a cursor.
- `instagram-read-messages`: the latest 1–50 messages from a thread,
  without marking it seen. There is no historical pagination in this phase.
- `instagram-send-message`: one plain text message of up to 1,000 Unicode
  code points to an existing thread, with a UUID `requestId`.

Generate a new request UUID for each intended send. Repeating the same key
and payload within 24 hours returns the confirmed result or its pending/
unknown status; it never sends again. A changed payload under the same key
fails. On `delivery-unknown`, inspect the thread before deciding whether to
send a new message; automatically using a new key can create a duplicate.
The server retains at most 2,000 unexpired request records per connection.
The deduplication key is scoped to the connection generation; changing
access or reconnecting creates a new generation. This is not an exactly-once
guarantee from Instagram.

Media handling, quoted replies, new conversations, posting, realtime
subscriptions, forwarding between networks, and Instagram support in stdio/
daemon/single-owner HTTP modes are outside this release.

Disconnect removes the local server session and stops its worker. It does
not guarantee remote session revocation; use Instagram's active-device
settings to revoke the login remotely. Removing the cabinet also removes
all owned Instagram state. Browser logout preserves established connections
and cancels active login attempts.

## Migration, rollback, and verification

The additive migration advances the SaaS database from schema 4 to 5.
Roll back with the matching previous image **and** its pre-migration auth/
database snapshot. An old binary rejects schema 5, so image-only rollback
is insufficient. Connections created after the backup need reconnecting.
The existing deployment script keeps versioned auth snapshots.

Run `npm test`, `npm run typecheck`, `npm run lint`, `npm run web:check`,
`npm run web:build`, and the Python adapter tests with the pinned environment:

```sh
.venv-instagram/bin/python -m unittest discover -s src/__tests__ -p 'test_instagram_worker.py'
```

Automated tests use process and transport fixtures. They do not authenticate
a real Instagram account or send to anyone. A live login/read smoke check
needs account-holder participation; a live send additionally needs an
explicitly authorized recipient/thread. Report those checks separately.
