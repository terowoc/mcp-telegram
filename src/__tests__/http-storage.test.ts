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
});
