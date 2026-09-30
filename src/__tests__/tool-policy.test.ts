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
