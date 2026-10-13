import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import type { GatewayIdentity } from "../http/identity.js";
import { createMcpHandler } from "../http/mcp-handler.js";
import { ToolPolicy } from "../tool-policy.js";

test("real HTTP SDK accepts omitted arguments for status while preserving account and required-field validation", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const identity = {
    kind: "saas",
    isActive: () => true,
    isGrantValid: () => true,
    toolPolicy: () => new ToolPolicy({ profile: "full" }),
    callTool: async (_id: string, name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return { content: [{ type: "text" as const, text: "fixture result" }] };
    },
  } as GatewayIdentity;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.mcpIdentity = { accountId: "owner", grantId: "grant" };
    next();
  });
  app.post("/mcp", createMcpHandler(identity, "test"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const client = new Client({ name: "argument-client", version: "test" });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`)),
    );
    const omitted = await client.callTool({ name: "telegram-status" });
    assert.notEqual(omitted.isError, true);
    assert.deepEqual(calls.at(-1), { name: "telegram-status", args: {} });
    const selected = "11111111-1111-4111-8111-111111111111";
    await client.callTool({ name: "telegram-status", arguments: { telegramAccountId: selected } });
    assert.deepEqual(calls.at(-1)?.args, { telegramAccountId: selected });
    const count = calls.length;
    for (const request of [
      { name: "telegram-status", arguments: { telegramAccountId: "not-a-uuid" } },
      { name: "telegram-read-messages" },
    ])
      assert.equal((await client.callTool(request)).isError, true);
    assert.equal(calls.length, count);
  } finally {
    await client.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
