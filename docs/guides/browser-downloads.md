# Download Telegram files to your device

The hosted SaaS `telegram-download-media` tool returns a private HTTPS link.
Open its complete `downloadUrl` in a browser and click **Скачать файл**.
The original Telegram filename is preserved when available. You can optionally
provide `fileName` to choose a different download name.

Ask your AI client: “Give me a browser download link for the PDF attached to
message [message ID] in [chat].” For another connected Telegram account, include
its `telegramAccountId` from `telegram-list-accounts` on the download call.

```json
{
  "chatId": "me",
  "messageId": 123,
  "telegramAccountId": "[connection UUID]"
}
```

Omit `telegramAccountId` for the primary account. Omit `downloadPath` to let the
server manage temporary storage. If an existing AI connection still asks for a
VPS path, refresh its MCP tool definitions or reconnect it. Existing callers
that specify a valid account-local `downloadPath` still receive a browser link
and retain their output file.

Links expire after five minutes and can be retried during that window. Keep the
full URL, including its fragment, private. The fragment is removed from the
browser address bar after opening the page and is never sent in the HTTP URL.
Only the selected file is accessible through the link. File downloads retain
the existing tool permissions; account/chat restrictions and AI-client grant
revocation remain enforced. Revoked grants, disconnected accounts, server
restarts and expired links require a new link.

The current maximum is **20 MiB**. Temporary files created without a legacy
output path are reclaimed after expiry and during shutdown. Partial files from
an interrupted server run are reclaimed by maintenance. There are at most five
live links per cabinet and 100 across the server; transfers are limited to one
per cabinet and four across the server.

The browser-link flow is available in the hosted SaaS cabinet. Stdio and
single-owner HTTP calls retain their existing server-file download behavior.
