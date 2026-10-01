import assert from "node:assert/strict";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHostedTools } from "../http/tool-catalog.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import type { TelegramService } from "../telegram-client.js";
import { applyToolProfile, ToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";

const tools = (server: McpServer) => (server as unknown as McpServerInternal)._registeredTools;
test("direct upload links are hosted-only and respect read-only and chat policies", async () => {
  for (const [policy, enabled, expected] of [
    [new ToolPolicy({ profile: "full" }), true, true],
    [new ToolPolicy({ profile: "full", chatIds: ["42"] }), true, true],
    [new ToolPolicy({ profile: "read" }), true, false],
    [new ToolPolicy({ profile: "full" }), false, false],
  ] as const) {
    const server = new McpServer({ name: "direct-policy", version: "test" });
    registerHostedTools(server, policy, enabled);
    assert.equal(!!tools(server)["telegram-create-media-upload"], expected);
    await server.close();
  }
});
test("cached catalog preserves schemas, annotations and policy-specific visibility", async () => {
  for (const policy of [
    new ToolPolicy({ profile: "full" }),
    new ToolPolicy({ profile: "read" }),
    new ToolPolicy({ profile: "full", chatIds: ["-100123"] }),
  ]) {
    const original = new McpServer({ name: "original", version: "test" });
    registerTools(original, {} as TelegramService);
    applyToolProfile(original as unknown as McpServerInternal, policy);
    const cached = new McpServer({ name: "cached", version: "test" });
    registerHostedTools(cached, policy);
    const visible = Object.entries(tools(original))
      .filter(([, tool]) => tool.enabled)
      .map(([name]) => name);
    assert.deepEqual(Object.keys(tools(cached)), visible);
    const before = tools(original)["telegram-read-messages"],
      after = tools(cached)["telegram-read-messages"];
    assert.deepEqual(after.annotations, before.annotations);
    assert.ok(after.inputSchema && before.inputSchema);
    assert.deepEqual(
      await after.inputSchema.safeParseAsync({ chatId: "me", limit: 5 }),
      await before.inputSchema.safeParseAsync({ chatId: "me", limit: 5 }),
    );
    assert.equal((await after.inputSchema.safeParseAsync({ chatId: "me", limit: 10000 })).success, false);
    await Promise.all([original.close(), cached.close()]);
  }
});

test("request registries and handlers remain isolated while schemas are reused", async () => {
  const a = new McpServer({ name: "a", version: "test" }),
    b = new McpServer({ name: "b", version: "test" });
  registerHostedTools(a, new ToolPolicy({ profile: "full" }));
  registerHostedTools(b, new ToolPolicy({ profile: "read" }));
  const first = tools(a)["telegram-read-messages"],
    second = tools(b)["telegram-read-messages"];
  assert.notStrictEqual(first, second);
  assert.strictEqual(first.inputSchema, second.inputSchema);
  first.handler = async () => ({ account: "a" });
  second.handler = async () => ({ account: "b" });
  first.enabled = false;
  assert.equal(second.enabled, true);
  assert.deepEqual(await second.handler({}, {}), { account: "b" });
  assert.equal(tools(b)["telegram-send-message"], undefined);
  await Promise.all([a.close(), b.close()]);
});
