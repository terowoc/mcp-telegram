import assert from "node:assert/strict";
import { test } from "node:test";
import * as main from "../saas/main.js";
import { createSaasStore } from "../saas/store.js";

test("maintenance retries only requested deletions and preserves the owner until child cleanup finishes", async () => {
  const store = createSaasStore(":memory:");
  try {
    const owner = store.register("alice", "hash", []),
      unrelated = store.register("bobby", "hash", []);
    const work = store.createTelegramConnection(owner.id, "Work");
    store.disableUser(unrelated.id); // disabled without a delete request must be preserved
    store.requestCabinetDeletion(owner.id);
    let failing = true;
    const stopped: string[] = [];
    const purge = async (id: string) => {
      if (id === work.id && failing) throw new Error("Disk busy");
    };
    await main.cleanupPendingAccounts(
      store,
      async (id) => {
        stopped.push(id);
      },
      purge,
    );
    assert.ok(store.findUser(owner.id));
    assert.ok(store.findUser(work.id));
    assert.ok(store.findUser(unrelated.id));
    failing = false;
    await main.cleanupPendingAccounts(
      store,
      async (id) => {
        stopped.push(id);
      },
      purge,
    );
    assert.equal(store.findUser(work.id), undefined);
    assert.equal(store.findUser(owner.id), undefined);
    assert.ok(store.findUser(unrelated.id));
    assert.deepEqual(store.pendingDeletions(), []);
    assert.equal(stopped[0], work.id);
  } finally {
    store.close();
  }
});
