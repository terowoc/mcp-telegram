import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
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

test("uploads reserve both payload and metadata entries atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-upload-budget-"));
  const user = "11111111-1111-4111-8111-111111111111";
  try {
    await mkdir(join(root, user));
    const budget = new SaasMediaBudget({
      root,
      maxFileBytes: 4,
      maxUserBytes: 10,
      maxUserFiles: 3,
      availableBytes: () => 1e10,
    });
    const release = budget.reserve(user, { files: 2, bytes: 5 });
    assert.throws(() => budget.reserve(user, { files: 2, bytes: 5 }), /quota/);
    release();
    const again = budget.reserve(user, { files: 2, bytes: 5 });
    again();
    again();
    const normal = budget.reserve(user);
    normal();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default budgets let an account keep one full-size file while it fetches the next, and follow the env", async () => {
  const root = await mkdtemp(join(tmpdir(), "media-budget-"));
  const user = "11111111-1111-4111-8111-111111111111";
  const saved = { ...process.env };
  const MiB = 1048576;
  try {
    await mkdir(join(root, user));
    process.env.MCP_TELEGRAM_MAX_DOWNLOAD_BYTES = String(100 * MiB);
    const budget = new SaasMediaBudget({ root, minFreeBytes: 1, availableBytes: () => 10_000 * MiB });
    // A finished full-size file waiting for its link to expire, and the next one nearly done.
    const sized = async (name: string, bytes: number) => {
      const handle = await open(join(root, user, name), "w");
      await handle.truncate(bytes);
      await handle.close();
    };
    await sized("finished", 100 * MiB);
    await sized("partial", 99 * MiB);
    budget.reserve(user, { bytes: 64 * MiB + 1024, files: 3 })();
    await sized("third", 100 * MiB);
    assert.throws(() => budget.reserve(user, { bytes: 64 * MiB + 1024, files: 3 }), /quota/);
    await rm(join(root, user), { recursive: true });
    await mkdir(join(root, user));
    process.env.MCP_TELEGRAM_MEDIA_USER_BYTES = String(50 * MiB);
    const strict = new SaasMediaBudget({ root, minFreeBytes: 1, availableBytes: () => 10_000 * MiB });
    assert.throws(() => strict.reserve(user, { bytes: 60 * MiB, files: 1 }), /quota/);
    strict.reserve(user, { bytes: 40 * MiB, files: 1 })();
  } finally {
    for (const key of ["MCP_TELEGRAM_MAX_DOWNLOAD_BYTES", "MCP_TELEGRAM_MEDIA_USER_BYTES"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    await rm(root, { recursive: true, force: true });
  }
});
