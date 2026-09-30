import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { FilePolicy } from "../file-policy.js";
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
