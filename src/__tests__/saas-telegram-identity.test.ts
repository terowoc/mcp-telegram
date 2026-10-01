import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { hashOpaqueToken, SaasAuth } from "../saas/auth.js";
import { createSaasIdentity } from "../saas/identity.js";
import { SessionVault } from "../saas/session-vault.js";
import { createSaasStore } from "../saas/store.js";

const proof = (id = "12345") => ({
  attemptId: "server-attempt",
  account: { id, username: "alice" },
  session: "synthetic-session",
  authenticatedAt: Date.now(),
});
const setup = (maxUsers = 100) => {
  const store = createSaasStore(":memory:", { maxUsers });
  const auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
  const vault = new SessionVault(randomBytes(32));
  return { store, auth, vault };
};

test("passwordless_login_requires_verified_proof", async () => {
  const { store, auth, vault } = setup();
  try {
    assert.throws(() => auth.completeTelegramLogin({ ...proof(), account: { id: "bad" } }, { vault }));
    const a = auth.completeTelegramLogin(proof(), { vault });
    const user = store.findUser(a.userId)!;
    assert.equal(user.passwordHash, undefined);
    assert.deepEqual(user.policy, { profile: "read", chatIds: [], version: 1 });
    assert.equal(auth.authenticate(a.sessionToken)?.userId, user.id);
    assert.ok(auth.authenticate(a.sessionToken)?.authenticatedAt);
    assert.equal(await auth.login(user.login, "arbitrary long private password"), undefined);
    assert.equal(vault.decrypt(user.id, store.getEncryptedSession(user.id)!), "synthetic-session");
    assert.equal(store.findByTelegramId("12345")?.id, user.id);
  } finally {
    store.close();
  }
});

test("same_telegram_id_cannot_claim_two_users", () => {
  const { store, auth, vault } = setup(1);
  try {
    const first = auth.completeTelegramLogin(proof(), { vault });
    const second = auth.completeTelegramLogin({ ...proof(), account: { id: "12345", username: "changed" } }, { vault });
    assert.equal(first.userId, second.userId);
    assert.throws(() => auth.completeTelegramLogin(proof("54321"), { vault }), /capacity/i);
    const legacy = store.findUser(first.userId)!;
    assert.throws(() => store.putTelegramAccount(legacy.id, { id: "98765" }), /identity/i);
  } finally {
    store.close();
  }
});

test("duplicate_legacy_matches_require_explicit_owner", async () => {
  const { store, auth, vault } = setup();
  try {
    const a = await auth.register("alice", "a long private legacy password");
    const b = await auth.register("bobby", "another long private legacy password");
    for (const u of [a, b]) {
      store.putEncryptedSession(u.userId, vault.encrypt(u.userId, "old-session"));
      store.putTelegramAccount(u.userId, { id: "12345" });
    }
    assert.throws(() => auth.completeTelegramLogin(proof(), { vault }), /legacy-link-required/);
    const linked = auth.completeTelegramLogin(proof(), { vault, legacyUserId: a.userId });
    assert.equal(linked.userId, a.userId);
    assert.throws(() => auth.completeTelegramLogin(proof(), { vault, legacyUserId: b.userId }), /identity/i);
    assert.equal(store.findByTelegramId("12345")?.id, a.userId);
  } finally {
    store.close();
  }
});

test("existing_identity_login_preserves_policy_and_mcp_session", () => {
  const { store, auth, vault } = setup();
  try {
    const a = auth.completeTelegramLogin(proof(), { vault });
    store.updatePolicy(a.userId, { profile: "full", chatIds: ["-100123"], version: 1 });
    store.bindGrant(a.userId, "grant", "client", 2);
    const old = store.getEncryptedSession(a.userId);
    const b = auth.completeTelegramLogin({ ...proof(), session: "different-candidate" }, { vault });
    assert.equal(b.userId, a.userId);
    assert.equal(store.getEncryptedSession(a.userId), old);
    assert.equal(store.findGrant("grant")?.userId, a.userId);
    assert.deepEqual(store.findUser(a.userId)?.policy, { profile: "full", chatIds: ["-100123"], version: 2 });
  } finally {
    store.close();
  }
});

