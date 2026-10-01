import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionVault } from "../saas/session-vault.js";
import { createSaasStore } from "../saas/store.js";
import { WorkerSupervisor } from "../saas/supervisor.js";

test("real child IPC executes independent status handlers and tears down both children", async () => {
  const root = await mkdtemp(join(tmpdir(), "saas-fork-"));
  const store = createSaasStore(":memory:");
  const users = [store.register("alice", "hash", []), store.register("bob", "hash", [])];
  const pids: number[] = [];
  const supervisor = new WorkerSupervisor({
    store,
    vault: new SessionVault(Buffer.alloc(32, 1)),
    apiId: 1,
    apiHash: "fixture",
    filesRoot: root,
    spawn: (_file, args, options) => {
      const child = fork(new URL("./fixtures/saas-worker.mjs", import.meta.url), args, options);
      if (child.pid) pids.push(child.pid);
      return child;
    },
  });
  try {
    const results = await Promise.all(users.map((user) => supervisor.call(user.id, "telegram-status", {})));
    assert.equal(pids.length, 2);
    assert.notEqual(pids[0], pids[1]);
    for (const result of results) assert.match(JSON.stringify(result), /not connected|not logged in|false/i);
    await supervisor.close();
    for (const pid of pids) assert.throws(() => process.kill(pid, 0));
  } finally {
    await supervisor.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
