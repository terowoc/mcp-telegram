import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { wireIpcProxies } from "../client.js";
import { registerHostedTools } from "../http/tool-catalog.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import type { TelegramService } from "../telegram-client.js";
import { applyToolProfile, ToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";

const tools = (server: McpServer) => (server as unknown as McpServerInternal)._registeredTools;
test("real SDK dispatch preserves and validates account selectors on tools without native arguments", async () => {
  const server = new McpServer({ name: "account-dispatch", version: "test" });
  const client = new Client({ name: "account-client", version: "test" });
  const selected = "11111111-1111-4111-8111-111111111111";
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  registerHostedTools(server, new ToolPolicy({ profile: "full" }), false, true);
  wireIpcProxies(server, {
    call: async (name, args) => {
      calls.push({ name, args });
      return { content: [{ type: "text", text: "fixture result" }] };
    },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    for (const name of ["telegram-status", "telegram-get-chat-folders"]) {
      const response = await client.callTool({ name, arguments: { telegramAccountId: selected } });
      assert.notEqual(response.isError, true);
      assert.deepEqual(calls.at(-1), { name, args: { telegramAccountId: selected } });
    }
    const count = calls.length;
    const invalid = await client.callTool({ name: "telegram-status", arguments: { telegramAccountId: "not-a-uuid" } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, count);
    await client.callTool({ name: "telegram-status", arguments: {} });
    assert.deepEqual(calls.at(-1)?.args, {});
    const catalog = await client.listTools();
    assert.ok(catalog.tools.find((t) => t.name === "telegram-status")?.inputSchema.properties?.telegramAccountId);
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});
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

test("SaaS catalog offers explicit account selection without changing stdio schemas or native file metadata", async () => {
  const server = new McpServer({ name: "accounts", version: "test" });
  registerHostedTools(server, new ToolPolicy({ profile: "full" }), true, true);
  const selected = "11111111-1111-4111-8111-111111111111";
  const file = tools(server)["telegram-send-file"];
  assert.ok(file.inputSchema);
  const parsed = await file.inputSchema.safeParseAsync({
    telegramAccountId: selected,
    chatId: "me",
    fileId: "media_11111111-1111-4111-8111-111111111111",
  });
  assert.equal(parsed.success, true);
  assert.equal((parsed as { data: Record<string, unknown> }).data.telegramAccountId, selected);
  assert.deepEqual(file._meta, { "openai/fileParams": ["file"] });
  assert.ok(tools(server)["telegram-list-accounts"]);
  const schema = tools(server)["telegram-create-media-upload"].inputSchema;
  assert.ok(schema);
  const upload = await schema.safeParseAsync({
    telegramAccountId: selected,
    fileName: "a.jpg",
    sizeBytes: 1,
    sha256: "0".repeat(64),
  });
  assert.equal((upload as { data: Record<string, unknown> }).data.telegramAccountId, selected);
  await server.close();
});
