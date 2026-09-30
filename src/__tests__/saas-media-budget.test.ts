import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SaasMediaBudget } from "../saas/media-budget.js";

test("media reservations bound concurrent writes, tenant bytes and persistent aggregate usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-budget-"));
  const a = "11111111-1111-4111-8111-111111111111",
    b = "22222222-2222-4222-8222-222222222222";
  const options = {
    root,
    maxFileBytes: 4,
    maxUserBytes: 8,
    maxTotalBytes: 8,
    minFreeBytes: 10,
    availableBytes: () => 100,
  };
  try {
    await mkdir(join(root, a));
    await mkdir(join(root, b));
    const budget = new SaasMediaBudget(options);
    const first = budget.reserve(a),
      second = budget.reserve(b);
    assert.throws(() => budget.reserve(a), /quota/);
    await writeFile(join(root, a, "first"), Buffer.alloc(4));
    first();
    second();
    const restarted = new SaasMediaBudget(options);
    const held = restarted.reserve(b);
    assert.throws(() => restarted.reserve(a), /quota/);
    held();
    held();
    await writeFile(join(root, a, "second"), Buffer.alloc(4));
    assert.throws(() => new SaasMediaBudget({ ...options, maxTotalBytes: 100 }).reserve(a), /quota/);
    assert.throws(
      () => new SaasMediaBudget({ ...options, maxTotalBytes: 100, availableBytes: () => 13 }).reserve(b),
      /reserve/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("media entry limits also bound zero-byte files", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-entries-"));
  const user = "11111111-1111-4111-8111-111111111111";
  try {
    await mkdir(join(root, user));
    await writeFile(join(root, user, "empty"), "");
    const budget = new SaasMediaBudget({ root, maxUserFiles: 1, availableBytes: () => 1e10 });
    assert.throws(() => budget.reserve(user), /quota/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
