import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { DirectMediaDownloads, parseRange } from "../http/direct-media-download.js";
import type { GatewayIdentity } from "../http/identity.js";
import { createMcpHandler } from "../http/mcp-handler.js";
import { ToolPolicy } from "../tool-policy.js";

const owner = "11111111-1111-4111-8111-111111111111";
const selected = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
type SetupOptions = {
  maxBytes?: number;
  waitMs?: number;
  /** Write the first part, then wait for this before writing the rest (a slow Telegram download). */
  hold?: Promise<void>;
  /** Apply hold/fail only to this message (default: every message). */
  holdMessage?: number;
  /** Fail the worker call after writing the first part. */
  fail?: Promise<void>;
  /** Bytes one download step writes (default: the whole file in one step). */
  stepBytes?: number;
  /** Fail this many steps after the first one (a worker restart or a dropped request). */
  flaky?: number;
  /** Answer every step with this worker error text. */
  refuse?: string;
  /** Called before each step with its offset. */
  onStep?: (offset: number) => void;
  /** Refuse this many calls as a busy supervisor would, before the worker sees them. */
  busy?: number;
  /**
   * Fail a call at this offset the way the supervisor reports a worker that timed out, was
   * restarted or failed (it has already written `partial` bytes, or created the file at 0).
   */
  crash?: Array<{ offset: number; message: string; partial?: number }>;
  /** Answer this many steps after the first with "stalled" and no new bytes. */
  stall?: number;
  /** Answer this many first steps with "stalled", nothing written and no file created. */
  stallFirst?: number;
  timeoutMs?: number;
  maxFetching?: number;
};
async function setup(bytes = Buffer.from("original Telegram file"), options: SetupOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "browser-download-"));
  let active = true,
    grant = true,
    profile = "full",
    now = 1000,
    flaky = options.flaky ?? 0,
    busy = options.busy ?? 0,
    stall = options.stall ?? 0,
    stallFirst = options.stallFirst ?? 0;
  const calls: Array<{ accountId: string; args: Record<string, unknown> }> = [];
  const identity = {
    kind: "saas",
    isActive: (id: string) => active && id === owner,
    isGrantValid: (id: string, idGrant: string) => grant && id === owner && idGrant === "grant",
    toolPolicy: (_id: string, id?: string) => {
      if (id && ![owner, selected].includes(id)) throw new Error("Foreign account");
      return new ToolPolicy({ profile, chatIds: ["42"] });
    },
    // A worker that downloads in steps (offsetBytes), like telegram-download-media does.
    callTool: async (accountId: string, name: string, args: Record<string, unknown>) => {
      assert.equal(name, "telegram-download-media");
      if (args.chatId !== "42") throw new Error("Chat not allowed");
      calls.push({ accountId, args });
      const path = args.downloadPath as string,
        offset = args.offsetBytes as number;
      assert.equal(typeof offset, "number", "the link service downloads in steps");
      options.onStep?.(offset);
      if (busy > 0) {
        busy--;
        throw new Error("Telegram worker busy: queue deadline exceeded");
      }
      if (offset === 0 && stallFirst > 0) {
        stallFirst--;
        return {
          content: [],
          structuredContent: {
            fileName: "отчёт.pdf",
            sizeBytes: 0,
            totalBytes: bytes.length,
            done: false,
            stalled: true,
          },
        };
      }
      const crash = options.crash?.findIndex((c) => c.offset === offset) ?? -1;
      if (crash >= 0) {
        const [{ message, partial = 1 }] = options.crash?.splice(crash, 1) ?? [];
        if (offset === 0) await writeFile(path, bytes.subarray(0, partial), { flag: "wx", mode: 0o600 });
        else await appendFile(path, bytes.subarray(offset, offset + partial));
        throw new Error(message);
      }
      if (offset > 0 && stall > 0) {
        stall--;
        return {
          content: [],
          structuredContent: {
            fileName: "отчёт.pdf",
            sizeBytes: offset,
            totalBytes: bytes.length,
            done: false,
            stalled: true,
          },
        };
      }
      if (options.refuse) return { content: [{ type: "text", text: options.refuse }], isError: true };
      // Like the real tool, the worker answers its own failures with isError, never by throwing.
      try {
        if (offset === 0) await writeFile(path, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
        else assert.equal((await stat(path)).size, offset, "each step continues the partial file");
        let end = Math.min(bytes.length, offset + (options.stepBytes ?? bytes.length));
        const held = options.holdMessage === undefined || options.holdMessage === args.messageId;
        if (held && (options.hold || options.fail)) {
          // The first step brings half the file; the next one waits for the test.
          if (offset === 0) end = Math.floor(bytes.length / 2);
          else if (options.fail) {
            await options.fail;
            throw new Error(`ENOENT: no such file or directory, open '${path}'`);
          } else {
            await options.hold;
            end = bytes.length;
          }
        }
        if (offset > 0 && flaky > 0) {
          flaky--;
          await appendFile(path, bytes.subarray(offset, offset + 1));
          throw new Error("connection reset");
        }
        await appendFile(path, bytes.subarray(offset, end));
        return {
          content: [],
          structuredContent: {
            fileName: "отчёт.pdf",
            sizeBytes: end,
            totalBytes: bytes.length,
            done: end >= bytes.length,
          },
        };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
      }
    },
  } as unknown as GatewayIdentity;
  const downloads = new DirectMediaDownloads({
    root,
    origin: "https://mcp.test",
    identity,
    now: () => now,
    maxBytes: options.maxBytes,
    waitMs: options.waitMs,
    retryDelayMs: 1,
    maxFetching: options.maxFetching,
    timeoutMs: options.timeoutMs,
  });
  await downloads.initialize();
  const app = express();
  downloads.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    downloads,
    root,
    calls,
    bytes,
    app,
    identity,
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    expire: () => {
      now += 300001;
    },
    advance: (ms: number) => {
      now += ms;
    },
    revoke: () => {
      grant = false;
    },
    disable: () => {
      active = false;
    },
    readOnly: () => {
      profile = "read";
    },
    url: (ticket: { downloadUrl: string }) =>
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${new URL(ticket.downloadUrl).pathname}`,
    headers: (ticket: { downloadUrl: string }) => ({
      Authorization: `Bearer ${new URLSearchParams(new URL(ticket.downloadUrl).hash.slice(1)).get("token")}`,
    }),
    close: async () => {
      downloads.stop();
      await downloads.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}
const input = { chatId: "42", messageId: 7 };

test("interrupted metadata writes cannot retain expired private payloads indefinitely", async () => {
  const s = await setup();
  try {
    const dir = join(s.root, owner, ".mcp-downloads", foreign);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "metadata.json"), "");
    await writeFile(join(dir, "data"), "orphaned private bytes");
    await utimes(dir, 0, 0);
    s.expire();
    await s.downloads.prune();
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
  } finally {
    await s.close();
  }
});

test("browser download links keep capabilities out of HTTP URLs and stream exact original bytes", async () => {
  const s = await setup(Buffer.alloc(1048576 + 29, 233));
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.equal(ticket.fileName, "отчёт.pdf");
    assert.equal(ticket.sizeBytes, s.bytes.length);
    assert.match(new URL(ticket.downloadUrl).hash, /^#token=[A-Za-z0-9_-]{43}$/);
    assert.equal(new URL(ticket.downloadUrl).search, "");
    assert.doesNotMatch(JSON.stringify(ticket), /downloadPath|filePath|\.mcp-downloads|browser-download-/);
    const landing = await fetch(s.url(ticket), { headers: { Accept: "text/html" } });
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Скачать файл/);
    assert.equal((await fetch(s.url(ticket))).status, 401);
    const head = await fetch(s.url(ticket), { method: "HEAD", headers: s.headers(ticket) });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get("content-length")), s.bytes.length);
    assert.match(head.headers.get("content-disposition") ?? "", /attachment.*filename\*=UTF-8/);
    const response = await fetch(s.url(ticket), { headers: s.headers(ticket) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), s.bytes);
    assert.equal((await fetch(s.url(ticket), { headers: s.headers(ticket) })).status, 200);
  } finally {
    await s.close();
  }
});

test("links expire and deny revoked access, changed profiles and exchanged capabilities", async () => {
  for (const mode of ["expired", "revoked", "disabled", "read"] as const) {
    const s = await setup();
    try {
      const a = await s.downloads.create(owner, "grant", input);
      const b = await s.downloads.create(owner, "grant", input);
      assert.equal((await fetch(s.url(a), { headers: s.headers(b) })).status, 401);
      if (mode === "expired") s.expire();
      if (mode === "revoked") s.revoke();
      if (mode === "disabled") s.disable();
      if (mode === "read") s.readOnly();
      assert.equal((await fetch(s.url(a), { headers: s.headers(a) })).status, mode === "expired" ? 410 : 403);
    } finally {
      await s.close();
    }
  }
});

test("account selection, chat scope, output confinement and legacy paths stay enforced", async () => {
  const s = await setup();
  try {
    const ticket = await s.downloads.create(owner, "grant", { ...input, telegramAccountId: selected });
    assert.match(s.calls[0].args.downloadPath as string, new RegExp(selected));
    await assert.rejects(s.downloads.create(owner, "grant", { ...input, telegramAccountId: foreign }));
    await assert.rejects(s.downloads.create(owner, "grant", { ...input, chatId: "43" }));
    await assert.rejects(
      s.downloads.create(owner, "grant", { ...input, downloadPath: join(s.root, selected, "outside.txt") }),
    );
    await assert.rejects(s.downloads.create(owner, "grant", { ...input, fileName: "../secret.txt" }));
    const outside = await mkdtemp(join(tmpdir(), "outside-download-"));
    try {
      await mkdir(join(s.root, owner), { recursive: true });
      await symlink(outside, join(s.root, owner, "escape"));
      await assert.rejects(
        s.downloads.create(owner, "grant", { ...input, downloadPath: join(s.root, owner, "escape", "file") }),
      );
      assert.deepEqual(await readdir(outside), []);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const legacy = join(s.root, owner, "legacy.pdf");
    const compatible = await s.downloads.create(owner, "grant", { ...input, downloadPath: legacy });
    assert.equal(compatible.filePath, legacy);
    assert.deepEqual(await readFile(legacy), s.bytes);
    s.expire();
    await s.downloads.prune();
    assert.deepEqual(await readFile(legacy), s.bytes, "Caller-selected legacy output remains after link expiry");
    assert.equal((await fetch(s.url(ticket), { headers: s.headers(ticket) })).status, 410);
  } finally {
    await s.close();
  }
});

test("creation and shutdown are bounded and managed download files are reclaimed", async () => {
  const s = await setup();
  try {
    for (let i = 0; i < 5; i++) await s.downloads.create(owner, "grant", input);
    await assert.rejects(s.downloads.create(owner, "grant", input), /limit/i);
    s.expire();
    await s.downloads.prune();
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
    await s.downloads.create(owner, "grant", input);
    s.downloads.stop();
    await s.downloads.close();
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
    await assert.rejects(s.downloads.create(owner, "grant", input), /unavailable|closed/i);
  } finally {
    await s.close();
  }
});

test("real MCP HTTP download calls return a clickable link without requiring a VPS path", async () => {
  const s = await setup();
  const client = new Client({ name: "browser-download", version: "test" });
  s.app.use(express.json());
  s.app.use((_req, res, next) => {
    res.locals.mcpIdentity = { accountId: owner, grantId: "grant" };
    next();
  });
  s.app.post("/mcp", createMcpHandler(s.identity, "test", undefined, s.downloads));
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`)));
    const catalog = await client.listTools();
    const tool = catalog.tools.find((t) => t.name === "telegram-download-media");
    assert.ok(tool?.inputSchema.properties?.fileName);
    assert.equal(tool?.inputSchema.required?.includes("downloadPath"), false);
    const response = await client.callTool({
      name: "telegram-download-media",
      arguments: { ...input, telegramAccountId: selected, fileName: "a[1].pdf" },
    });
    assert.notEqual(response.isError, true);
    const ticket = response.structuredContent as { downloadUrl: string; sizeBytes: number; fileName: string };
    assert.equal(ticket.fileName, "a[1].pdf");
    const text = response.content as Array<{ type: string; text: string }>;
    assert.match(text[0].text, /a\\\[1\\\]\.pdf/);
    assert.match(text[0].text, /https:\/\/mcp.test\/media\/downloads/);
    assert.doesNotMatch(text[0].text, /\.mcp-downloads|downloadPath/);
    const downloaded = await fetch(s.url(ticket), { headers: s.headers(ticket) });
    assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), s.bytes);
  } finally {
    await client.close();
    await s.close();
  }
});

