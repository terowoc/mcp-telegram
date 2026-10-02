import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { InstagramSupervisor } from "../instagram/supervisor.js";
import { InstagramVault } from "../instagram/vault.js";
import { createSaasStore } from "../saas/store.js";
import { WorkerBudget } from "../saas/worker-budget.js";

async function setup(overrides: { toolMs?: number; loginMs?: number; budget?: WorkerBudget } = {}) {
  const store = createSaasStore(":memory:"),
    root = await mkdtemp(join(tmpdir(), "ig-worker-"));
  const owner = store.register("alice", "hash", []),
    other = store.register("bobby", "hash", []);
  const c = store.instagram.create(owner.id, "Personal");
  const supervisor = new InstagramSupervisor({
    store: store.instagram,
    vault: new InstagramVault(randomBytes(32)),
    budget: new WorkerBudget(2),
    python: process.execPath,
    workerPath: fileURLToPath(new URL("./fixtures/instagram-worker.mjs", import.meta.url)),
    filesRoot: root,
    idleMs: 10000,
    toolMs: 1000,
    ...overrides,
  });
  return {
    store,
    root,
    owner,
    other,
    c,
    supervisor,
    close: async () => {
      await supervisor.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("real Instagram subprocess login persists verified state and isolates owners", async () => {
  const s = await setup();
  try {
    const attempt = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "alice", password: "private" });
    for (let i = 0; i < 30 && s.supervisor.attempt(s.owner.id, s.c.id, attempt.id)?.state !== "connected"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.supervisor.attempt(s.owner.id, s.c.id, attempt.id)?.state, "connected");
    assert.equal(s.supervisor.status(s.owner.id, s.c.id).sessionPresent, true);
    assert.equal(s.supervisor.attempt(s.other.id, s.c.id, attempt.id), undefined);
    await assert.rejects(s.supervisor.call(s.other.id, s.c.id, "instagram-read-messages", { threadId: "12" }));
    const result = await s.supervisor.call(s.owner.id, s.c.id, "instagram-read-messages", { threadId: "12" });
    assert.equal((result as { messages: unknown[] }).messages.length, 1);
  } finally {
    await s.close();
  }
});
test("worker framing failures drain processes and release shared admission", async () => {
  for (const threadId of ["900", "901", "902"]) {
    const s = await setup();
    try {
      const a = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "alice", password: "private" });
      for (let i = 0; i < 50 && s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state !== "connected"; i++)
        await new Promise((r) => setTimeout(r, 10));
      await assert.rejects(s.supervisor.call(s.owner.id, s.c.id, "instagram-read-messages", { threadId }));
      assert.equal(s.supervisor.status(s.owner.id, s.c.id).state, "stopped");
      assert.equal(s.supervisor.status(s.owner.id, s.c.id).busy, false);
    } finally {
      await s.close();
    }
  }
});
test("Instagram queues allow one operation and four waiters and expire login credentials", async () => {
  const s = await setup({ toolMs: 2000, loginMs: 100 });
  try {
    const a = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "code", password: "private" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state, "expired");
    const b = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "alice", password: "private" });
    for (let i = 0; i < 50 && s.supervisor.attempt(s.owner.id, s.c.id, b.id)?.state !== "connected"; i++)
      await new Promise((r) => setTimeout(r, 10));
    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        s.supervisor.call(s.owner.id, s.c.id, "instagram-read-messages", { threadId: "904" }),
      ),
    );
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 5);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
  } finally {
    await s.close();
  }
});
test("send timeout is persisted as unknown and a duplicate key never dispatches again", async () => {
  const s = await setup({ toolMs: 200 });
  try {
    const a = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "alice", password: "private" });
    for (let i = 0; i < 30 && s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state !== "connected"; i++)
      await new Promise((r) => setTimeout(r, 10));
    s.store.instagram.setPolicy(s.owner.id, s.c.id, { profile: "full", threadIds: [] });
    await s.supervisor.stop(s.c.id);
    const args = { threadId: "12", text: "timeout", requestId: randomUUID() };
    await assert.rejects(s.supervisor.call(s.owner.id, s.c.id, "instagram-send-message", args), /delivery-unknown/);
    await assert.rejects(s.supervisor.call(s.owner.id, s.c.id, "instagram-send-message", args), /delivery-unknown/);
  } finally {
    await s.close();
  }
});
test("disconnect rejects late generation saves and cancellation drains a pending login", async () => {
  const s = await setup();
  try {
    const a = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "code", password: "private" });
    for (let i = 0; i < 30 && s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state !== "needs-code"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state, "needs-code");
    s.store.instagram.disconnect(s.owner.id, s.c.id);
    await s.supervisor.cancelLogin(s.owner.id, s.c.id, a.id);
    assert.equal(s.store.instagram.get(s.owner.id, s.c.id)?.envelope, undefined);
    assert.equal(s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state, "cancelled");
  } finally {
    await s.close();
  }
});

test("Instagram shares process capacity with Telegram reservations and releases only after exit", async () => {
  const budget = new WorkerBudget(1);
  const telegram = budget.reserve("telegram:fixture");
  const s = await setup({ budget });
  try {
    await assert.rejects(s.supervisor.startLogin(s.owner.id, s.c.id, { username: "code", password: "private" }));
    telegram.release();
    const a = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "code", password: "private" });
    assert.equal(budget.isFull(), true);
    await s.supervisor.cancelLogin(s.owner.id, s.c.id, a.id);
    assert.equal(budget.isFull(), false);
    budget.reserve("telegram:next").release();
  } finally {
    telegram.release();
    await s.close();
  }
});

test("login rate limits persist a cooldown before another attempt can start", async () => {
  const s = await setup();
  try {
    const a = await s.supervisor.startLogin(s.owner.id, s.c.id, { username: "rate", password: "private" });
    for (let i = 0; i < 50 && s.supervisor.attempt(s.owner.id, s.c.id, a.id)?.state !== "failed"; i++)
      await new Promise((r) => setTimeout(r, 10));
    assert.ok(s.store.instagram.get(s.owner.id, s.c.id)!.cooldownUntil > Date.now() + 50000);
    await assert.rejects(
      s.supervisor.startLogin(s.owner.id, s.c.id, { username: "alice", password: "private" }),
      /rate-limited/,
    );
  } finally {
    await s.close();
  }
});
