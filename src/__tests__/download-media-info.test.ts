import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import bigInt from "big-integer";
import { Api } from "telegram";
import { TelegramService } from "../telegram-client.js";

test("Telegram download metadata preserves the document name and the legacy path return contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-download-info-"));
  const bytes = Buffer.from("original document bytes");
  const document = new Api.Document({
    id: bigInt(1),
    accessHash: bigInt(2),
    fileReference: Buffer.alloc(0),
    date: 1,
    mimeType: "application/pdf",
    size: bigInt(bytes.length),
    dcId: 1,
    attributes: [new Api.DocumentAttributeFilename({ fileName: "original-report.pdf" })],
  });
  const service = new TelegramService(1, "fixture");
  Object.assign(service, {
    connected: true,
    client: {
      getMessages: async () => [{ media: new Api.MessageMediaDocument({ document }) }],
      downloadMedia: async () => bytes,
    },
  });
  try {
    const path = join(root, "file.bin");
    const info = await service.downloadMediaWithInfo("@me", 7, path);
    assert.deepEqual(info, { fileName: "original-report.pdf", sizeBytes: bytes.length });
    assert.deepEqual(await readFile(path), bytes);
    const legacy = join(root, "legacy.pdf");
    assert.equal(await service.downloadMedia("@me", 7, legacy), legacy);
    assert.deepEqual(await readFile(legacy), bytes);
    await assert.rejects(service.downloadMediaWithInfo("@me", 7, legacy), /EEXIST/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
