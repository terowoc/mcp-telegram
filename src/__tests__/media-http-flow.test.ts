import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import express from "express";
import type { GatewayIdentity } from "../http/identity.js";
import { createMcpHandler } from "../http/mcp-handler.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import { MEDIA_CHUNK_BYTES } from "../media-upload.js";
import { TelegramService } from "../telegram-client.js";
import { ToolExecutor } from "../tool-executor.js";
import { ToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";

test("hosted HTTP catalog uploads a file larger than one request and delivers its exact bytes to GramJS", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-http-media-"));
  const previousRoot = process.env.MCP_TELEGRAM_FILE_ROOT;
  process.env.MCP_TELEGRAM_FILE_ROOT = root;
  const bytes = Buffer.alloc(MEDIA_CHUNK_BYTES * 2 + 31, 17);
  const sent: Array<Record<string, unknown>> = [];
  const service = new TelegramService(1, "test", { sessionPath: join(root, "unused-session") });
  Object.assign(service, {
    connected: true,
    sessionString: "test",
    ensureConnected: async () => true,
    resolvePeer: async () => ({ peer: "42" }),
    client: {
      sendFile: async (_peer: unknown, options: Record<string, unknown>) => {
        sent.push(options);
        return { id: 123 };
      },
    },
  });
  const registry = new McpServer({ name: "http-worker", version: "1" });
  registerTools(registry, service);
  const executor = new ToolExecutor({ tools: (registry as unknown as McpServerInternal)._registeredTools });
  const identity = {
    isActive: (id: string) => id === "account",
    isGrantValid: (_id: string, grant: string) => grant === "grant",
    toolPolicy: () => new ToolPolicy({ profile: "full" }),
    callTool: (_id: string, name: string, args: Record<string, unknown>, options: { signal?: AbortSignal }) =>
      executor.call(name, args, options),
  } as GatewayIdentity;
  const app = express();
  app.use(express.json({ limit: "1mb" }));
  app.post(
    "/mcp",
    (_req, res, next) => {
      res.locals.mcpIdentity = { accountId: "account", grantId: "grant" };
      next();
    },
    createMcpHandler(identity, "test"),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  let id = 0;
  async function request(method: string, params?: unknown) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params });
    assert.ok(Buffer.byteLength(body) < 1048576);
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body,
    });
    assert.equal(response.status, 200);
    const message = await response.json();
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    assert.notEqual(message.result?.isError, true, JSON.stringify(message.result));
    return message.result;
  }
  try {
    const catalog = await request("tools/list");
    const sendSchema = catalog.tools.find((tool: { name: string }) => tool.name === "telegram-send-file").inputSchema;
    assert.ok(sendSchema.properties.fileId);
    assert.ok(sendSchema.properties.fileUrl);
    assert.ok(!sendSchema.required.includes("filePath"));
    let fileId: string | undefined;
    for (let offset = 0; offset < bytes.length; offset += MEDIA_CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, offset + MEDIA_CHUNK_BYTES);
      const result = await request("tools/call", {
        name: "telegram-upload-media",
        arguments: {
          fileId,
          fileName: fileId ? undefined : "generated-video.mp4",
          offset,
          data: chunk.toString("base64"),
          final: offset + chunk.length === bytes.length,
        },
      });
      fileId = result.structuredContent.fileId;
      assert.equal(result.structuredContent.receivedBytes, offset + chunk.length);
      assert.equal(result.structuredContent.ready, offset + chunk.length === bytes.length);
    }
    assert.equal(sent.length, 0);
    await request("tools/call", {
      name: "telegram-send-file",
      arguments: { chatId: "42", fileId, mediaType: "document", caption: "AI video", topicId: 7 },
    });
    assert.equal(sent.length, 1);
    assert.deepEqual(await readFile(sent[0].file as string), bytes);
    assert.equal((sent[0].file as string).endsWith("/generated-video.mp4"), true);
    assert.equal(sent[0].forceDocument, true);
    assert.equal(sent[0].replyTo, 7);
    await request("tools/call", { name: "telegram-send-file", arguments: { chatId: "42", fileId, mediaType: "auto" } });
    assert.equal(sent[1].forceDocument, false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await registry.close();
    if (previousRoot === undefined) delete process.env.MCP_TELEGRAM_FILE_ROOT;
    else process.env.MCP_TELEGRAM_FILE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
