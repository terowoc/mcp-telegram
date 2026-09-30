import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