test("commit_failure_leaves_no_partial_identity_or_browser_session", () => {
  const { store } = setup();
  try {
    const plan = store.planTelegramLogin({ id: "12345" });
    assert.throws(() =>
      store.commitTelegramLogin(plan, {
        account: { id: "12345" },
        browserSession: { idHash: "new", csrfHash: "csrf", expiresAt: Date.now() + 10000, authenticatedAt: Date.now() },
      }),
    );
    assert.equal(store.findByTelegramId("12345"), undefined);
    assert.equal(store.findUser(plan.userId), undefined);
    assert.equal(store.findBrowserSession("new"), undefined);
    const stale = store.planTelegramLogin({ id: "12345" });
    store.commitTelegramLogin(plan, {
      account: { id: "12345" },
      envelope: "encrypted",
      browserSession: { idHash: "first", csrfHash: "csrf", expiresAt: Date.now() + 10000, authenticatedAt: Date.now() },
    });
    assert.throws(() =>
      store.commitTelegramLogin(stale, {
        account: { id: "12345" },
        envelope: "other",
        browserSession: {
          idHash: "second",
          csrfHash: "csrf",
          expiresAt: Date.now() + 10000,
          authenticatedAt: Date.now(),
        },
      }),
    );
    assert.equal(store.findBrowserSession("second"), undefined);
  } finally {
    store.close();
  }
});

test("link_rotates_credentials_and_revokes_old_access", async () => {
  const { store, auth, vault } = setup();
  try {
    const a = await auth.register("alice", "a long private legacy password");
    const identity = createSaasIdentity(store, auth, { call: async () => ({}) });
    const binding = identity.authenticationBinding!(a.userId);
    store.bindGrant(a.userId, "grant", "client", 1);
    assert.equal(await auth.verifyLegacyPassword(a.userId, "a long private legacy password"), true);
    const linked = auth.completeTelegramLogin(proof(), { vault, legacyUserId: a.userId });
    assert.equal(linked.userId, a.userId);
    assert.equal(store.findBrowserSession(hashOpaqueToken(a.sessionToken)), undefined);
    assert.equal(store.findGrant("grant"), undefined);
    assert.notEqual(identity.authenticationBinding!(a.userId), binding);
    assert.equal(auth.authenticate(linked.sessionToken)?.userId, a.userId);
    store.deleteEncryptedSession(a.userId);
    assert.equal(store.findByTelegramId("12345")?.id, a.userId);
  } finally {
    store.close();
  }
});

test("schema_v2_migration_preserves_foreign_keys_and_legacy_access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-identity-"));
  const path = join(dir, "db");
  try {
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE users(id TEXT PRIMARY KEY,login TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,policy TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE browser_sessions(id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,csrf_hash TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE recovery(user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL,PRIMARY KEY(user_id,code_hash));
      CREATE TABLE telegram_sessions(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,envelope TEXT NOT NULL,account_json TEXT);
      CREATE TABLE grant_bindings(grant_id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,client_id TEXT NOT NULL,policy_version INTEGER NOT NULL);
      INSERT INTO users VALUES('legacy','alice','legacy-hash','{"profile":"read","chatIds":[],"version":1}',0);
      INSERT INTO recovery VALUES('legacy','code');
      INSERT INTO telegram_sessions VALUES('legacy','encrypted','{"id":"12345"}');
      INSERT INTO grant_bindings VALUES('grant','legacy','client',1);
      PRAGMA user_version=2;`);
    db.prepare("INSERT INTO browser_sessions VALUES('cookie','legacy','csrf',?)").run(Date.now() + 60000);
    db.close();
    const store = createSaasStore(path);
    assert.equal(store.findUser("legacy")?.passwordHash, "legacy-hash");
    assert.equal(store.findUser("legacy")?.credentialVersion, 0);
    assert.equal(store.findBrowserSession("cookie")?.authenticatedAt, 0);
    assert.equal(store.getEncryptedSession("legacy"), "encrypted");
    assert.equal(store.findGrant("grant")?.userId, "legacy");
    store.close();
    const reopened = new DatabaseSync(path);
    assert.deepEqual(reopened.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal((reopened.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
    assert.equal((reopened.prepare("SELECT count(*) AS n FROM recovery").get() as { n: number }).n, 1);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
