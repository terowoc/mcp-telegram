import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadVaultKey, SessionVault } from "../saas/session-vault.js";

test("ciphertext is bound to user and detects tampering and wrong key", () => {
  const vault = new SessionVault(randomBytes(32));
  const session = "private telegram session string";
  const first = vault.encrypt("alice", session);
  assert.notEqual(first, vault.encrypt("alice", session));
  assert.equal(first.includes(session), false);
  assert.equal(vault.decrypt("alice", first), session);
  assert.throws(() => vault.decrypt("bobby", first));
  assert.throws(() => new SessionVault(randomBytes(32)).decrypt("alice", first));
  const envelope = JSON.parse(first);
  const ciphertext = Buffer.from(envelope.ciphertext, "base64url");
  ciphertext[0] ^= 1;
  envelope.ciphertext = ciphertext.toString("base64url");
  assert.throws(() => vault.decrypt("alice", JSON.stringify(envelope)));
  assert.throws(() => vault.decrypt("alice", "{}"));
});

test("private vault key is required and never regenerated", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saas-vault-"));
  const path = join(dir, "key");
  try {
    await assert.rejects(loadVaultKey(path));
    await writeFile(path, Buffer.alloc(31), { mode: 0o600 });
    await assert.rejects(loadVaultKey(path), /32/i);
    const key = randomBytes(32);
    await writeFile(path, key, { mode: 0o600 });
    assert.deepEqual(await loadVaultKey(path), key);
    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(loadVaultKey(path), /private|permission/i);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
