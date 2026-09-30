import assert from "node:assert/strict";
import { it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import type { TelegramService } from "../telegram-client.js";
import { ToolExecutor } from "../tool-executor.js";
import { registerTools } from "../tools/index.js";

function executor(service: Record<string, unknown>) {
  const server = new McpServer({ name: "workflows", version: "test" });
  registerTools(server, service as unknown as TelegramService);
  return new ToolExecutor({ tools: (server as unknown as McpServerInternal)._registeredTools });
}

it("prepare-message resolves and validates a draft without sending anything", async () => {
  let sends = 0;
  const tools = executor({
    ensureConnected: async () => true,
    canonicalChatId: async () => "-100123",
    getChatInfo: async () => ({ id: "123", name: "Project", type: "channel" }),
    sendMessage: async () => {
      sends++;
    },
  });
  const result = (await tools.call("telegram-prepare-message", { chatId: "@project", text: "Hello" })) as {
    structuredContent: Record<string, unknown>;
  };
  assert.equal(result.structuredContent.chatId, "-100123");
  assert.equal(result.structuredContent.text, "Hello");
  assert.equal(sends, 0);
  const tooLong = (await tools.call("telegram-prepare-message", { chatId: "@project", text: "x".repeat(10000) })) as {
    isError?: boolean;
  };
  assert.equal(tooLong.isError, true);
  assert.equal(sends, 0);
});

it("inbox bounds both chat and message aggregation and provides history cursors", async () => {
  let reads = 0;
  const tools = executor({
    ensureConnected: async () => true,
    getUnreadDialogs: async () =>
      Array.from({ length: 30 }, (_, i) => ({ id: String(i + 1), name: `chat ${i}`, unreadCount: 20 })),
    getMessages: async () => {
      reads++;
      return Array.from({ length: 20 }, (_, i) => ({ id: 100 - i, text: "hello" }));
    },
  });
  const result = (await tools.call("telegram-inbox", { limit: 2, messagesPerChat: 3 })) as {
    structuredContent: { chats: { messages: unknown[]; nextOffsetId: number }[] };
  };
  assert.equal(reads, 2);
  assert.equal(result.structuredContent.chats.length, 2);
  assert.equal(result.structuredContent.chats[0].messages.length, 3);
  assert.equal(result.structuredContent.chats[0].nextOffsetId, 98);
});
