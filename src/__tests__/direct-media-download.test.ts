import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import express from "express";
import { DirectMediaDownloads } from "../http/direct-media-download.js";
import type { GatewayIdentity } from "../http/identity.js";
import { createMcpHandler } from "../http/mcp-handler.js";
import { ToolPolicy } from "../tool-policy.js";

const owner = "11111111-1111-4111-8111-111111111111";
const selected = "22222222-2222-4222-8222-222222222222";
const foreign = "33333333-3333-4333-8333-333333333333";
async function setup(bytes = Buffer.from("original Telegram file")) {
  const root = await mkdtemp(join(tmpdir(), "browser-download-"));
  let active = true,
    grant = true,
    profile = "full",
    now = 1000;
  const calls: Array<{ accountId: string; args: Record<string, unknown> }> = [];
  const identity = {
    kind: "saas",
    isActive: (id: string) => active && id === owner,
    isGrantValid: (id: string, idGrant: string) => grant && id === owner && idGrant === "grant",
    toolPolicy: (_id: string, id?: string) => {
      if (id && ![owner, selected].includes(id)) throw new Error("Foreign account");
      return new ToolPolicy({ profile, chatIds: ["42"] });
    },
    callTool: async (accountId: string, name: string, args: Record<string, unknown>) => {
      assert.equal(name, "telegram-download-media");
      if (args.chatId !== "42") throw new Error("Chat not allowed");
      calls.push({ accountId, args });
      await writeFile(args.downloadPath as string, bytes, { flag: "wx", mode: 0o600 });
      return { content: [], structuredContent: { fileName: "отчёт.pdf", sizeBytes: bytes.length } };
    },
  } as unknown as GatewayIdentity;
  const downloads = new DirectMediaDownloads({ root, origin: "https://mcp.test", identity, now: () => now });
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
  const s = await setup(Buffer.alloc(20 * 1048576 + 1));
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
