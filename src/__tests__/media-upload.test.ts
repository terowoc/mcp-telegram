import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MediaUploadStore } from "../media-upload.js";

const encoded = (value: string) => Buffer.from(value).toString("base64");

test("a worker crash before metadata persistence does not block new uploads or bypass quotas", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-orphan-upload-"));
  try {
    const orphan = join(root, ".mcp-uploads", "media_11111111-1111-4111-8111-111111111111", "data");
    await mkdir(orphan, { recursive: true });
    await writeFile(join(orphan, "aborted.mp4"), "12345");
    const store = new MediaUploadStore({ root, maxStoredBytes: 8 });
    const next = await store.upload({ fileName: "next.pdf", data: encoded("67") });
    assert.equal(next.ready, true);
    await assert.rejects(store.upload({ fileName: "too-big.pdf", data: encoded("89") }), /quota/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("chunked uploads resume after worker restart, preserve filenames, and make retries idempotent", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-upload-"));
  try {
    let store = new MediaUploadStore({ root });
    const first = await store.upload({ fileName: "photo.png", data: encoded("first"), final: false });
    assert.equal(first.ready, false);
    assert.equal(first.receivedBytes, 5);
    await assert.rejects(store.resolve(first.fileId), /incomplete/);
    store = new MediaUploadStore({ root });
    await assert.rejects(store.upload({ fileId: first.fileId, offset: 7, data: encoded("bad") }), /offset/);
    const last = { fileId: first.fileId, offset: 5, data: encoded("last"), final: true };
    const complete = await store.upload(last);
    assert.equal(complete.ready, true);
    assert.equal(complete.receivedBytes, 9);
    assert.deepEqual(await store.upload(last), complete);
    assert.deepEqual(await store.upload({ fileId: first.fileId, offset: 9, data: "", final: true }), complete);
    const path = await store.resolve(first.fileId);
    assert.equal(path.endsWith("/photo.png"), true);
    assert.equal(await readFile(path, "utf8"), "firstlast");
    await assert.rejects(store.upload({ fileId: first.fileId, offset: 9, data: encoded("changed") }), /complete/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("expired handles cannot be sent, but cleanup grace lets an already-started send settle", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-expiry-grace-"));
  let now = 1000;
  try {
    const store = new MediaUploadStore({ root, ttlMs: 100, now: () => now });
    const file = await store.upload({ fileName: "video.mp4", data: encoded("video") });
    const path = await store.resolve(file.fileId);
    now = 1101;
    await assert.rejects(store.resolve(file.fileId), /expired/);
    await store.prune(60000);
    assert.equal(await readFile(path, "utf8"), "video");
    now = 61101;
    await store.prune(60000);
    await assert.rejects(readFile(path), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("uploads enforce byte limits, strict base64, names, account isolation and expiry", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-upload-"));
  let now = 1000;
  try {
    const store = new MediaUploadStore({ root: join(root, "a"), maxBytes: 8, ttlMs: 100, now: () => now });
    for (const fileName of ["../secret", "/tmp/a", "a\\b", ".", "a\u0000.png"])
      await assert.rejects(store.upload({ fileName, data: encoded("ok") }), /filename/);
    await assert.rejects(store.upload({ fileName: "a.png", data: "%%%" }), /base64/);
    await assert.rejects(store.upload({ fileName: "a.png", data: encoded("123456789") }), /size/);
    const file = await store.upload({ fileName: "a.png", data: encoded("12345"), final: false });
    await assert.rejects(store.upload({ fileId: file.fileId, offset: 5, data: encoded("6789") }), /size/);
    await assert.rejects(new MediaUploadStore({ root: join(root, "b") }).resolve(file.fileId), /unknown|expired/i);
    await assert.rejects(store.resolve("../../secret"), /fileId/);
    now = 1101;
    await assert.rejects(store.resolve(file.fileId), /expired/i);
    await store.prune();
    assert.deepEqual(await readdir(join(root, "a", ".mcp-uploads")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("storage bounds include incomplete files and failed imports remove partial bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-upload-"));
  try {
    const store = new MediaUploadStore({ root, maxFiles: 2, maxStoredBytes: 8 });
    await assert.rejects(
      store.importStream(
        "movie.mp4",
        (async function* () {
          yield Buffer.from("ab");
          throw new Error("network failed");
        })(),
      ),
      /network/,
    );
    assert.deepEqual(await readdir(join(root, ".mcp-uploads")), []);
    await store.upload({ fileName: "one.pdf", data: encoded("12345"), final: false });
    await assert.rejects(store.upload({ fileName: "two.pdf", data: encoded("6789") }), /quota/);
    await store.upload({ fileName: "two.pdf", data: encoded("67") });
    await assert.rejects(store.upload({ fileName: "three.pdf", data: encoded("8") }), /quota/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
