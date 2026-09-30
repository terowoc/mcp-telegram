import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const pin = "28ffcf710b15571e5a2f7bb3bdce3fc90fc8ec80";
test("fork records exact upstream GPL license and build inputs", async () => {
  assert.match(await readFile("apps/web/UPSTREAM.md", "utf8"), new RegExp(pin));
  assert.match(await readFile("apps/web/LICENSE", "utf8"), /GNU GENERAL PUBLIC LICENSE/);
  const packageJson = JSON.parse(await readFile("apps/web/package.json", "utf8"));
  assert.equal(packageJson.license, "GPL-3.0-or-later");
  assert.ok((await readFile("apps/web/package-lock.json", "utf8")).length > 1000);
});
test("release requires explicit frontend credentials and cannot use server credentials", () => {
  const result = spawnSync(process.execPath, ["scripts/build-web.mjs", "production", "--validate"], {
    env: { PATH: process.env.PATH, TELEGRAM_API_ID: "123", TELEGRAM_API_HASH: "SERVER_SECRET_SENTINEL" },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /WEB_TELEGRAM_API/);
  assert.equal(result.stderr.includes("SERVER_SECRET_SENTINEL"), false);
});
test("server secrets are excluded from frontend build environment", async () => {
  const { frontendBuildEnv } = await import("../../scripts/build-web.mjs");
  const env = frontendBuildEnv("production", {
    PATH: process.env.PATH,
    WEB_TELEGRAM_API_ID: "123",
    WEB_TELEGRAM_API_HASH: "1".repeat(32),
    TELEGRAM_API_HASH: "SERVER_SECRET_SENTINEL",
    TELEGRAM_2FA_PASSWORD: "PRIVATE_CLOUD_PASSWORD",
    MCP_SESSION_KEY_FILE: "/private.key",
    MCP_OWNER_PASSWORD: "PRIVATE_OWNER",
  });
  assert.equal(env.TELEGRAM_API_ID, "123");
  assert.equal(env.TELEGRAM_API_HASH, "1".repeat(32));
  assert.equal(JSON.stringify(env).includes("SERVER_SECRET_SENTINEL"), false);
  assert.equal(JSON.stringify(env).includes("PRIVATE_CLOUD_PASSWORD"), false);
  assert.equal(env.MCP_SESSION_KEY_FILE, undefined);
  assert.equal(env.BASE_URL, "https://tg-mcp.azimboev.uz");
  assert.equal(env.APP_TITLE, "TG Bridge");
  assert.equal(env.APP_NAME, "TG Bridge");
  const output = execFileSync(process.execPath, ["scripts/build-web.mjs", "production", "--validate"], {
    env: { PATH: process.env.PATH, WEB_TELEGRAM_API_ID: "123", WEB_TELEGRAM_API_HASH: "1".repeat(32) },
    encoding: "utf8",
  });
  assert.match(output, /TG Bridge/);
  assert.equal(output.includes("1".repeat(32)), false);
});

test("worker bypasses SaaS OAuth MCP and discovery before HTML caching", async () => {
  const { shouldBypassSaasCache } = await import("../../apps/web/src/serviceWorker/saasCache.js");
  for (const path of [
    "/api/saas",
    "/api/saas/me",
    "/api/saas/report.html",
    "/oauth/token",
    "/interaction/abc",
    "/mcp",
    "/.well-known/oauth-authorization-server",
  ])
    assert.equal(shouldBypassSaasCache(path), true, path);
  for (const path of ["/", "/assets/index-12345678.js", "/mcp-help", "/share/x"])
    assert.equal(shouldBypassSaasCache(path), false, path);
  const worker = await readFile("apps/web/src/serviceWorker/service.worker.ts", "utf8");
  assert.ok(worker.indexOf("if (shouldBypassSaasCache(pathname))") < worker.indexOf("respondForProgressive(e)"));
});

test("source archive contains reproducible build inputs without unlisted secrets", async () => {
  const { mkdtemp, mkdir, writeFile, rm, symlink } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { gunzipSync } = await import("node:zlib");
  const { packageWebSource } = await import("../../scripts/package-web-source.mjs");
  const root = await mkdtemp(join(tmpdir(), "web-source-"));
  try {
    await mkdir(join(root, "apps/web"), { recursive: true });
    await mkdir(join(root, "scripts"));
    for (const [path, body] of Object.entries({
      "apps/web/LICENSE": "GNU GENERAL PUBLIC LICENSE",
      "apps/web/UPSTREAM.md": pin,
      "apps/web/package-lock.json": "{}",
      "apps/web/package.json": "{}",
      "apps/web/.env": "SECRET_SENTINEL",
      "apps/web/credentials.json": "SECRET_SENTINEL",
      "scripts/build-web.mjs": "build",
      "scripts/package-web-source.mjs": "package",
    }))
      await writeFile(join(root, path), body);
    await writeFile(
      join(root, "apps/web/SOURCE_FILES.json"),
      JSON.stringify([
        "apps/web/LICENSE",
        "apps/web/UPSTREAM.md",
        "apps/web/package-lock.json",
        "apps/web/package.json",
      ]),
    );
    const first = await packageWebSource({ root, output: join(root, "out") });
    const second = await packageWebSource({ root, output: join(root, "other") });
    assert.equal(first.sha256, second.sha256);
    const tar = gunzipSync(await readFile(join(root, "out/source/tg-bridge-source.tar.gz")));
    assert.equal(tar.includes(Buffer.from("SECRET_SENTINEL")), false);
    assert.ok(first.files.includes("apps/web/package-lock.json"));
    assert.ok(first.files.includes("apps/web/LICENSE"));
    assert.ok(first.files.includes("scripts/build-web.mjs"));
    assert.match(await readFile(join(root, "out/source/README.md"), "utf8"), /npm --prefix apps\/web ci/);
    await mkdir(join(root, "private"));
    await writeFile(join(root, "private/key.txt"), "SECRET_SENTINEL");
    await symlink(join(root, "private"), join(root, "apps/web/linked"), "junction");
    await writeFile(
      join(root, "apps/web/SOURCE_FILES.json"),
      JSON.stringify(["apps/web/linked/key.txt", "apps/web/LICENSE"]),
    );
    await assert.rejects(packageWebSource({ root, output: join(root, "escaped") }), /symlink/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("production base and manifest use TG Bridge origin", async () => {
  const index = await readFile("apps/web/index.html", "utf8");
  assert.equal(index.includes("https://web.telegram.org"), false);
  const manifest = await readFile("apps/web/public/site.webmanifest", "utf8");
  assert.equal(manifest.includes("web.telegram.org"), false);
  assert.match(manifest, /TG Bridge/);
});