test("oversized media and replaced file paths cannot become download capabilities", async () => {
  const s = await setup(Buffer.alloc(20 * 1048576 + 1), { maxBytes: 20 * 1048576 });
  try {
    await assert.rejects(s.downloads.create(owner, "grant", input), /size|limit/i);
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
  } finally {
    await s.close();
  }
});

test("expired orphan cleanup is limited to marked temporary downloads", async () => {
  const s = await setup();
  try {
    const base = join(s.root, owner, ".mcp-downloads");
    const retired = join(base, foreign),
      retained = join(base, selected);
    for (const dir of [retired, retained]) await mkdir(dir, { recursive: true });
    await writeFile(join(retired, "metadata.json"), JSON.stringify({ kind: "mcp-browser-download-v1", expiresAt: 0 }));
    await writeFile(join(retired, "data"), "expired");
    await writeFile(join(retained, "metadata.json"), JSON.stringify({ kind: "unrelated", expiresAt: 0 }));
    await writeFile(join(retained, "data"), "keep");
    await s.downloads.prune();
    assert.deepEqual(await readdir(base), [selected]);
    assert.equal(await readFile(join(retained, "data"), "utf8"), "keep");
  } finally {
    await s.close();
  }
});

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 200 && !(await check()); i++) await new Promise((r) => setTimeout(r, 10));
};

