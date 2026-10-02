import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHostedTools } from "../http/tool-catalog.js";
import type { InstagramSupervisor } from "../instagram/supervisor.js";
import { SaasAuth } from "../saas/auth.js";
import { createSaasIdentity } from "../saas/identity.js";
import { createSaasStore } from "../saas/store.js";

test("hosted Instagram catalog and dispatch use explicit isolated accounts and current access", async () => {
  const store = createSaasStore(":memory:");
  try {
    const owner = store.register("alice", "hash", []),
      other = store.register("bobby", "hash", []),
      c = store.instagram.create(owner.id, "Personal"),
      foreign = store.instagram.create(other.id, "Other");
    store.instagram.save(owner.id, c.id, c.generation, "cipher", { id: "123" });
    const calls: unknown[] = [];
    const ig = {
      call: async (...a: unknown[]) => {
        calls.push(a);
        return { messages: [] };
      },
      status: () => ({ state: "ready", sessionPresent: true }),
    } as unknown as InstagramSupervisor;
    const identity = createSaasIdentity(
      store,
      new SaasAuth(store, { csrfKey: randomBytes(32) }),
      {
        call: async () => {
          throw new Error("Wrong protocol");
        },
      },
      { supervisor: ig },
    );
    const server = new McpServer({ name: "test", version: "1" });
    registerHostedTools(server, identity.toolPolicy(owner.id), false, true, true);
    const catalog = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    assert.ok(catalog["instagram-list-accounts"]);
    assert.ok(catalog["instagram-read-messages"]);
    assert.equal(catalog["instagram-send-message"], undefined);
    await identity.callTool(owner.id, "instagram-read-messages", { instagramAccountId: c.id, threadId: "12" });
    assert.equal(calls.length, 1);
    await assert.rejects(identity.callTool(owner.id, "instagram-read-messages", { threadId: "12" }));
    await assert.rejects(
      identity.callTool(owner.id, "instagram-read-messages", { instagramAccountId: foreign.id, threadId: "12" }),
    );
    await assert.rejects(
      identity.callTool(owner.id, "instagram-read-messages", {
        instagramAccountId: c.id,
        telegramAccountId: owner.id,
        threadId: "12",
      }),
    );
    await assert.rejects(
      identity.callTool(owner.id, "instagram-send-message", {
        instagramAccountId: c.id,
        threadId: "12",
        text: "hello",
        requestId: randomUUID(),
      }),
    );
    store.instagram.setPolicy(owner.id, c.id, { profile: "full", threadIds: ["13"] });
    await assert.rejects(
      identity.callTool(owner.id, "instagram-read-messages", { instagramAccountId: c.id, threadId: "12" }),
    );
    assert.equal(calls.length, 1);
    await server.close();
  } finally {
    store.close();
  }
});
test("status remains visible for an unconnected Instagram slot", async () => {
  const store = createSaasStore(":memory:");
  try {
    const owner = store.register("alice", "hash", []);
    store.instagram.create(owner.id, "Personal");
    const identity = createSaasIdentity(
      store,
      new SaasAuth(store, { csrfKey: randomBytes(32) }),
      { call: async () => ({}) },
      { supervisor: {} as InstagramSupervisor },
    );
    assert.equal(
      identity.toolPolicy(owner.id).visible("instagram-status", { annotations: { readOnlyHint: true } }),
      true,
    );
  } finally {
    store.close();
  }
});
test("new Instagram access invalidates existing grants and stale consent", () => {
  const store = createSaasStore(":memory:");
  try {
    const owner = store.register("alice", "hash", []),
      auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
    const identity = createSaasIdentity(
      store,
      auth,
      { call: async () => ({}) },
      { supervisor: {} as InstagramSupervisor },
    );
    const old = identity.consentBinding!(owner.id);
    identity.bindGrant(owner.id, "grant", "client", old);
    const c = store.instagram.create(owner.id, "Personal");
    assert.equal(identity.isGrantValid(owner.id, "grant"), false);
    assert.throws(() => identity.bindGrant(owner.id, "stale", "client", old), /consent/i);
    store.instagram.rename(owner.id, c.id, "New name");
    assert.notEqual(identity.consentBinding!(owner.id), old);
  } finally {
    store.close();
  }
});
