import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("dashboard validates without Telegram credentials or a browser Telegram client", async () => {
  const result = spawnSync(process.execPath, ["scripts/build-web.mjs", "production", "--validate"], {
    env: { PATH: process.env.PATH },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync("apps/web/package.json"), false);
  const index = await readFile("apps/dashboard/index.html", "utf8");
  assert.match(index, /connect-src 'self'/);
  assert.equal(index.includes("web.telegram.org"), false);
  const docker = await readFile("Dockerfile", "utf8");
  assert.equal(docker.includes("WEB_TELEGRAM_API"), false);
});

test("dashboard build environment excludes all Telegram and server credentials", async () => {
  const { frontendBuildEnv } = await import("../../scripts/build-web.mjs");
  const env = frontendBuildEnv("production", {
    PATH: process.env.PATH,
    WEB_TELEGRAM_API_ID: "123",
    WEB_TELEGRAM_API_HASH: "BROWSER_SECRET_SENTINEL",
    TELEGRAM_API_HASH: "SERVER_SECRET_SENTINEL",
    TELEGRAM_2FA_PASSWORD: "PRIVATE_PASSWORD",
    MCP_SESSION_KEY_FILE: "/private.key",
  });
  assert.equal(JSON.stringify(env).includes("SENTINEL"), false);
  assert.equal(JSON.stringify(env).includes("PRIVATE_PASSWORD"), false);
  assert.equal(env.TELEGRAM_API_ID, undefined);
  assert.equal(env.MCP_SESSION_KEY_FILE, undefined);
});