test("large files answer preparing, report progress on the same link, then serve the exact bytes", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const s = await setup(Buffer.alloc(2 * 1048576 + 17, 7), { waitMs: 30, hold });
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.equal(ticket.status, "preparing");
    assert.match(ticket.downloadUrl, /#token=/);
    const progress = await fetch(s.url(ticket), { headers: s.headers(ticket) });
    assert.equal(progress.status, 202);
    assert.equal(progress.headers.get("retry-after"), "3");
    assert.equal((await progress.json()).receivedBytes, Math.floor(s.bytes.length / 2));
    assert.equal((await fetch(s.url(ticket))).status, 401, "progress still needs the capability");
    release();
    await until(
      async () => (await fetch(s.url(ticket), { method: "HEAD", headers: s.headers(ticket) })).status === 200,
    );
    const response = await fetch(s.url(ticket), { headers: s.headers(ticket) });
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), s.bytes);
  } finally {
    await s.close();
  }
});

test("a background download that fails says why and leaves no partial file", async () => {
  let fail!: () => void;
  const failure = new Promise<void>((r) => {
    fail = r;
  });
  const s = await setup(Buffer.alloc(4096, 1), { waitMs: 20, fail: failure });
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.equal(ticket.status, "preparing");
    fail();
    await until(async () => (await fetch(s.url(ticket), { headers: s.headers(ticket) })).status === 502);
    const response = await fetch(s.url(ticket), { headers: s.headers(ticket) });
    assert.equal(response.status, 502);
    const { error } = await response.json();
    assert.equal(error, "Telegram media could not be downloaded");
    assert.doesNotMatch(error, /ENOENT|browser-download-|\.mcp-downloads/, "no server paths in the answer");
    assert.equal(s.calls.length, 2 + 3, "a step after progress is retried three times");
    const id = new URL(ticket.downloadUrl).pathname.split("/").pop() as string;
    assert.equal((await readdir(join(s.root, owner, ".mcp-downloads", id))).includes("data"), false);
    s.expire();
    await s.downloads.prune();
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
  } finally {
    await s.close();
  }
});

