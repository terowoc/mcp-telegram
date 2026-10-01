import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import express from "express";
import { DirectMediaUploads, directUploadPath } from "../http/direct-media-upload.js";
import type { GatewayIdentity } from "../http/identity.js";
import { ToolPolicy } from "../tool-policy.js";

async function setup() {
  let active = true;
  let profile = "full";
  const chunks: Buffer[] = [];
  let final = false;
  const identity = {
    isActive: () => active,
    isGrantValid: (_account: string, grant: string) => grant === "grant",
    toolPolicy: () => new ToolPolicy({ profile }),
    callTool: async (_account: string, name: string, args: Record<string, unknown>) => {
      assert.equal(name, "telegram-upload-media");
      chunks.push(Buffer.from(args.data as string, "base64"));
      final = args.final === true;
      return {
        structuredContent: {
          fileId: "media_11111111-1111-4111-8111-111111111111",
          ready: final,
          receivedBytes: Buffer.concat(chunks).length,
          fileName: "image.png",
          expiresAt: Date.now() + 3600000,
        },
      };
    },
  } as GatewayIdentity;
  let now = 1000;
  const uploads = new DirectMediaUploads({ origin: "https://mcp.test", identity, now: () => now });
  const app = express();
  uploads.mount(app);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  return {
    uploads,
    chunks,
    final: () => final,
    deactivate: () => {
      active = false;
    },
    readOnly: () => {
      profile = "read";
    },
    expire: () => {
      now += 300001;
    },
    url: (ticket: { uploadUrl: string }) =>
      `http://127.0.0.1:${(server.address() as AddressInfo).port}${new URL(ticket.uploadUrl).pathname}`,
    close: async () => {
      uploads.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
const metadata = (bytes: Buffer) => ({
  fileName: "image.png",
  sizeBytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});

test("direct upload streams original binary bytes above the MCP request limit and returns a reusable handle", async () => {
  const s = await setup();
  const bytes = Buffer.alloc(1048576 + 89, 233);
  try {
    const ticket = await s.uploads.create("account", "grant", metadata(bytes));
    assert.ok(directUploadPath(new URL(ticket.uploadUrl).pathname));
    assert.equal((await fetch(s.url(ticket))).status, 401, "The URL alone must not expose upload status");
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
      const chunk = bytes.subarray(offset, offset + 512 * 1024);
      const response = await fetch(s.url(ticket), {
        method: "PUT",
        headers: { ...ticket.headers, "Upload-Offset": String(offset) },
        body: chunk,
      });
      assert.equal(response.status, 200);
      assert.equal((await response.json()).ready, offset + chunk.length === bytes.length);
    }
    assert.deepEqual(Buffer.concat(s.chunks), bytes);
    assert.ok(s.chunks.every((chunk) => chunk.length <= 512 * 1024));
    assert.equal(s.final(), true);
    const status = await fetch(s.url(ticket), { headers: ticket.headers });
    assert.equal((await status.json()).state, "complete");
    const duplicate = await fetch(s.url(ticket), {
      method: "PUT",
      headers: { ...ticket.headers, "Upload-Offset": String(1048576) },
      body: bytes.subarray(1048576),
    });
    assert.equal(duplicate.status, 200);
    assert.deepEqual(Buffer.concat(s.chunks), bytes);
  } finally {
    await s.close();
  }
});

test("wrong hashes, sizes, revoked grants, expired links and read-only access cannot complete uploads", async () => {
  for (const mode of ["hash", "offset", "oversize", "revoked", "expired", "read"] as const) {
    const s = await setup();
    const bytes = Buffer.from("image bytes");
    try {
      const input = metadata(bytes);
      if (mode === "hash") input.sha256 = "0".repeat(64);
      const ticket = await s.uploads.create("account", "grant", input);
      if (mode === "revoked") s.deactivate();
      if (mode === "expired") s.expire();
      if (mode === "read") s.readOnly();
      const body = mode === "oversize" ? Buffer.concat([bytes, bytes]) : bytes;
      const response = await fetch(s.url(ticket), {
        method: "PUT",
        headers: { ...ticket.headers, "Upload-Offset": mode === "offset" ? "1" : "0" },
        body,
      });
      assert.ok(response.status >= 400, mode);
      assert.equal(s.final(), false, mode);
    } finally {
      await s.close();
    }
  }
});

test("the returned Python code transfers a file without base64 entering model output", {
  skip: spawnSync("python3", ["--version"]).status !== 0,
}, async () => {
  const s = await setup();
  const root = await mkdtemp(join(tmpdir(), "tg-python-upload-"));
  const filePath = join(root, "image.png");
  const bytes = Buffer.alloc(1048576 + 97, 255);
  try {
    await writeFile(filePath, bytes);
    const ticket = await s.uploads.create("account", "grant", metadata(bytes));
    const code = ticket.pythonCode
      .replace('Path("/replace/with/the/actual/sandbox/file")', `Path(${JSON.stringify(filePath)})`)
      .replace(`upload_url = ${JSON.stringify(ticket.uploadUrl)}`, `upload_url = ${JSON.stringify(s.url(ticket))}`);
    const { stdout } = await promisify(execFile)("python3", ["-c", code], { timeout: 10000, maxBuffer: 8192 });
    assert.equal(JSON.parse(stdout).ready, true);
    assert.equal(JSON.parse(stdout).receivedBytes, bytes.length);
    assert.deepEqual(Buffer.concat(s.chunks), bytes);
  } finally {
    await s.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("upload authorizations cannot be exchanged between tickets", async () => {
  const s = await setup();
  try {
    const a = await s.uploads.create("account", "grant", metadata(Buffer.from("a")));
    const b = await s.uploads.create("other-account", "grant", metadata(Buffer.from("b")));
    assert.equal((await fetch(s.url(a), { headers: b.headers })).status, 401);
    assert.equal((await fetch(s.url(b), { headers: a.headers })).status, 401);
    assert.equal(s.chunks.length, 0);
  } finally {
    await s.close();
  }
});
