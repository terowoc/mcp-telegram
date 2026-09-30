import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SaasAuth } from "../saas/auth.js";
import { createSaasStore } from "../saas/store.js";

test("passwords and tokens are not plaintext and recovery revokes prior access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saas-auth-"));
  const path = join(dir, "auth.sqlite");
  const store = createSaasStore(path);
  const csrfKey = randomBytes(32);
  const auth = new SaasAuth(store, { csrfKey });
  const password = "private test password for alice";
  try {
    const registered = await auth.register("ALICE", password);
    assert.equal(registered.recoveryCodes.length, 8);
    assert.equal(store.findUser(registered.userId)?.login, "alice");
    assert.notEqual(store.findUser(registered.userId)?.passwordHash, password);
    const identity = auth.authenticate(registered.sessionToken);
    assert.equal(identity?.userId, registered.userId);
    assert.equal(identity?.csrfToken, registered.csrfToken);
    assert.equal(
      new SaasAuth(store, { csrfKey }).authenticate(registered.sessionToken)?.csrfToken,
      registered.csrfToken,
    );
    assert.equal(await auth.login("alice", "wrong password"), undefined);
    assert.equal(await auth.login("missing", password), undefined);
    const loggedIn = await auth.login("alice", password);
    assert.ok(loggedIn);
    assert.equal(loggedIn?.userId, registered.userId);
    const results = await Promise.all([
      auth.recover("alice", registered.recoveryCodes[0], "a new long password for alice"),
      auth.recover("alice", registered.recoveryCodes[0], "a second long password alice"),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(auth.authenticate(registered.sessionToken), undefined);
    assert.equal(auth.authenticate(loggedIn.sessionToken), undefined);
    assert.equal(await auth.login("alice", password), undefined);
    const bytes = Buffer.concat([await readFile(path), await readFile(`${path}-wal`)]).toString("utf8");
    for (const secret of [password, registered.sessionToken, registered.recoveryCodes[0], loggedIn.sessionToken])
      assert.equal(bytes.includes(secret), false);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("malformed registration and logout cannot leave usable sessions", async () => {
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
  try {
    await assert.rejects(auth.register("../bad", "a very long test password"), /login/i);
    await assert.rejects(auth.register("alice", "short"), /password/i);
    const registered = await auth.register("alice", "a very long test password");
    assert.equal(auth.authenticate("bad-token"), undefined);
    auth.logout(registered.sessionToken);
    assert.equal(auth.authenticate(registered.sessionToken), undefined);
  } finally {
    store.close();
  }
});
