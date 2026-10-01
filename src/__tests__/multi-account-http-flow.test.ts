import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { DirectMediaUploads } from "../http/direct-media-upload.js";
import { createMcpHandler } from "../http/mcp-handler.js";
import { SaasAuth } from "../saas/auth.js";
import { createSaasIdentity } from "../saas/identity.js";
import { createSaasStore } from "../saas/store.js";

test("hosted MCP keeps the selected sender through binary upload and send, and rejects foreign or read-only accounts", async () => {
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
  const owner = (await auth.register("alice", "a private test password long enough")).userId;
  const work = store.createTelegramConnection(owner, "Work");
  const other = (await auth.register("bobby", "a private test password long enough")).userId;
  for (const [id, peer] of [
    [owner, "123"],
    [work.id, "456"],
    [other, "789"],
  ])
    store.putVerifiedTelegramSession(id, `encrypted-${id}`, { id: peer });
  store.bindGrant(owner, "grant", "ai", 1);
  const calls: { id: string; name: string; args: Record<string, unknown> }[] = [];
  const bytes = Buffer.from([255, 0, 128, 23]);
  const identity = createSaasIdentity(store, auth, {
    call: async (id, name, args) => {
      calls.push({ id, name, args });
      if (name === "telegram-upload-media")
        return {
          structuredContent: {
            fileId: "media_11111111-1111-4111-8111-111111111111",
            fileName: "a.jpg",
            ready: true,
            receivedBytes: bytes.length,
            expiresAt: Date.now() + 1000,
          },
        };
      return { content: [{ type: "text", text: `sent from ${id}` }] };
    },
  });
  const uploads = new DirectMediaUploads({ origin: "https://mcp.test", identity });
  const app = express();
  uploads.mount(app);
  app.post(
    "/mcp",
    express.json(),
    (_req, res, next) => {
      res.locals.mcpIdentity = { accountId: owner, grantId: "grant" };
      next();
    },
    createMcpHandler(identity, "test", uploads),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (name: string, args: Record<string, unknown>) =>
    (
      await (
        await fetch(`${base}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
        })
      ).json()
    ).result;
  try {
    const listed = await call("telegram-list-accounts", {});
    assert.deepEqual(
      listed.structuredContent.accounts.map((a: { id: string }) => a.id),
      [owner, work.id],
    );
    const ticketResponse = await call("telegram-create-media-upload", {
      telegramAccountId: work.id,
      fileName: "a.jpg",
      sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    assert.equal(ticketResponse.isError, undefined);
    const ticket = ticketResponse.structuredContent;
    const upload = await fetch(base + new URL(ticket.uploadUrl).pathname, {
      method: "PUT",
      headers: ticket.headers,
      body: bytes,
    });
    assert.equal(upload.status, 200);
    const handle = await upload.json();
    assert.equal(calls[0].id, work.id);
    assert.deepEqual(Buffer.from(calls[0].args.data as string, "base64"), bytes);
    await call("telegram-send-file", { telegramAccountId: work.id, chatId: "me", fileId: handle.fileId });
    assert.equal(calls.at(-1)?.id, work.id);
    assert.equal(calls.at(-1)?.args.telegramAccountId, undefined);
    assert.equal(
      (await call("telegram-send-message", { telegramAccountId: other, chatId: "me", text: "deny" })).isError,
      true,
    );
    store.updatePolicy(owner, { profile: "read", chatIds: [], version: 0 });
    store.bindGrant(owner, "grant", "ai", 2);
    assert.equal(
      (
        await call("telegram-create-media-upload", {
          fileName: "a.jpg",
          sizeBytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        })
      ).isError,
      true,
    );
    store.updatePolicy(work.id, { profile: "read", chatIds: [], version: 0 });
    assert.equal((await fetch(base + new URL(ticket.uploadUrl).pathname, { headers: ticket.headers })).status, 403);
    assert.equal(
      (await call("telegram-send-message", { telegramAccountId: work.id, chatId: "me", text: "deny" })).isError,
      true,
    );
    assert.equal(calls.length, 2);
  } finally {
    uploads.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
