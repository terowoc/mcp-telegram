import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { get } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { MediaUploadStore } from "../media-upload.js";
import { importMediaUrl, isPublicMediaAddress } from "../media-url.js";

test("URL downloads block local, reserved, mapped and transition addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "100.64.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "::ffff:8.8.8.8",
    "2001:db8::1",
    "2002:7f00:1::1",
    "64:ff9b::7f00:1",
    "3fff::1",
  ])
    assert.equal(isPublicMediaAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"])
    assert.equal(isPublicMediaAddress(ip), true, ip);
});

test("URL import pins DNS, preserves MIME extensions and rejects redirects into private networks", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-media-url-"));
  const calls: string[] = [];
  const request = ((
    url: URL,
    options: { lookup: (host: string, opts: unknown, cb: (...args: unknown[]) => void) => void },
    callback: (res: IncomingMessage) => void,
  ) => {
    const req = new EventEmitter();
    Object.assign(req, { destroy: () => req, setTimeout: () => req });
    queueMicrotask(() => {
      calls.push(url.hostname);
      options.lookup(url.hostname, { all: false }, (...args) => {
        assert.deepEqual(args, [null, "8.8.8.8", 4]);
        const redirect = url.pathname === "/redirect";
        const response = Readable.from(redirect ? [] : [Buffer.from("PNG bytes")]);
        Object.assign(response, {
          statusCode: redirect ? 302 : 200,
          headers: redirect ? { location: "https://internal.test/secret" } : { "content-type": "image/png" },
        });
        callback(response as IncomingMessage);
      });
    });
    return req as ClientRequest;
  }) as typeof get;
  const lookup = async (host: string) => [{ address: host === "internal.test" ? "127.0.0.1" : "8.8.8.8", family: 4 }];
  const store = new MediaUploadStore({ root });
  try {
    const file = await importMediaUrl("https://public.test/signed-download?token=private", undefined, store, {
      lookup,
      request,
    });
    assert.equal(file.fileName, "signed-download.png");
    assert.equal(await readFile(await store.resolve(file.fileId), "utf8"), "PNG bytes");
    await assert.rejects(
      importMediaUrl("https://public.test/redirect", undefined, store, { lookup, request }),
      /public/,
    );
    assert.deepEqual(calls, ["public.test", "public.test"]);
    for (const url of [
      "http://public.test/a",
      "https://user:pass@public.test/a",
      "https://public.test:123/a",
      "sandbox:/mnt/data/photo.png",
    ])
      await assert.rejects(importMediaUrl(url, undefined, store, { lookup, request }), /HTTPS/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("oversized and HTML URL responses do not leave uploads or continue consuming streams", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-media-url-"));
  const request = ((url: URL, _options: unknown, callback: (res: IncomingMessage) => void) => {
    const req = new EventEmitter();
    Object.assign(req, { destroy: () => req, setTimeout: () => req });
    queueMicrotask(() => {
      const response = Readable.from([Buffer.from("123456789")]);
      Object.assign(response, {
        statusCode: 200,
        headers: { "content-type": url.pathname === "/html" ? "text/html" : "video/mp4" },
      });
      callback(response as IncomingMessage);
    });
    return req as ClientRequest;
  }) as typeof get;
  try {
    const store = new MediaUploadStore({ root, maxBytes: 8 });
    const deps = { lookup: async () => [{ address: "8.8.8.8", family: 4 }], request };
    await assert.rejects(importMediaUrl("https://public.test/video", undefined, store, deps), /size/);
    await assert.rejects(importMediaUrl("https://public.test/html", undefined, store, deps), /HTML|downloadable/);
    assert.deepEqual(await readdir(join(root, ".mcp-uploads")), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