test("range requests resume and seek inside the file; bad ranges are refused", async () => {
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  const s = await setup(bytes);
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    const head = await fetch(s.url(ticket), { method: "HEAD", headers: s.headers(ticket) });
    assert.equal(head.headers.get("accept-ranges"), "bytes");
    const part = await fetch(s.url(ticket), { headers: { ...s.headers(ticket), Range: "bytes=100-199" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 100-199/1000");
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(100, 200));
    const tail = await fetch(s.url(ticket), { headers: { ...s.headers(ticket), Range: "bytes=-10" } });
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(990));
    const bad = await fetch(s.url(ticket), { headers: { ...s.headers(ticket), Range: "bytes=5000-" } });
    assert.equal(bad.status, 416);
    assert.equal(bad.headers.get("content-range"), "bytes */1000");
    const several = await fetch(s.url(ticket), { headers: { ...s.headers(ticket), Range: "bytes=0-1,5-6" } });
    assert.equal(several.status, 200, "an unsupported Range header is ignored, not refused");
    assert.deepEqual(Buffer.from(await several.arrayBuffer()), bytes);
  } finally {
    await s.close();
  }
});

test("each use keeps a link alive five more minutes; an unused link still expires", async () => {
  const s = await setup();
  try {
    const used = await s.downloads.create(owner, "grant", input);
    const idle = await s.downloads.create(owner, "grant", input);
    s.advance(240000);
    assert.equal((await fetch(s.url(used), { headers: s.headers(used) })).status, 200);
    s.advance(240000);
    assert.equal((await fetch(s.url(used), { headers: s.headers(used) })).status, 200, "renewed by the last use");
    assert.equal((await fetch(s.url(idle), { headers: s.headers(idle) })).status, 410);
  } finally {
    await s.close();
  }
});

