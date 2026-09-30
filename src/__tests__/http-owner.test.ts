import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { hashPassword, loadOrCreateSecrets, verifyPassword } from "../http/owner.js";

it("checks owner passwords without accepting malformed or mismatched hashes", async () => {
  const hash = await hashPassword("a private test password");
  assert.ok(await verifyPassword("a private test password", hash));
  assert.equal(await verifyPassword("wrong password", hash), false);
  assert.equal(await verifyPassword("anything", "scrypt:broken"), false);
  assert.equal(await verifyPassword("", ""), false);
  assert.notEqual(hash, await hashPassword("a private test password"));
});

it("keeps signing and cookie secrets stable across application restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-oauth-owner-"));
  try {
    const first = await loadOrCreateSecrets(dir);
    const second = await loadOrCreateSecrets(dir);
    assert.deepEqual(second, first);
    assert.equal(first.cookieKeys.length, 2);
    assert.ok(first.jwks.keys[0].d);
    if (process.platform !== "win32") assert.equal((await stat(join(dir, "secrets.json"))).mode & 0o777, 0o600);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
