import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSaasStore } from "../saas/store.js";

// Removing the transaction/capacity check would admit a 101st account across two connections.
test("registration capacity is atomic across connections and survives reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saas-store-"));
  const path = join(dir, "users.sqlite");
  const a = createSaasStore(path);
  const b = createSaasStore(path);
  try {
    for (let n = 0; n < 100; n++) (n % 2 ? a : b).register(`user_${n}`, "test-hash", ["recovery-hash"]);
    assert.throws(() => b.register("user_100", "test-hash", []), /capacity/i);
    const user = a.findByLogin("user_0");
    assert.ok(user);
    assert.deepEqual(user.policy, { profile: "full", chatIds: [], version: 1 });
    assert.equal(b.findUser(user.id)?.login, "user_0");
    const reopened = createSaasStore(path);
    try {
      assert.equal(reopened.findUser(user.id)?.login, "user_0");
    } finally {
      reopened.close();
    }
    assert.throws(() => a.register("USER_0", "test-hash", []), /login/i);
  } finally {
    a.close();
    b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// Omitting the consumed-code delete or access invalidation enables repeated password resets.
test("recovery code is single use and revokes browser sessions and grants atomically", async () => {
  const store = createSaasStore(":memory:");
  try {
    const user = store.register("alice", "old-hash", ["code-one", "code-two"]);
    store.putBrowserSession("session-hash", user.id, "csrf-hash", Date.now() + 60000);
    store.bindGrant(user.id, "grant-a", "client-a", 1);
    assert.equal(store.consumeRecovery("alice", "code-one", "new-hash"), true);
    assert.equal(store.consumeRecovery("alice", "code-one", "other-hash"), false);
    assert.equal(store.consumeRecovery("alice", "code-two", "other-hash"), false);
    assert.equal(store.findByLogin("alice")?.passwordHash, "new-hash");
    assert.equal(store.findBrowserSession("session-hash"), undefined);
    assert.equal(store.findGrant("grant-a"), undefined);
  } finally {
    store.close();
  }
});

test("session expiry and disabled users deny access without affecting another user", () => {
  const store = createSaasStore(":memory:");
  try {
    const a = store.register("alice", "hash", []);
    const b = store.register("bobby", "hash", []);
    store.putBrowserSession("expired", a.id, "csrf", Date.now() - 1);
    store.putBrowserSession("live-a", a.id, "csrf", Date.now() + 60000);
    store.putBrowserSession("live-b", b.id, "csrf", Date.now() + 60000);
    store.putEncryptedSession(a.id, "cipher-a");
    store.putEncryptedSession(b.id, "cipher-b");
    store.bindGrant(a.id, "grant-a", "client-a", 1);
    assert.equal(store.findBrowserSession("expired"), undefined);
    assert.equal(store.updatePolicy(a.id, { profile: "full", chatIds: ["-100123"], version: 999 }), 2);
    assert.equal(store.findGrant("grant-a"), undefined);
    assert.equal(store.findUser(a.id)?.policy.version, 2);
    store.disableUser(a.id);
    assert.equal(store.findBrowserSession("live-a"), undefined);
    assert.throws(() => store.putEncryptedSession(a.id, "late-worker-data"), /inactive/i);
    assert.equal(store.findBrowserSession("live-b")?.userId, b.id);
    store.deleteEncryptedSession(a.id);
    assert.equal(store.getEncryptedSession(b.id), "cipher-b");
  } finally {
    store.close();
  }
});

test("disabled accounts still occupy capacity until their records are purged", () => {
  const store = createSaasStore(":memory:", { maxUsers: 1 });
  try {
    const user = store.register("alice", "hash", []);
    store.disableUser(user.id);
    assert.throws(() => store.register("bobby", "hash", []), /capacity/i);
  } finally {
    store.close();
  }
});

test("saved Telegram identity persists per user and clears when the device session changes", () => {
  const store = createSaasStore(":memory:");
  try {
    const a = store.register("alice", "hash", []),
      b = store.register("bob", "hash", []);
    assert.throws(() => store.putTelegramAccount(a.id, { id: "111", username: "alice" }));
    store.putEncryptedSession(a.id, "encrypted-A");
    store.putTelegramAccount(a.id, { id: "111", username: "alice" });
    assert.deepEqual(store.getTelegramAccount(a.id), { id: "111", username: "alice" });
    assert.equal(store.getTelegramAccount(b.id), undefined);
    store.putEncryptedSession(a.id, "new-device");
    assert.equal(store.getTelegramAccount(a.id), undefined);
    store.putTelegramAccount(a.id, { id: "222" });
    store.deleteEncryptedSession(a.id);
    assert.equal(store.getTelegramAccount(a.id), undefined);
  } finally {
    store.close();
  }
});

test("identity metadata migrates a v1 database and survives reopening with its encrypted session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saas-identity-"));
  const path = join(dir, "saas.sqlite");
  try {
    const initial = createSaasStore(path);
    const user = initial.register("alice", "hash", []);
    initial.putEncryptedSession(user.id, "unchanged-envelope");
    initial.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("ALTER TABLE telegram_sessions DROP COLUMN account_json; PRAGMA user_version=1;");
    legacy.close();
    const migrated = createSaasStore(path);
    assert.equal(migrated.getEncryptedSession(user.id), "unchanged-envelope");
    assert.equal(migrated.getTelegramAccount(user.id), undefined);
    migrated.putTelegramAccount(user.id, { id: "123", username: "alice" });
    migrated.close();
    const reopened = createSaasStore(path);
    try {
      assert.deepEqual(reopened.getTelegramAccount(user.id), { id: "123", username: "alice" });
      assert.equal(reopened.getEncryptedSession(user.id), "unchanged-envelope");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// New defaults must not widen saved restrictions or invalidate existing client grants.
test("full signup default preserves existing read restrictions and grants after reopening", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saas-default-policy-"));
  const path = join(dir, "users.sqlite");
  try {
    const initial = createSaasStore(path);
    const existing = initial.register("existing", "hash", []);
    initial.updatePolicy(existing.id, { profile: "read", chatIds: ["-100123"], version: 1 });
    initial.bindGrant(existing.id, "existing-grant", "existing-client", 2);
    initial.putEncryptedSession(existing.id, "unchanged-envelope");
    const saved = initial.findUser(existing.id);
    assert.ok(saved);
    const policy = saved.policy;
    const grant = initial.findGrant("existing-grant");
    initial.close();
    const reopened = createSaasStore(path);
    try {
      const newcomer = reopened.register("newcomer", "hash", []);
      assert.deepEqual(newcomer.policy, { profile: "full", chatIds: [], version: 1 });
      assert.deepEqual(reopened.findUser(existing.id)?.policy, policy);
      assert.deepEqual(reopened.findGrant("existing-grant"), grant);
      assert.equal(reopened.getEncryptedSession(existing.id), "unchanged-envelope");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schema v3 upgrade preserves primary grants and encrypted session, and added account ownership survives restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-account-migration-"));
  const path = join(dir, "saas.sqlite");
  try {
    const first = createSaasStore(path);
    const primary = first.register("alice", "private-hash", []);
    first.putVerifiedTelegramSession(primary.id, "primary-envelope", { id: "123" });
    first.bindGrant(primary.id, "grant", "client", 1);
    first.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE telegram_connections; PRAGMA user_version=3;");
    legacy.close();
    const migrated = createSaasStore(path);
    assert.equal(migrated.getEncryptedSession(primary.id), "primary-envelope");
    assert.equal(migrated.findGrant("grant")?.userId, primary.id);
    const work = migrated.createTelegramConnection(primary.id, "Работа");
    migrated.putVerifiedTelegramSession(work.id, "work-envelope", { id: "456" });
    migrated.updatePolicy(work.id, { profile: "read", chatIds: ["-100123"], version: 0 });
    migrated.close();
    const reopened = createSaasStore(path);
    try {
      assert.equal(reopened.ownsTelegramConnection(primary.id, work.id), true);
      assert.deepEqual(
        reopened.listTelegramConnections(primary.id).map((a) => a.label),
        ["Основной", "Работа"],
      );
      assert.equal(reopened.getEncryptedSession(work.id), "work-envelope");
      assert.equal(reopened.getEncryptedSession(primary.id), "primary-envelope");
      assert.deepEqual(reopened.findUser(work.id)?.policy.chatIds, ["-100123"]);
    } finally {
      reopened.close();
    }
    const checked = new DatabaseSync(path);
    assert.deepEqual(checked.prepare("PRAGMA foreign_key_check").all(), []);
    checked.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("cabinet deletion atomically queues all partitions for restart-safe cleanup", () => {
  const store = createSaasStore(":memory:");
  try {
    const owner = store.register("alice", "hash", []);
    const work = store.createTelegramConnection(owner.id, "Work");
    store.requestCabinetDeletion(owner.id);
    assert.equal(store.findUser(owner.id)?.disabled, true);
    assert.equal(store.findUser(work.id)?.disabled, true);
    assert.deepEqual(new Set(store.pendingDeletions()), new Set([owner.id, work.id]));
    store.deleteUser(work.id);
    assert.deepEqual(store.pendingDeletions(), [owner.id]);
    store.deleteUser(owner.id);
    assert.deepEqual(store.pendingDeletions(), []);
  } finally {
    store.close();
  }
});
