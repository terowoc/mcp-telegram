import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import express from "express";
import { mountSaasFrontend } from "../saas/static.js";

const csp = "default-src 'self'; worker-src 'self'; connect-src 'self' https: wss:; form-action 'none'";
test("reserved routes remain JSON and never receive SPA fallback or frontend CSP", async () => {
  const root = await mkdtemp(join(tmpdir(), "saas-static-"));
  await mkdir(join(root, "assets"));
  await mkdir(join(root, "source"));
  await writeFile(join(root, "index.html"), "<title>TG Bridge</title>");
  await writeFile(join(root, "assets/index-12345678.js"), "public frontend");
  await writeFile(join(root, "source/tg-bridge-source.tar.gz"), "source archive");
  const app = express();
  app.use((_req, res, next) => {
    res.set("Content-Security-Policy", "default-src 'none'");
    next();
  });
  app.get("/mcp", (_req, res) => res.status(401).json({ error: "invalid_token" }));
  app.get("/api/saas/me", (_req, res) =>
    res.set("Cache-Control", "no-store").status(401).json({ error: "authentication-required" }),
  );
  mountSaasFrontend(app, { root, origin: "https://mcp.example.test", csp });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    for (const path of ["/mcp", "/api/saas/me"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("content-type") ?? "", /json/);
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'");
    }
    for (const path of [
      "/api/saas/missing",
      "/api/saas/report.html",
      "/oauth/missing",
      "/interaction/missing",
      "/mcp/x",
      "/.well-known/missing",
      "/api%2Fsaas%2Freport.html",
    ])
      assert.equal((await fetch(base + path)).status, 404, path);
    const home = await fetch(`${base}/`);
    assert.match(await home.text(), /TG Bridge/);
    assert.match(home.headers.get("content-security-policy") ?? "", /worker-src 'self'/);
    assert.match(home.headers.get("cache-control") ?? "", /no-store/);
    assert.match(home.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const asset = await fetch(`${base}/assets/index-12345678.js`);
    assert.equal(asset.status, 200);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    assert.equal((await fetch(`${base}/source/tg-bridge-source.tar.gz`)).status, 200);
    assert.equal((await fetch(`${base}/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    assert.equal((await fetch(`${base}/missing`, { method: "POST" })).status, 404);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test("anonymous complete SaaS serves branded frontend while API MCP and discovery stay protected", async () => {
  const { startSaas } = await import("../saas/main.js");
  const root = await mkdtemp(join(tmpdir(), "saas-complete-"));
  await mkdir(join(root, "web"));
  await writeFile(join(root, "key"), Buffer.alloc(32, 1), { mode: 0o600 });
  await writeFile(
    join(root, "web/index.html"),
    `<title>TG Bridge</title><meta http-equiv="Content-Security-Policy" content="${csp}">`,
  );
  const service = await startSaas({
    publicUrl: "https://mcp.example.test",
    authDir: join(root, "auth"),
    sessionKeyFile: join(root, "key"),
    filesRoot: join(root, "files"),
    apiId: 1,
    apiHash: "1".repeat(32),
    version: "fixture",
    webRoot: join(root, "web"),
  });
  const server = service.app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string) =>
    new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        base + path,
        { headers: { host: "mcp.example.test", "x-forwarded-proto": "https" } },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => {
            const headers = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2)
              headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    const home = await get("/");
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /TG Bridge/);
    assert.doesNotMatch(html, /owner|password|sessionPresent/i);
    for (const path of ["/api/saas/me", "/mcp"]) {
      const response = await get(path);
      assert.equal(response.status, 401);
      assert.match(response.headers.get("content-type") ?? "", /json/);
      assert.match(response.headers.get("cache-control") ?? "", /no-store/);
      assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    }
    assert.equal((await get("/api/saas/missing")).status, 401);
    assert.equal((await get("/healthz")).status, 200);
    assert.equal((await get("/.well-known/oauth-protected-resource/mcp")).status, 200);
  } finally {
    await service.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
