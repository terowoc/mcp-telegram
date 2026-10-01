import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { SessionVault } from "../saas/session-vault.js";
import { createSaasStore } from "../saas/store.js";
import { CapacityError, WorkerSupervisor } from "../saas/supervisor.js";
import { TelegramAuthWorker } from "../saas/telegram-auth-protocol.js";
import { WorkerBudget } from "../saas/worker-budget.js";

const spawn: typeof fork = (_path, args, options) =>
  fork(fileURLToPath(new URL("./fixtures/telegram-auth-worker.mjs", import.meta.url)), args, options);
test("failure_and_cancel_discard_session", async () => {
  const budget = new WorkerBudget(1),
    worker = new TelegramAuthWorker({ budget, apiId: 4, apiHash: "x", spawn });
  const events: { type: string }[] = [];
  await worker.start(randomUUID(), (event) => events.push(event));
  await new Promise((r) => setTimeout(r, 100));
  await worker.dispose({ logout: true });
  assert.equal(
    events.some((e) => e.type === "error"),
    true,
  );
  budget.reserve("replacement").release();
});

test("logout_failure_still_destroys_local_worker", async () => {
  const budget = new WorkerBudget(1),
    worker = new TelegramAuthWorker({ budget, apiId: 4, apiHash: "x", spawn });
  await worker.start(randomUUID(), () => {});
  await new Promise((r) => setTimeout(r, 100));
  await worker.dispose({ logout: true });
  budget.reserve("replacement").release();
});
test("two_slots_are_shared_with_persistent_workers", async () => {
  const dir = await mkdtemp(join(tmpdir(), "tg-budget-")),
    store = createSaasStore(":memory:");
  const budget = new WorkerBudget(2);
  const user = store.register("alice", "hash", []);
  const supervisor = new WorkerSupervisor({
    store,
    vault: new SessionVault(Buffer.alloc(32, 1)),
    apiId: 1,
    apiHash: "x",
    filesRoot: dir,
    budget,
    spawn: (_path, args, options) =>
      fork(fileURLToPath(new URL("./fixtures/saas-worker.mjs", import.meta.url)), args, options),
  });
  const worker = new TelegramAuthWorker({ budget, apiId: 3, apiHash: "x", spawn });
  try {
    await supervisor.prepareLogin(user.id);
    await worker.start(randomUUID(), () => {});
    assert.throws(() => budget.reserve("third"), CapacityError);
    await worker.dispose({ logout: false });
    const lease = budget.reserve("third");
    lease.release();
    lease.release();
    const next = budget.reserve("fourth");
    assert.throws(() => budget.reserve("fifth"), CapacityError);
    next.release();
  } finally {
    await worker.dispose({ logout: false });
    await supervisor.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delayed_exit_keeps_capacity_reserved", async () => {
  const budget = new WorkerBudget(1),
    worker = new TelegramAuthWorker({ budget, apiId: 3, apiHash: "x", spawn });
  await worker.start(randomUUID(), () => {});
  const stopped = worker.dispose({ logout: true });
  assert.throws(() => budget.reserve("other"), CapacityError);
  await stopped;
  budget.reserve("other").release();
});

test("stale_generation_cannot_publish_proof", async () => {
  const events: { type: string }[] = [],
    budget = new WorkerBudget(1);
  const worker = new TelegramAuthWorker({ budget, apiId: 1, apiHash: "x", spawn });
  await worker.start(randomUUID(), (event) => events.push(event));
  await new Promise((r) => setTimeout(r, 100));
  await worker.dispose({ logout: false });
  assert.equal(
    events.some((e) => e.type === "verified"),
    false,
  );
});

test("temporary_worker_has_no_tools_or_user_database", async () => {
  const budget = new WorkerBudget(1),
    worker = new TelegramAuthWorker({ budget, apiId: 2, apiHash: "x", spawn });
  let resolve!: () => void;
  const waiting = new Promise<void>((r) => (resolve = r));
  const events: { type: string }[] = [];
  await worker.start(randomUUID(), (event) => {
    events.push(event);
    if (event.type === "needs-password") resolve();
  });
  await waiting;
  worker.submitPassword("cloud password");
  await new Promise((r) => setTimeout(r, 60));
  await worker.dispose({ logout: false });
  assert.equal(
    events.some((e) => e.type === "verified"),
    true,
  );
  assert.equal("call" in worker, false);
});
