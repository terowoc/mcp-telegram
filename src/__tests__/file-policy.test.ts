import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { downloadConcurrency, downloadTimeoutMs, FilePolicy, maxDownloadBytes } from "../file-policy.js";
import { TelegramService } from "../telegram-client.js";

it("confines media to its root, rejects escapes/URLs/devices and limits size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-files-"));
  const root = join(dir, "files");
  const policy = new FilePolicy({ root, maxBytes: 8 });
  await policy.save(join(root, "ok"), Buffer.from("hello"));
  assert.equal(await policy.upload(join(root, "ok")), await realpath(join(root, "ok")));
  for (const path of ["https://example.test/a", "/proc/self/environ", join(root, "../secret")])
    await assert.rejects(policy.upload(path));
  await writeFile(join(dir, "secret"), "secret");
  await symlink(join(dir, "secret"), join(root, "link"));
  await assert.rejects(policy.upload(join(root, "link")));
  await writeFile(join(root, "large"), "123456789");
  await assert.rejects(policy.upload(join(root, "large")), /size/);
  await assert.rejects(policy.save(join(root, "ok"), Buffer.from("replace")), /exist/);
  assert.equal(await readFile(join(root, "ok"), "utf8"), "hello");
  await assert.rejects(policy.save(join(root, "large-output"), Buffer.alloc(9)), /size/);
  await assert.rejects(policy.save(join(root, "link"), Buffer.from("replace")));
  assert.equal(await readFile(join(dir, "secret"), "utf8"), "secret");
  await rm(dir, { recursive: true, force: true });
});

it("rejects oversized inline profile photos at the service boundary", async () => {
  const previousRoot = process.env.MCP_TELEGRAM_FILE_ROOT;
  const previousLimit = process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES;
  process.env.MCP_TELEGRAM_FILE_ROOT = tmpdir();
  process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES = "8";
  try {
    const service = new TelegramService(1, "test");
    Object.assign(service, {
      connected: true,
      client: { getEntity: async () => ({}), downloadProfilePhoto: async () => Buffer.alloc(9) },
    });
    await assert.rejects(service.downloadProfilePhoto("me"), /size/);
  } finally {
    if (previousRoot === undefined) delete process.env.MCP_TELEGRAM_FILE_ROOT;
    else process.env.MCP_TELEGRAM_FILE_ROOT = previousRoot;
    if (previousLimit === undefined) delete process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES;
    else process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES = previousLimit;
  }
});

it("downloads have their own limit and are written to fresh files inside the root only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mcp-files-"));
  const root = join(dir, "files");
  try {
    const policy = new FilePolicy({ root, maxBytes: 4, maxDownloadBytes: 10 });
    assert.throws(() => policy.checkSize(5), /limit/);
    policy.checkDownloadSize(10);
    assert.throws(() => policy.checkDownloadSize(11), /download limit/);
    const out = await policy.openOutput(join(root, "video.mp4"));
    await out.handle.close();
    await assert.rejects(policy.openOutput(join(root, "video.mp4")), /EEXIST/);
    await assert.rejects(policy.openOutput(join(root, "../outside.mp4")), /root|Unsafe/);
    assert.equal(maxDownloadBytes({}), 2000 * 1048576, "defaults to Telegram's own limit");
    assert.equal(maxDownloadBytes({ MCP_TELEGRAM_MAX_DOWNLOAD_BYTES: "20971520" }), 20971520);
    assert.throws(() => maxDownloadBytes({ MCP_TELEGRAM_MAX_DOWNLOAD_BYTES: "-1" }), /Invalid/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("download concurrency stays below the worker count, and both download settings have safe bounds", () => {
  assert.equal(downloadConcurrency({}), 2);
  assert.equal(downloadConcurrency({ MCP_TELEGRAM_DOWNLOAD_CONCURRENCY: "3" }), 3);
  for (const bad of ["0", "65", "1.5", "x"])
    assert.throws(() => downloadConcurrency({ MCP_TELEGRAM_DOWNLOAD_CONCURRENCY: bad }), /Invalid/, bad);
  assert.equal(downloadConcurrency({ MCP_TELEGRAM_DOWNLOAD_CONCURRENCY: "5", MCP_SAAS_MAX_WORKERS: "3" }), 2);
  assert.equal(downloadConcurrency({ MCP_SAAS_MAX_WORKERS: "1" }), 1, "at least one turn, even with one worker");
  assert.equal(downloadTimeoutMs({}), 60 * 60000);
  assert.throws(() => downloadTimeoutMs({ MCP_TELEGRAM_DOWNLOAD_TIMEOUT_MS: "1000" }), /Invalid/);
});
