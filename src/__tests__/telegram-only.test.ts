import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerHostedTools } from "../http/tool-catalog.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import { createSaasStore } from "../saas/store.js";
import { ToolPolicy } from "../tool-policy.js";
import { dashboard } from "./helpers/dashboard.js";

test("v5 upgrade removes retired integration data while preserving Telegram and cabinet records", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-only-"));
  const path = join(root, "saas.sqlite");
  const tables = [
    "users",
    "recovery",
    "browser_sessions",
    "telegram_sessions",
    "telegram_connections",
    "telegram_identities",
    "grant_bindings",
  ];
  try {
    const store = createSaasStore(path);
    const owner = store.register("alice", "password-hash", ["recovery-hash"]);
    const added = store.createTelegramConnection(owner.id, "Work");
    for (const id of [owner.id, added.id]) store.putEncryptedSession(id, `encrypted-${id}`);
    store.putTelegramAccount(owner.id, { id: "123", username: "alice" });
    store.putTelegramAccount(added.id, { id: "456" });
    store.putBrowserSession("session-hash", owner.id, "csrf-hash", Date.now() + 60000);
    store.bindGrant(owner.id, "grant", "client", 1);
    store.close();
    const legacy = new DatabaseSync(path);
    legacy.exec(`DROP TABLE IF EXISTS instagram_send_requests;
      DROP TABLE IF EXISTS instagram_connections;
      CREATE TABLE instagram_connections (
      id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), label TEXT, generation TEXT,
      policy TEXT, envelope TEXT);
      CREATE TABLE instagram_send_requests (
        connection_id TEXT REFERENCES instagram_connections(id), request_id TEXT);
      PRAGMA user_version=5;`);
    legacy
      .prepare("INSERT INTO instagram_connections(id,owner_id,label,generation,policy,envelope) VALUES(?,?,?,?,?,?)")
      .run("retired", owner.id, "Personal", "old-generation", "{}", "old-encrypted-session");
    legacy.exec("INSERT INTO instagram_send_requests(connection_id,request_id) VALUES('retired','old-request')");
    const before = tables.map((table) => legacy.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all());
    legacy.close();
    const upgraded = createSaasStore(path);
    assert.equal(upgraded.getEncryptedSession(owner.id), `encrypted-${owner.id}`);
    assert.equal(upgraded.getEncryptedSession(added.id), `encrypted-${added.id}`);
    assert.equal(upgraded.findGrant("grant")?.clientId, "client");
    upgraded.close();
    const db = new DatabaseSync(path);
    try {
      assert.deepEqual(
        tables.map((table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()),
        before,
      );
      assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'instagram_%'").all(), []);
      assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 6);
      assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(db.prepare("PRAGMA quick_check").get()?.quick_check, "ok");
    } finally {
      db.close();
    }
    const reopened = createSaasStore(path);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retired dashboard hash and stale API fields cannot expose a non-Telegram connection flow", async () => {
  const d = await dashboard(
    () =>
      new Response(
        JSON.stringify({
          user: { id: "owner", login: "alice", hasPassword: true },
          csrfToken: "token",
          policy: { profile: "read", chatIds: [], version: 1 },
          telegram: { state: "stopped", busy: false, sessionPresent: false },
          mcpUrl: "https://mcp.test/mcp",
          instagram: { enabled: true, accounts: [] },
        }),
      ),
    { hash: "#instagram" },
  );
  assert.match(d.html(), /Подключить Telegram/);
  assert.doesNotMatch(d.html(), /Instagram|instagram|ig-select|ig-remove/);
});

test("hosted catalog remains Telegram-only even when a stale caller passes the retired feature argument", async () => {
  const server = new McpServer({ name: "telegram-only", version: "test" });
  try {
    Reflect.apply(registerHostedTools, undefined, [server, new ToolPolicy({ profile: "full" }), true, true, true]);
    const names = Object.keys((server as unknown as McpServerInternal)._registeredTools);
    assert.ok(names.includes("telegram-list-accounts"));
    assert.ok(names.includes("telegram-read-messages"));
    assert.ok(names.includes("telegram-create-media-upload"));
    assert.ok(names.every((name) => name.startsWith("telegram-")));
  } finally {
    await server.close();
  }
});
