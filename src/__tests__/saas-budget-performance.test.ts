import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerBudget } from "../saas/worker-budget.js";

test("bootstrap admission reclaims an idle slot and waits for its physical release", async () => {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reclaiming = false;
  const budget = new WorkerBudget(1, async () => {
    reclaiming = true;
    await exited;
    idle.release();
  });
  const idle = budget.reserve("user:idle");
  const admission = budget.reserveWithReclaim("bootstrap:new");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reclaiming, true);
  assert.throws(() => budget.reserve("user:other"), /capacity/i);
  finish();
  const login = await admission;
  assert.throws(() => budget.reserve("user:other"), /capacity/i);
  login.release();
  budget.reserve("user:other").release();
});

test("duplicate reservation never evicts an unrelated worker", async () => {
  let reclaimed = false;
  const budget = new WorkerBudget(2, async () => {
    reclaimed = true;
  });
  const current = budget.reserve("same");
  await assert.rejects(budget.reserveWithReclaim("same"), /capacity/i);
  assert.equal(reclaimed, false);
  current.release();
});
