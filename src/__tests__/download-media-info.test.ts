import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
      // Downloads stream with upload.GetFile (512 KiB requests), not GramJS downloadMedia.
      getSender: async (dcId: number) => ({ dcId }),
      invokeWithSender: async (req: Api.upload.GetFile) => {
        const offset = Number(req.offset.toString());
        return new Api.upload.File({
          type: new Api.storage.FileUnknown(),
          mtime: 0,
          bytes: bytes.subarray(offset, offset + req.limit),
        });
      },
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

test("stepped downloads hold the account for about two seconds per call and continue the partial file", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-download-step-"));
  const bytes = Buffer.from(Array.from({ length: 5 * 524288 }, (_, i) => i % 253));
  const document = new Api.Document({
    id: bigInt(1),
    accessHash: bigInt(2),
    fileReference: Buffer.alloc(0),
    date: 1,
    mimeType: "video/mp4",
    size: bigInt(bytes.length),
    dcId: 1,
    attributes: [new Api.DocumentAttributeFilename({ fileName: "lecture.mp4" })],
  });
  const realNow = Date.now;
  let clock = 1_000_000,
    perRequest = 1500,
    lookups = 0,
    failNext = false;
  // Each 512 KiB request "takes" 1.5 s, so a step reads two of them and stops.
  Date.now = () => clock;
  const service = new TelegramService(1, "fixture");
  Object.assign(service, {
    connected: true,
    client: {
      getMessages: async () => {
        lookups++;
        return [{ media: new Api.MessageMediaDocument({ document }) }];
      },
      getSender: async (dcId: number) => ({ dcId }),
      invokeWithSender: async (req: Api.upload.GetFile) => {
        clock += perRequest;
        if (failNext) {
          failNext = false;
          throw new Error("connection reset");
        }
        const offset = Number(req.offset.toString());
        return new Api.upload.File({
          type: new Api.storage.FileUnknown(),
          mtime: 0,
          bytes: bytes.subarray(offset, offset + req.limit),
        });
      },
    },
  });
  try {
    const path = join(root, "lecture.mp4");
    const first = await service.downloadMediaStep("@me", 7, path, 0);
    assert.deepEqual(first, { fileName: "lecture.mp4", sizeBytes: 1048576, totalBytes: bytes.length, done: false });
    await assert.rejects(service.downloadMediaStep("@me", 7, path, 5), /does not match offsetBytes/);
    failNext = true;
    await assert.rejects(service.downloadMediaStep("@me", 7, path, first.sizeBytes), /connection reset/);
    assert.equal((await stat(path)).size, first.sizeBytes, "a failed later step keeps the partial file");
    const second = await service.downloadMediaStep("@me", 7, path, first.sizeBytes);
    assert.equal(second.sizeBytes, 2097152);
    const last = await service.downloadMediaStep("@me", 7, path, second.sizeBytes);
    assert.deepEqual(last, { fileName: "lecture.mp4", sizeBytes: bytes.length, totalBytes: bytes.length, done: true });
    assert.deepEqual(await readFile(path), bytes);
    assert.equal(lookups, 1, "continuing steps reuse the located file instead of calling getMessages");
    const fresh = join(root, "fresh.mp4");
    failNext = true;
    await assert.rejects(service.downloadMediaStep("@me", 7, fresh, 0), /connection reset/);
    await assert.rejects(stat(fresh), { code: "ENOENT" }, "a failed first step leaves no file");
    // A step also stops early when its next chunk would likely keep the account past 3.5 s.
    perRequest = 1900;
    const careful = await service.downloadMediaStep("@me", 7, join(root, "careful.mp4"), 0);
    assert.equal(careful.sizeBytes, 524288, "1.9 s for one chunk: a second would end near 3.8 s");
    perRequest = 1500;
    await writeFile(join(root, "taken.mp4"), "mine");
    await assert.rejects(service.downloadMediaStep("@me", 7, join(root, "taken.mp4"), 0), /EEXIST/);
    assert.equal(await readFile(join(root, "taken.mp4"), "utf8"), "mine", "an existing file is never overwritten");
  } finally {
    Date.now = realNow;
    await rm(root, { recursive: true, force: true });
  }
});

