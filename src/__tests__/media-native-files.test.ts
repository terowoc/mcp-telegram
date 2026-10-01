import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chatFileSchema, resolveMediaSource } from "../tools/media-source.js";

test("native attachments preserve their bytes and filename in the current account", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-native-media-"));
  const previousRoot = process.env.MCP_TELEGRAM_FILE_ROOT;
  process.env.MCP_TELEGRAM_FILE_ROOT = root;
  const bytes = Buffer.from([0, 255, 1, 128, 0]);
  const file = chatFileSchema.parse({
    download_url: "https://files.example.com/download?signature=temporary",
    file_id: "file-chatgpt-id",
    file_name: "generated-photo.png",
    mime_type: "image/png",
  });
  let imports = 0;
  try {
    const path = await resolveMediaSource(
      { file },
      async (url, name, store, options) => {
        imports++;
        assert.equal(url, file.download_url);
        assert.equal(name, "generated-photo.png");
        assert.equal(options?.mimeType, "image/png");
        assert.equal(options?.maxBytes, 10);
        assert.ok(store);
        return store.upload({ fileName: name, data: bytes.toString("base64"), final: true });
      },
      10,
    );
    assert.deepEqual(await readFile(path), bytes);
    assert.ok(path.startsWith(`${await realpath(root)}/`));
    assert.ok(path.endsWith("/generated-photo.png"));
    assert.equal(imports, 1);
    assert.doesNotThrow(() => chatFileSchema.parse({ download_url: file.download_url, file_id: file.file_id }));
    await assert.rejects(resolveMediaSource({ file, filePath: "/mnt/data/photo.png" }), /exactly one/);
    await assert.rejects(resolveMediaSource({ file: { ...file, download_url: "https://127.0.0.1/secret" } }), /public/);
  } finally {
    if (previousRoot === undefined) delete process.env.MCP_TELEGRAM_FILE_ROOT;
    else process.env.MCP_TELEGRAM_FILE_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
