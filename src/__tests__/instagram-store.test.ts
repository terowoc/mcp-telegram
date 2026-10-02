import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { InstagramPolicy } from "../instagram/policy.js";
import { InstagramVault } from "../instagram/vault.js";
import { createSaasStore } from "../saas/store.js";

test("Instagram slots enforce owners, capacity, defaults and verified identity", () => {
  const s = createSaasStore(":memory:");
  try {
    const a = s.register("alice", "hash", []),
      b = s.register("bobby", "hash", []);
    const c = s.instagram.create(a.id, "Personal");
    assert.equal(c.policy.profile, "read");
    assert.equal(s.instagram.get(b.id, c.id), undefined);
    assert.throws(() => s.instagram.create(c.id, "not an owner"));
    s.bindGrant(a.id, "grant", "client", a.policy.version);
    s.instagram.save(a.id, c.id, c.generation, "ciphertext", { id: "123", username: "alice" });
    assert.equal(s.findGrant("grant"), undefined);
    const d = s.instagram.create(a.id, "Other");
    assert.throws(() => s.instagram.save(a.id, d.id, d.generation, "bad", { id: "123" }), /already/);
    s.instagram.disconnect(a.id, c.id);
    assert.equal(s.instagram.save(a.id, c.id, c.generation, "late", { id: "123" }), false);
    const current = s.instagram.get(a.id, c.id)!;
    assert.throws(() => s.instagram.save(a.id, c.id, current.generation, "bad", { id: "456" }), /identity/);
    for (let i = 0; i < 3; i++) s.instagram.create(a.id, `Slot ${i}`);
    assert.throws(() => s.instagram.create(a.id, "Sixth"), /capacity/);
    assert.equal(s.instagram.list(b.id).length, 0);
  } finally {
    s.close();
  }
});

test("Instagram send keys survive uncertainty and reject changed payloads", () => {
  const s = createSaasStore(":memory:");
  try {
    const owner = s.register("alice", "hash", []);
    const c = s.instagram.create(owner.id, "Personal"),
      id = randomUUID();
    assert.equal(s.instagram.beginSend(c.id, c.generation, id, "digest").state, "new");
    assert.equal(s.instagram.beginSend(c.id, c.generation, id, "digest").state, "pending");
    assert.throws(() => s.instagram.beginSend(c.id, c.generation, id, "changed"), /conflict/);
    s.instagram.recoverSends();
    assert.equal(s.instagram.beginSend(c.id, c.generation, id, "digest").state, "unknown");
    const second = randomUUID();
    s.instagram.beginSend(c.id, c.generation, second, "other");
    s.instagram.finishSend(c.id, c.generation, second, { id: "1000000000000000000000000001", timestamp: "123" });
    assert.equal(s.instagram.beginSend(c.id, c.generation, second, "other").state, "confirmed");
    s.instagram.finishSend(c.id, c.generation, id, { id: "late", timestamp: "123" });
    assert.equal(s.instagram.beginSend(c.id, c.generation, id, "digest").state, "unknown");
  } finally {
    s.close();
  }
});

test("Instagram session envelopes are connection-bound and sanitized", () => {
  const v = new InstagramVault(randomBytes(32));
  const state = {
    uuids: { uuid: "device" },
    authorization_data: { ds_user_id: "123", sessionid: "secret" },
    cookies: { sessionid: "secret" },
  };
  const e = v.encrypt("owner", "one", state);
  assert.deepEqual(v.decrypt("owner", "one", e), state);
  assert.throws(() => v.decrypt("owner", "two", e));
  assert.throws(() => v.encrypt("owner", "one", { ...state, password: "oops" }));
  assert.throws(() => v.encrypt("owner", "one", { ...state, cookies: { huge: "x".repeat(65536) } }));
});

test("Instagram policy validates large IDs separately and blocks disallowed sends", () => {
  const p = new InstagramPolicy({ profile: "read", threadIds: ["123456789012345678901234567890"] });
  assert.throws(() => p.authorize("instagram-send-message", { threadId: "123456789012345678901234567890" }));
  assert.throws(() => p.authorize("instagram-read-messages", { threadId: "different" }));
  assert.doesNotThrow(() => p.authorize("instagram-read-messages", { threadId: "123456789012345678901234567890" }));
  assert.equal(p.visible("instagram-send-message"), false);
});
test("schema four migrates and restarts without changing existing Telegram access", async () => {
  const root = await mkdtemp(join(tmpdir(), "ig-migrate-")),
    path = join(root, "auth.sqlite");
  try {
    let s = createSaasStore(path);
    const owner = s.register("alice", "hash", []);
    s.putVerifiedTelegramSession(owner.id, "existing-telegram-session", { id: "123" });
    s.bindGrant(owner.id, "legacy", "client", owner.policy.version);
    s.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE instagram_send_requests; DROP TABLE instagram_connections; PRAGMA user_version=4;");
    legacy.close();
    s = createSaasStore(path);
    assert.equal(s.getEncryptedSession(owner.id), "existing-telegram-session");
    assert.equal(s.findGrant("legacy")?.userId, owner.id);
    const c = s.instagram.create(owner.id, "Personal");
    s.close();
    s = createSaasStore(path);
    assert.equal(s.instagram.get(owner.id, c.id)?.label, "Personal");
    s.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("unexpired send protection is not evicted when the 2000-record capacity fills", () => {
  const s = createSaasStore(":memory:");
  try {
    const owner = s.register("alice", "hash", []),
      c = s.instagram.create(owner.id, "Personal"),
      first = randomUUID();
    s.instagram.beginSend(c.id, c.generation, first, "payload");
    for (let i = 0; i < 1999; i++) s.instagram.beginSend(c.id, c.generation, randomUUID(), "payload");
    assert.throws(() => s.instagram.beginSend(c.id, c.generation, randomUUID(), "payload"), /capacity/);
    assert.equal(s.instagram.beginSend(c.id, c.generation, first, "payload").state, "pending");
  } finally {
    s.close();
  }
});
