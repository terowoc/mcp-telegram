# Multiple Accounts

## Hosted cabinet (ChatGPT and Claude.ai)

The hosted SaaS cabinet supports up to **five Telegram accounts** per cabinet, including the primary and accounts awaiting setup or removal.

1. Open the cabinet and choose **Add Telegram account**. Give it a name such as Work or Personal.
2. Scan that account's QR code in Telegram → Settings → Devices → Link Desktop Device. Enter its cloud password if Telegram requests two-step verification.
3. Select an account in the cabinet to view its connection and change its permissions. Each account has separate encrypted session storage, worker identity and temporary files.
4. Reauthorize your AI connector after adding/removing accounts or changing permissions. OAuth consent covers the listed accounts and their individual access rules.
5. Ask the AI to call `telegram-list-accounts`, then use the returned connection `id` as `telegramAccountId` on every operation for that account.

```json
{"chatId":"me","text":"Sent from Work","telegramAccountId":"<Work connection UUID>"}
```

Omitting `telegramAccountId` always selects the **primary** account. Cabinet selection does not change the AI sender. Use the same ID when uploading and sending a file; uploaded handles belong to one account. The connection UUID differs from the Telegram user's numeric ID.

You can rename or remove additional accounts. Disconnecting keeps the slot for reconnection; removing deletes that connection and its files. The primary can be disconnected but is removed only with the entire cabinet. Duplicate Telegram accounts in the same cabinet are rejected. If removal cannot finish, the account is disabled immediately and shown with **Retry removal**; a persistent queue retries cleanup at startup and every five minutes. Entire-cabinet deletion includes all owned partitions, including previously failed removals.

The global SaaS capacity includes additional account partitions. Worker capacity is separate: idle account workers are replaced automatically when another account needs a slot; if all workers are busy, retry after the server's capacity response.

## Local stdio servers

Run separate Telegram accounts side by side using different session paths.

## Login Each Account

```bash
# Work account
TELEGRAM_API_ID=ID1 TELEGRAM_API_HASH=HASH1 \
  TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-work \
  npx @overpod/mcp-telegram login

# Personal account
TELEGRAM_API_ID=ID2 TELEGRAM_API_HASH=HASH2 \
  TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-personal \
  npx @overpod/mcp-telegram login
```

## Add as Separate MCP Servers

### Claude Code

```bash
claude mcp add telegram-work -s user \
  -e TELEGRAM_API_ID=ID1 \
  -e TELEGRAM_API_HASH=HASH1 \
  -e TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-work \
  -- npx @overpod/mcp-telegram

claude mcp add telegram-personal -s user \
  -e TELEGRAM_API_ID=ID2 \
  -e TELEGRAM_API_HASH=HASH2 \
  -e TELEGRAM_SESSION_PATH=~/.mcp-telegram/session-personal \
  -- npx @overpod/mcp-telegram
```

### Claude Desktop

```json
{
  "mcpServers": {
    "telegram-work": {
      "command": "npx",
      "args": ["@overpod/mcp-telegram"],
      "env": {
        "TELEGRAM_API_ID": "ID1",
        "TELEGRAM_API_HASH": "HASH1",
        "TELEGRAM_SESSION_PATH": "~/.mcp-telegram/session-work"
      }
    },
    "telegram-personal": {
      "command": "npx",
      "args": ["@overpod/mcp-telegram"],
      "env": {
        "TELEGRAM_API_ID": "ID2",
        "TELEGRAM_API_HASH": "HASH2",
        "TELEGRAM_SESSION_PATH": "~/.mcp-telegram/session-personal"
      }
    }
  }
}
```

Each account gets its own session file — no conflicts.

::: warning
A session can only be used by **one process at a time**. Using the same session file in multiple processes causes `AUTH_KEY_DUPLICATED` errors.
:::
