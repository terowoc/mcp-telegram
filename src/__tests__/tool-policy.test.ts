import assert from "node:assert/strict";
import { it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import type { TelegramService } from "../telegram-client.js";
import { ToolExecutor } from "../tool-executor.js";
import { applyToolProfile, ToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";

it("read profile disables writes at owner dispatch, including direct IPC handlers", async () => {
  let sends = 0;
  const telegram = {
    sendMessage: async () => {
      sends++;
    },
    ensureConnected: async () => true,
  } as unknown as TelegramService;
  const server = new McpServer({ name: "policy", version: "test" });
  registerTools(server, telegram);
  const internal = server as unknown as McpServerInternal;
  applyToolProfile(internal, new ToolPolicy({ profile: "read" }));
  const executor = new ToolExecutor({ tools: internal._registeredTools });
  await assert.rejects(executor.call("telegram-send-message", { chatId: "123", text: "hello" }), /Unknown|disabled/);
  assert.equal(sends, 0);
  assert.equal(internal._registeredTools["telegram-read-messages"].enabled, true);
});

it("chat policy canonicalizes aliases, denies global and out-of-scope operations", async () => {
  const policy = new ToolPolicy({ profile: "full", chatIds: ["-100123", "42"] });
  const resolve = async (id: string) => (id === "@allowed" ? "-100123" : id === "@other" ? "-100999" : id);
  assert.deepEqual(await policy.authorize("telegram-read-messages", { chatId: "@allowed", limit: 10 }, resolve), {
    chatId: "-100123",
    limit: 10,
  });
  await assert.rejects(policy.authorize("telegram-read-messages", { chatId: "@other" }, resolve), /not allowed/i);
  await assert.rejects(policy.authorize("telegram-search-global", { query: "secret" }, resolve), /policy|scope/i);
  await assert.rejects(policy.authorize("telegram-forward-message", { fromChatId: "42", toChatId: "@other" }, resolve));
  assert.equal(policy.allowsChat("-100123"), true);
  assert.equal(policy.allowsChat("123"), false);
});

it("invalid profile or noncanonical allowlist refuses configuration", () => {
  assert.throws(() => new ToolPolicy({ profile: "typo" }), /profile/i);
  assert.throws(() => new ToolPolicy({ chatIds: ["@username"] }), /canonical/i);
});

it("chat restrictions deny deletion whose Telegram RPC has no peer scope", async () => {
  const policy = new ToolPolicy({ chatIds: ["42"] });
  await assert.rejects(
    policy.authorize("telegram-delete-message", { chatId: "42", messageIds: [999] }, async () => "42"),
    /scope|policy/,
  );
});

it("alias errors never expose disallowed dialog names or IDs", async () => {
  const policy = new ToolPolicy({ chatIds: ["42"] });
  let message = "";
  try {
    await policy.authorize("telegram-read-messages", { chatId: "secret" }, async () => {
      throw new Error("Ambiguous: Private secret one (900), Private secret two (901)");
    });
  } catch (error) {
    message = (error as Error).message;
  }
  assert.ok(message);
  assert.doesNotMatch(message, /Private|secret|900|901/);
});

it("read profile blocks both transcription entry points that consume quota", async () => {
  let calls = 0;
  const server = new McpServer({ name: "transcription-policy", version: "test" });
  registerTools(server, {
    ensureConnected: async () => true,
    transcribeAudio: async () => {
      calls++;
      return { text: "hello" };
    },
  } as unknown as TelegramService);
  const internal = server as unknown as McpServerInternal;
  applyToolProfile(internal, new ToolPolicy({ profile: "read" }));
  const tools = new ToolExecutor({ tools: internal._registeredTools });
  await assert.rejects(tools.call("telegram-get-transcription", { chatId: "42", messageId: 1 }), /Unknown|disabled/);
  assert.equal(calls, 0);
});
