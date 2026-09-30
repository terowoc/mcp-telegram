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