test("parseRange serves one byte range, refuses unsatisfiable ones and ignores the rest (RFC 9110)", () => {
  assert.equal(parseRange(undefined, 10), undefined);
  assert.deepEqual(parseRange("bytes=2-5", 10), { start: 2, end: 5 });
  assert.deepEqual(parseRange("bytes=7-", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-3", 10), { start: 7, end: 9 });
  assert.deepEqual(parseRange("bytes=-30", 10), { start: 0, end: 9 });
  assert.deepEqual(parseRange("bytes=8-100", 10), { start: 8, end: 9 });
  for (const unsatisfiable of ["bytes=10-", "bytes=10-20", "bytes=-0"])
    assert.equal(parseRange(unsatisfiable, 10), "invalid", unsatisfiable);
  for (const ignored of ["bytes=5-2", "bytes=-", "bytes=0-1,4-5", "items=0-1", "bytes=a-"])
    assert.equal(parseRange(ignored, 10), undefined, ignored);
});

test("downloads run in short worker steps and a failed step resumes from the partial file", async () => {
  const bytes = Buffer.from(Array.from({ length: 4500 }, (_, i) => i % 249));
  const s = await setup(bytes, { stepBytes: 1000, flaky: 1 });
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.equal(ticket.status, "ready");
    assert.equal(ticket.sizeBytes, bytes.length);
    // The step at 1000 failed after writing one byte; the retry continued from the file's real size.
    assert.deepEqual(
      s.calls.map((c) => c.args.offsetBytes),
      [0, 1000, 1001, 2001, 3001, 4001],
    );
    const response = await fetch(s.url(ticket), { headers: s.headers(ticket) });
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  } finally {
    await s.close();
  }
});

test("revoking access stops a download between steps", async () => {
  let s!: Awaited<ReturnType<typeof setup>>;
  s = await setup(Buffer.alloc(5000, 3), { stepBytes: 1000, onStep: (offset) => offset === 1000 && s.revoke() });
  try {
    await assert.rejects(s.downloads.create(owner, "grant", input), /revoked/);
    assert.equal(s.calls.length, 2, "no step runs after the grant is revoked");
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
  } finally {
    await s.close();
  }
});

test("a refused first step is not retried and says the file is over the limit", async () => {
  const s = await setup(undefined, { refuse: "Error: Media size exceeds configured download limit" });
  try {
    await assert.rejects(s.downloads.create(owner, "grant", input), /larger than the 2000 MiB download limit/);
    assert.equal(s.calls.length, 1);
  } finally {
    await s.close();
  }
});

test("a call that is already cancelled starts no download", async () => {
  const s = await setup();
  try {
    await assert.rejects(s.downloads.create(owner, "grant", input, { signal: AbortSignal.abort() }), /cancelled/);
    assert.equal(s.calls.length, 0);
    assert.deepEqual(await readdir(join(s.root, owner, ".mcp-downloads")), []);
  } finally {
    await s.close();
  }
});

test("a busy worker is waited for, but a first step never continues a file it did not create", async () => {
  const s = await setup(undefined, { busy: 2 });
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.deepEqual(
      s.calls.map((c) => c.args.offsetBytes),
      [0, 0, 0],
    );
    assert.deepEqual(
      Buffer.from(await (await fetch(s.url(ticket), { headers: s.headers(ticket) })).arrayBuffer()),
      s.bytes,
    );
    const taken = await setup(undefined, { busy: 1 });
    try {
      const path = join(taken.root, owner, "mine.pdf");
      await mkdir(join(taken.root, owner), { recursive: true });
      await writeFile(path, "the caller's own file");
      await assert.rejects(taken.downloads.create(owner, "grant", { ...input, downloadPath: path }));
      assert.equal(await readFile(path, "utf8"), "the caller's own file", "an existing legacy file is left alone");
      assert.deepEqual(
        taken.calls.map((c) => c.args.offsetBytes),
        [0, 0],
      );
    } finally {
      await taken.close();
    }
  } finally {
    await s.close();
  }
});

