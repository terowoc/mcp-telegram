import assert from "node:assert/strict";
import { connect, createServer, type Socket } from "node:net";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { IpcDecoder, type IpcToolResponse, type McpServerInternal } from "../ipc-protocol.js";
import { handleClient } from "../master.js";
import type { TelegramService } from "../telegram-client.js";
import { cleanupIpcEndpoint, makeIpcEndpoint } from "./ipc-endpoint.helper.js";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, mcp: McpServerInternal) {
  const endpoint = makeIpcEndpoint("mcp-deadline-test");
  const server = createServer((socket) => handleClient(socket, mcp, {} as TelegramService, { toolCallTimeoutMs: 150 }));
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const sockets: Socket[] = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanupIpcEndpoint(endpoint);
  });
  const client = connect(endpoint);
  sockets.push(client);
  await new Promise<void>((resolve) => client.once("connect", resolve));
  const responses: IpcToolResponse[] = [];
  const decoder = new IpcDecoder();
  client.on("data", (data) => {
    for (const message of decoder.push(data)) if (message.type === "tool_response") responses.push(message);
  });
  const send = (data: unknown) => client.write(`${JSON.stringify(data)}\n`);
  const response = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      const found = responses.find((r) => r.id === id);
      if (found) return found;
      await delay(5);
    }
    throw new Error(`Missing response: ${id}`);
  };
  return { send, response };
}

it("IPC includes time spent in the socket queue in request deadlines", async (t) => {
  let writes = 0;
  const { send, response } = await fixture(t, {
    _registeredTools: {
      slow: {
        handler: async () => {
          await delay(70);
          return {};
        },
      },
      write: {
        handler: async () => {
          writes++;
          return {};
        },
      },
    },
  });
  send({ type: "tool", id: "slow", tool: "slow", args: {} });
  send({ type: "tool", id: "write", tool: "write", args: {}, deadlineAt: Date.now() + 20 });
  const result = await response("write");
  assert.match(result.error ?? "", /deadline|timed out/i);
  assert.equal(writes, 0);
});

it("IPC cancellation removes a queued write before execution", async (t) => {
  let writes = 0;
  const { send, response } = await fixture(t, {
    _registeredTools: {
      slow: {
        handler: async () => {
          await delay(70);
          return {};
        },
      },
      write: {
        handler: async () => {
          writes++;
          return {};
        },
      },
    },
  });
  send({ type: "tool", id: "slow", tool: "slow", args: {} });
  send({ type: "tool", id: "write", tool: "write", args: {} });
  send({ type: "cancel", id: "write" });
  const result = await response("write");
  assert.match(result.error ?? "", /cancel/i);
  assert.equal(writes, 0);
});

it("raw IPC validates tool arguments instead of bypassing MCP schemas", async (t) => {
  let calls = 0;
  const { send, response } = await fixture(t, {
    _registeredTools: {
      read: {
        inputSchema: z.object({ limit: z.number().int().min(1).max(100) }),
        handler: async () => {
          calls++;
          return {};
        },
      },
    },
  } as McpServerInternal);
  send({ type: "tool", id: "read", tool: "read", args: { limit: -1 } });
  const result = await response("read");
  assert.match(result.error ?? "", /invalid.*argument/i);
  assert.equal(calls, 0);
});
