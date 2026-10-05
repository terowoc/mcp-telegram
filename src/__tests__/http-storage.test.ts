import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { createAdapter } from "../http/storage.js";

describe("persistent OAuth adapter", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-oauth-storage-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves records across database connections and isolates model types", async () => {
    const path = join(dir, "persist.sqlite");
    const First = createAdapter(path);
    await new First("Client").upsert("one", { redirect_uris: ["https://client.example/callback"] }, 60);
    First.close();
    const Second = createAdapter(path);
    assert.deepEqual(await new Second("Client").find("one"), { redirect_uris: ["https://client.example/callback"] });
    assert.equal(await new Second("AccessToken").find("one"), undefined);
    if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
    Second.close();
  });

  it("expires records, consumes codes and revokes every record belonging to a grant", async () => {
    const Adapter = createAdapter(join(dir, "grant.sqlite"));
    const tokens = new Adapter("AccessToken");
    const codes = new Adapter("AuthorizationCode");
    await tokens.upsert("expired", { grantId: "g" }, -1);
    assert.equal(await tokens.find("expired"), undefined);
    await tokens.upsert("a", { grantId: "g", uid: "uid", userCode: "USER" }, 60);
    await codes.upsert("b", { grantId: "g" }, 60);
    await tokens.upsert("other", { grantId: "other" }, 60);
    assert.deepEqual(await tokens.findByUid("uid"), { grantId: "g", uid: "uid", userCode: "USER" });
    assert.ok(await tokens.findByUserCode("USER"));
    await codes.consume("b");
    assert.equal(typeof (await codes.find("b"))?.consumed, "number");
    await tokens.revokeByGrantId("g");
    assert.equal(await tokens.find("a"), undefined);
    assert.equal(await codes.find("b"), undefined);
    assert.ok(await tokens.find("other"));
    await tokens.destroy("other");
    assert.equal(await tokens.find("other"), undefined);
    Adapter.close();
  });

  it("prunes expired rows while idle and preserves unexpired clients and tokens", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 2000000000000 });
    const path = join(dir, "idle-expiry.sqlite");
    const Adapter = createAdapter(path);
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      await new Adapter("Client").upsert("client", { clientId: "client" });
      await new Adapter("Session").upsert("expired-session", {}, 1);
      await new Adapter("AccessToken").upsert("active", { grantId: "active-grant" }, 120);
      t.mock.timers.tick(60000);
      assert.equal(inspection.prepare("SELECT count(*) AS n FROM oauth").get()?.n, 2);
      assert.ok(await new Adapter("Client").find("client"));
      assert.ok(await new Adapter("AccessToken").find("active"));
    } finally {
      inspection.close();
      Adapter.close();
    }
    t.mock.timers.tick(60000); // Closing must also release the maintenance timer.
  });

  it("removes stale authentication records on read without removing other accounts", async () => {
    const path = join(dir, "stale-auth.sqlite");
    let aliceBinding: string | undefined = "alice-v1";
    const Adapter = createAdapter(path, {
      authenticationBinding: (id) => (id === "alice" ? aliceBinding : "bob-v1"),
    });
    const inspection = new DatabaseSync(path, { readOnly: true });
    try {
      const sessions = new Adapter("Session");
      await sessions.upsert("alice", { accountId: "alice", acr: "alice-v1" }, 120);
      await sessions.upsert("bob", { accountId: "bob", acr: "bob-v1" }, 120);
      aliceBinding = undefined;
      assert.equal(await sessions.find("alice"), undefined);
      assert.equal(inspection.prepare("SELECT count(*) AS n FROM oauth WHERE id='alice'").get()?.n, 0);
      assert.ok(await sessions.find("bob"));
    } finally {
      inspection.close();
      Adapter.close();
    }
  });

  it("migrates only live approved authorization and keeps consumed tokens bounded", async (t) => {
    const path = join(dir, "persistent-authorization.sqlite");
    const now = Math.floor(Date.now() / 1000);
    const Legacy = createAdapter(path);
    const grants = new Legacy("Grant");
    const refresh = new Legacy("RefreshToken");
    for (const id of ["approved", "revoked", "expired"])
      await grants.upsert(id, { accountId: "alice", exp: now + 60 }, id === "expired" ? -1 : 60);
    for (const id of ["approved", "revoked", "expired"])
      await refresh.upsert(id, { accountId: "alice", grantId: id, exp: now + 60, expiresWithSession: true }, 60);
    await refresh.upsert("consumed", { accountId: "alice", grantId: "approved", consumed: now, exp: now + 60 }, 60);
    await new Legacy("AccessToken").upsert("access", { accountId: "alice", grantId: "approved", exp: now + 60 }, 60);
    Legacy.close();

    const Current = createAdapter(path, {
      persistentAuthorization: {
        isGrantValid: (accountId, grantId) => accountId === "alice" && grantId === "approved",
      },
    });
    try {
      t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
      t.mock.timers.tick(366 * 86400000);
      assert.ok(await new Current("Grant").find("approved"));
      assert.ok(await new Current("RefreshToken").find("approved"));
      assert.equal(await new Current("Grant").find("revoked"), undefined);
      assert.equal(await new Current("Grant").find("expired"), undefined);
      assert.equal(await new Current("RefreshToken").find("revoked"), undefined);
      assert.equal(await new Current("RefreshToken").find("expired"), undefined);
      assert.equal(await new Current("RefreshToken").find("consumed"), undefined);
      assert.equal(await new Current("AccessToken").find("access"), undefined);

      await new Current("RefreshToken").consume("approved");
      assert.equal(typeof (await new Current("RefreshToken").find("approved"))?.consumed, "number");
      t.mock.timers.tick(2 * 86400000);
      assert.equal(await new Current("RefreshToken").find("approved"), undefined);
      assert.ok(await new Current("Grant").find("approved"));
    } finally {
      Current.close();
    }
  });

  it("reclaims revoked persistent grants and orphan refresh tokens during maintenance and restart", async (t) => {
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 2000000000000 });
    const path = join(dir, "revoked-persistent.sqlite");
    const valid = new Set(["alice", "bob", "orphan"]);
    const options = { persistentAuthorization: { isGrantValid: (_accountId: string, id: string) => valid.has(id) } };
    const First = createAdapter(path, options);
    try {
      for (const id of valid) {
        await new First("Grant").upsert(id, { accountId: id, iat: 2000000000 }, 60);
        await new First("RefreshToken").upsert(id, { accountId: id, grantId: id }, 60);
      }
      valid.delete("alice");
      await new First("Grant").destroy("orphan");
      t.mock.timers.tick(120000);
      assert.equal(await new First("Grant").find("alice"), undefined);
      assert.equal(await new First("RefreshToken").find("alice"), undefined);
      assert.equal(await new First("RefreshToken").find("orphan"), undefined);
      assert.ok(await new First("RefreshToken").find("bob"));
    } finally {
      First.close();
    }
    valid.delete("bob");
    const Second = createAdapter(path, options);
    try {
      assert.equal(await new Second("Grant").find("bob"), undefined);
      assert.equal(await new Second("RefreshToken").find("bob"), undefined);
    } finally {
      Second.close();
    }
  });

  it("leaves the current refresh token usable when storage cannot fit a renewal", async () => {
    const path = join(dir, "renewal-capacity.sqlite");
    const Adapter = createAdapter(path, { persistentAuthorization: { isGrantValid: () => true } });
    const db = new DatabaseSync(path);
    try {
      await new Adapter("Grant").upsert("grant", { accountId: "owner" }, 60);
      const refresh = new Adapter("RefreshToken");
      await refresh.upsert("current", { accountId: "owner", grantId: "grant" }, 60);
      db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<9997)
        INSERT INTO oauth(model,id,data) SELECT 'Client','filler-'||x,'{}' FROM n`);
      await assert.rejects(refresh.consume("current"), { message: "temporarily_unavailable", statusCode: 503 });
      assert.equal((await refresh.find("current"))?.consumed, undefined);
      db.prepare("DELETE FROM oauth WHERE model='Client'").run();
      await refresh.consume("current");
      assert.equal(typeof (await refresh.find("current"))?.consumed, "number");
    } finally {
      db.close();
      Adapter.close();
    }
  });
});