test("failures arrive as the supervisor reports them and are retried only where that is safe", async () => {
  const bytes = Buffer.from(Array.from({ length: 3000 }, (_, i) => i % 241));
  // A worker that timed out mid-step ("Worker request cancelled") and one that failed while
  // creating the file ("Telegram operation failed", leaving a partial file behind).
  const s = await setup(bytes, {
    stepBytes: 1000,
    crash: [
      { offset: 0, message: "Telegram operation failed", partial: 10 },
      { offset: 1000, message: "Worker request cancelled", partial: 5 },
    ],
  });
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.deepEqual(
      s.calls.map((c) => c.args.offsetBytes),
      [0, 0, 1000, 1005, 2005],
    );
    assert.deepEqual(
      Buffer.from(await (await fetch(s.url(ticket), { headers: s.headers(ticket) })).arrayBuffer()),
      bytes,
    );
  } finally {
    await s.close();
  }
  const legacy = await setup(bytes, { crash: [{ offset: 0, message: "Worker request cancelled" }] });
  try {
    const path = join(legacy.root, owner, "lecture.mp4");
    await mkdir(join(legacy.root, owner), { recursive: true });
    await assert.rejects(
      legacy.downloads.create(owner, "grant", { ...input, downloadPath: path }),
      /could not be downloaded/,
    );
    assert.equal(legacy.calls.length, 1, "a legacy path's first step is retried only when the worker never saw it");
    await assert.rejects(stat(path), { code: "ENOENT" }, "the partial file this download created is removed");
  } finally {
    await legacy.close();
  }
  const full = await setup(bytes, {
    stepBytes: 1000,
    crash: [{ offset: 1000, message: "Media storage quota reached", partial: 0 }],
  });
  try {
    await assert.rejects(full.downloads.create(owner, "grant", input), /^Error: Media storage quota reached$/);
    assert.equal(full.calls.length, 2, "a full storage quota is reported, not retried");
    assert.deepEqual(await readdir(join(full.root, owner, ".mcp-downloads")), []);
  } finally {
    await full.close();
  }
});

test("stalled steps wait and continue instead of failing", async () => {
  const s = await setup(Buffer.alloc(3000, 9), { stepBytes: 1000, stall: 3 });
  try {
    const ticket = await s.downloads.create(owner, "grant", input);
    assert.equal(ticket.sizeBytes, 3000);
    assert.deepEqual(
      s.calls.map((c) => c.args.offsetBytes),
      [0, 1000, 1000, 1000, 1000, 2000],
    );
  } finally {
    await s.close();
  }
});

const pathOf = (ticket: { downloadUrl: string }) => new URL(ticket.downloadUrl).pathname.split("/").pop() as string;
const continuedPaths = (calls: Array<{ args: Record<string, unknown> }>) =>
  new Set(calls.filter((c) => (c.args.offsetBytes as number) > 0).map((c) => c.args.downloadPath));

test("a file one step finishes never waits behind a long download", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const s = await setup(Buffer.alloc(4096, 5), { waitMs: 20, hold, holdMessage: 7, maxFetching: 1 });
  try {
    const long = await s.downloads.create(owner, "grant", input);
    assert.equal(long.status, "preparing");
    const small = await s.downloads.create(owner, "grant", { ...input, messageId: 8 });
    assert.equal(small.status, "ready", "same account and the only turn taken, yet no wait");
    assert.equal(small.sizeBytes, 4096);
  } finally {
    release();
    await s.close();
  }
});

