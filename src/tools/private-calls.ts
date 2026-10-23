import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { privateCallsEnabled } from "../calls/private-call.js";
import type { TelegramService } from "../telegram-client.js";
import { fail, ok, READ_ONLY, requireConnection, WRITE } from "./shared.js";

export function isPrivateCallsEnabled(): boolean {
  return privateCallsEnabled(process.env);
}

export function registerPrivateCallTools(server: McpServer, telegram: TelegramService) {
  if (!isPrivateCallsEnabled()) return;

  server.registerTool(
    "telegram-call-start",
    {
      description:
        'Place a private (1:1) Telegram voice call from this account to a user and relay its audio to a media bridge over WebSocket (binary frames: s16le mono 48 kHz PCM both ways; text frames: JSON control messages start/active/end and, from the bridge, {"type":"hangup"}). Returns at once with callId and state \'ringing\'; poll telegram-call-status. One call at a time per account; unanswered calls end after 45 s. media_url must be wss:// on a host listed in MCP_TELEGRAM_CALL_MEDIA_HOSTS. Opt-in: registered only when MCP_TELEGRAM_ENABLE_PRIVATE_CALLS=1.',
      inputSchema: {
        user: z.string().describe("User to call — id, @username, or phone number of a contact"),
        media_url: z.string().describe("wss:// URL of the media bridge that talks on the call (allow-listed host)"),
        max_seconds: z
          .number()
          .int()
          .min(10)
          .max(1800)
          .optional()
          .describe("Hard limit for the call length after it starts (default 600)"),
      },
      annotations: WRITE,
    },
    async ({ user, media_url, max_seconds }) => {
      const err = await requireConnection(telegram);
      if (err) return fail(new Error(err));
      try {
        const status = await telegram.startPrivateCall(user, media_url, { maxSeconds: max_seconds });
        return ok(JSON.stringify(status), { ...status });
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "telegram-call-status",
    {
      description:
        "State of the current or a recent private call placed with telegram-call-start: starting, ringing, connecting, active or ended, with timestamps, end reason and duration. Opt-in: registered only when MCP_TELEGRAM_ENABLE_PRIVATE_CALLS=1. Read-only.",
      inputSchema: {
        call_id: z.string().optional().describe("callId from telegram-call-start (default: current or last call)"),
      },
      annotations: READ_ONLY,
    },
    async ({ call_id }) => {
      const status = telegram.getPrivateCallStatus(call_id);
      if (!status) return fail(new Error(call_id ? `No call ${call_id}` : "No call has been placed yet"));
      return ok(JSON.stringify(status), { ...status });
    },
  );

  server.registerTool(
    "telegram-call-end",
    {
      description:
        "Hang up the current private call placed with telegram-call-start (or the one with call_id). Safe to repeat. Opt-in: registered only when MCP_TELEGRAM_ENABLE_PRIVATE_CALLS=1.",
      inputSchema: {
        call_id: z.string().optional().describe("callId to end (default: the current call)"),
      },
      annotations: WRITE,
    },
    async ({ call_id }) => {
      try {
        const status = await telegram.endPrivateCall(call_id);
        if (!status) return fail(new Error("No call to end"));
        return ok(JSON.stringify(status), { ...status });
      } catch (e) {
        return fail(e);
      }
    },
  );
}