test("a step that Telegram leaves waiting returns as stalled, and the next step picks up that same read", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-download-stall-"));
  const bytes = Buffer.from(Array.from({ length: 3 * 524288 }, (_, i) => i % 239));
  const document = new Api.Document({
    id: bigInt(1),
    accessHash: bigInt(2),
    fileReference: Buffer.alloc(0),
    date: 1,
    mimeType: "video/mp4",
    size: bigInt(bytes.length),
    dcId: 1,
    attributes: [new Api.DocumentAttributeFilename({ fileName: "lecture.mp4" })],
  });
  const requested: number[] = [];
  let answer: (() => void) | undefined;
  const service = new TelegramService(1, "fixture");
  Object.assign(service, {
    connected: true,
    client: {
      getMessages: async () => [{ media: new Api.MessageMediaDocument({ document }) }],
      getSender: async (dcId: number) => ({ dcId }),
      // The first request sleeps like a flood wait (GramJS ignores the abort signal) and
      // answers only when the test says so; the rest answer at once.
      invokeWithSender: async (req: Api.upload.GetFile) => {
        const offset = Number(req.offset.toString());
        requested.push(offset);
        if (requested.length === 1)
          await new Promise<void>((resolve) => {
            answer = resolve;
          });
        return new Api.upload.File({
          type: new Api.storage.FileUnknown(),
          mtime: 0,
          bytes: bytes.subarray(offset, offset + req.limit),
        });
      },
    },
  });
  try {
    const path = join(root, "lecture.mp4");
    const stalled = await service.downloadMediaStep("@me", 7, path, 0, undefined, 50);
    assert.deepEqual(stalled, {
      fileName: "lecture.mp4",
      sizeBytes: 0,
      totalBytes: bytes.length,
      done: false,
      stalled: true,
    });
    await assert.rejects(stat(path), { code: "ENOENT" }, "an empty first step leaves no file, so 0 starts again");
    answer?.();
    const next = await service.downloadMediaStep("@me", 7, path, 0, undefined, 50);
    assert.equal(next.done, true);
    assert.deepEqual(await readFile(path), bytes);
    assert.deepEqual(requested, [0, 524288, 1048576], "the waiting read was continued, never asked for twice");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a waiting read is resumed only when it is sound: not after a cancelled call, not at another offset, and a failed one is replaced", async () => {
  const root = await mkdtemp(join(tmpdir(), "telegram-download-resume-"));
  const bytes = Buffer.from(Array.from({ length: 3 * 524288 }, (_, i) => i % 233));
  const document = new Api.Document({
    id: bigInt(1),
    accessHash: bigInt(2),
    fileReference: Buffer.alloc(0),
    date: 1,
    mimeType: "video/mp4",
    size: bigInt(bytes.length),
    dcId: 1,
    attributes: [new Api.DocumentAttributeFilename({ fileName: "lecture.mp4" })],
  });
  const requested: number[] = [];
  // The next request waits for the test to answer it (resolve) or fail it (reject).
  let parked: { resolve: () => void; reject: (e: Error) => void } | undefined;
  let park = false;
  const service = new TelegramService(1, "fixture");
  Object.assign(service, {
    connected: true,
    client: {
      getMessages: async () => [{ media: new Api.MessageMediaDocument({ document }) }],
      getSender: async (dcId: number) => ({ dcId }),
      invokeWithSender: async (req: Api.upload.GetFile) => {
        const offset = Number(req.offset.toString());
        requested.push(offset);
        if (park) {
          park = false;
          await new Promise<void>((resolve, reject) => {
            parked = { resolve, reject };
          });
        }
        return new Api.upload.File({
          type: new Api.storage.FileUnknown(),
          mtime: 0,
          bytes: bytes.subarray(offset, offset + req.limit),
        });
      },
    },
  });
  const step = (path: string, offset: number, signal?: AbortSignal) =>
    service.downloadMediaStep("@me", 7, path, offset, signal, 50);
  try {
    // 1. A step whose call is cancelled while it waits keeps no read: its read would fail.
    const a = join(root, "a.mp4");
    const cancelled = new AbortController();
    park = true;
    const first = step(a, 0, cancelled.signal);
    setTimeout(() => cancelled.abort(), 10);
    assert.equal((await first).stalled, true);
    parked?.resolve();
    assert.equal((await step(a, 0)).done, true);
    assert.deepEqual(requested.slice(0, 2), [0, 0], "a new read replaced the cancelled one");
    assert.deepEqual(await readFile(a), bytes);

    // 2. A waiting read that fails when it resumes is reported, and the next step reads anew.
    requested.length = 0;
    const b = join(root, "b.mp4");
    park = true;
    assert.equal((await step(b, 0)).stalled, true);
    parked?.reject(new Error("connection reset"));
    await assert.rejects(step(b, 0), /connection reset/);
    assert.equal((await step(b, 0)).done, true);
    assert.deepEqual(await readFile(b), bytes);
    assert.deepEqual(requested.slice(0, 2), [0, 0]);

    // 3. A waiting read at another offset than the step asks for is dropped, never written.
    requested.length = 0;
    const c = join(root, "c.mp4");
    await writeFile(c, bytes.subarray(0, 1048576));
    park = true;
    assert.equal((await step(c, 1048576)).stalled, true);
    await writeFile(c, bytes.subarray(0, 524288));
    const resumedElsewhere = await step(c, 524288);
    parked?.resolve();
    assert.equal(resumedElsewhere.done, true);
    assert.deepEqual(await readFile(c), bytes);
    assert.deepEqual(requested, [1048576, 524288, 1048576], "the read at 1 MiB was not reused at 512 KiB");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
