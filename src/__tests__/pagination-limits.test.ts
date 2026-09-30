import assert from "node:assert/strict";
import { it } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import type { TelegramService } from "../telegram-client.js";
import { registerTools } from "../tools/index.js";

it("all numeric read limits reject negative, fractional and excessive pagination", () => {
  const server = new McpServer({ name: "limits", version: "test" });
  registerTools(server, {} as TelegramService);
  const registry = (server as unknown as { _registeredTools: Record<string, { inputSchema?: z.ZodObject }> })
    ._registeredTools;
  let checked = 0;
  for (const [name, tool] of Object.entries(registry)) {
    const limit = tool.inputSchema?.shape.limit;
    if (!limit) continue;
    checked++;
    for (const value of [-1, 1.5, 1000000]) {
      assert.equal(limit.safeParse(value).success, false, `${name} accepted limit ${value}`);
    }
  }
  assert.ok(checked >= 20);
});