test("past their first step, downloads take turns: one per Telegram account, a few in total", async () => {
  for (const maxFetching of [2, 1]) {
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    const s = await setup(Buffer.alloc(4096, 5), { waitMs: 20, hold, maxFetching });
    try {
      const first = await s.downloads.create(owner, "grant", input);
      const sameAccount = await s.downloads.create(owner, "grant", input);
      const otherAccount = await s.downloads.create(owner, "grant", { ...input, telegramAccountId: selected });
      for (const ticket of [first, sameAccount, otherAccount]) assert.equal(ticket.status, "preparing");
      assert.equal(s.calls.filter((c) => c.args.offsetBytes === 0).length, 3, "every first step ran at once");
      const continued = [...continuedPaths(s.calls)].map(String);
      assert.ok(continued.some((path) => path.includes(pathOf(first))));
      assert.ok(!continued.some((path) => path.includes(pathOf(sameAccount))), "one download per account");
      assert.equal(
        continued.some((path) => path.includes(pathOf(otherAccount))),
        maxFetching === 2,
        `another account continues only while a turn is free (maxFetching ${maxFetching})`,
      );
      const waiting = await fetch(s.url(sameAccount), { headers: s.headers(sameAccount) });
      assert.equal(waiting.status, 202);
      assert.equal((await waiting.json()).receivedBytes, 2048, "the first step's bytes are already there");
      release();
      for (const ticket of [first, sameAccount, otherAccount])
        await until(
          async () => (await fetch(s.url(ticket), { method: "HEAD", headers: s.headers(ticket) })).status === 200,
        );
      assert.equal(continuedPaths(s.calls).size, 3);
    } finally {
      release();
      await s.close();
    }
  }
});

test("closing the service cancels downloads still waiting for their turn", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const s = await setup(Buffer.alloc(4096, 5), { waitMs: 20, hold });
  try {
    await s.downloads.create(owner, "grant", input);
    const queued = await s.downloads.create(owner, "grant", input);
    s.downloads.stop();
    release();
    await s.downloads.close();
    assert.ok(![...continuedPaths(s.calls)].some((path) => String(path).includes(pathOf(queued))));
  } finally {
    release();
    await s.close();
  }
});

test("a download gives up after Telegram sends nothing for many steps in a row", async () => {
  const s = await setup(Buffer.alloc(3000, 9), { stepBytes: 1000, stall: 1000 });
  try {
    await assert.rejects(s.downloads.create(owner, "grant", input), /stopped sending the file/);
    assert.equal(s.calls.length, 1 + 30);
  } finally {
    await s.close();
  }
});

test("a legacy path is checked again before each first step, so a file that appeared later is never removed", async () => {
  let path = "";
  const s = await setup(undefined, {
    stallFirst: 1,
    // The caller's own file appears while the download waits after its stalled first step;
    // the next first step's answer is then lost.
    onStep: () => {
      if (s.calls.length === 1) writeFileSync(path, "the caller's own file");
    },
    crash: [{ offset: 0, message: "Worker request cancelled" }],
  });
  try {
    path = join(s.root, owner, "lecture.mp4");
    await mkdir(join(s.root, owner), { recursive: true });
    await assert.rejects(s.downloads.create(owner, "grant", { ...input, downloadPath: path }));
    assert.equal(await readFile(path, "utf8"), "the caller's own file");
  } finally {
    await s.close();
  }
});

test("waiting for a turn is bounded, so a link can't stay preparing indefinitely", async () => {
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const s = await setup(Buffer.alloc(4096, 5), { waitMs: 20, hold, maxFetching: 1, timeoutMs: 100 });
  try {
    await s.downloads.create(owner, "grant", input);
    const waiting = await s.downloads.create(owner, "grant", { ...input, telegramAccountId: selected });
    await until(async () => (await fetch(s.url(waiting), { headers: s.headers(waiting) })).status === 502);
    const response = await fetch(s.url(waiting), { headers: s.headers(waiting) });
    assert.match((await response.json()).error, /Other large downloads are still running/);
  } finally {
    release();
    await s.close();
  }
});
