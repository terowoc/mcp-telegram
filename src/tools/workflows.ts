import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { pageLimit } from "../limits.js";
import { operationSignal } from "../operation-context.js";
import type { TelegramService } from "../telegram-client.js";
import { checkMessageLength, fail, ok, READ_ONLY, requireConnection, sanitizeInputText } from "./shared.js";

export function registerWorkflowTools(server: McpServer, telegram: TelegramService) {
  server.registerTool(
    "telegram-prepare-message",
    {
      description:
        "Resolve a destination and validate a message draft without sending. Review the returned draft, then use telegram-send-message for an explicitly authorized send.",
      inputSchema: {
        chatId: z.string(),
        text: z.string().transform(sanitizeInputText),
        parseMode: z.enum(["md", "html"]).optional(),
        replyTo: z.number().int().positive().optional(),
        topicId: z.number().int().positive().optional(),
      },
      annotations: READ_ONLY,
    },
    async ({ chatId, text, parseMode, replyTo, topicId }) => {
      const tooLong = checkMessageLength(text, parseMode);
      if (tooLong) return fail(new Error(tooLong));
      const connection = await requireConnection(telegram);
      if (connection) return fail(new Error(connection));
      try {
        const canonical = await telegram.canonicalChatId(chatId);
        const chat = await telegram.getChatInfo(canonical);
        const draft = { chatId: canonical, destination: chat.name, text, parseMode, replyTo, topicId, sent: false };
        return ok(
          `Draft for ${chat.name} (${canonical}):\n${text}\n\nReady for review. Use telegram-send-message to send.`,
          draft,
        );
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "telegram-inbox",
    {
      description:
        "Read a bounded overview of unread chats with recent messages. Each chat includes an offsetId for older history via telegram-read-messages; no messages are marked read.",
      inputSchema: { limit: pageLimit(10, 20), messagesPerChat: pageLimit(3, 10) },
      annotations: READ_ONLY,
    },
    async ({ limit, messagesPerChat }) => {
      const connection = await requireConnection(telegram);
      if (connection) return fail(new Error(connection));
      try {
        const dialogs = (await telegram.getUnreadDialogs(limit)).slice(0, limit);
        const chats = [];
        for (const dialog of dialogs) {
          operationSignal()?.throwIfAborted();
          const messages = (await telegram.getMessages(dialog.id, messagesPerChat)).slice(0, messagesPerChat);
          chats.push({
            id: dialog.id,
            name: dialog.name,
            unreadCount: dialog.unreadCount,
            messages,
            nextOffsetId: messages.at(-1)?.id,
          });
        }
        const text = chats
          .map(
            (chat) =>
              `${chat.name} (${chat.id}) — ${chat.unreadCount} unread\n${chat.messages.map((message) => `[#${message.id}] ${message.text}`).join("\n")}\nOlder history: offsetId=${chat.nextOffsetId ?? "none"}`,
          )
          .join("\n\n");
        return ok(text || "No unread chats", { chats, limit, messagesPerChat, historyTool: "telegram-read-messages" });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
