import assert from "node:assert/strict";
import type { ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { configFromEnv, startSaas } from "../saas/main.js";
import { SaasStore } from "../saas/store.js";
import type { ParentMessage } from "../saas/worker-protocol.js";

const origin = "https://mcp.example.test",
  password = "a long private account password";
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "saas-main-"));
  const key = join(root, "session.key");
  await writeFile(key, Buffer.alloc(32, 1), { mode: 0o600 });
  return {
    root,
    config: {
      publicUrl: origin,
      authDir: join(root, "auth"),
      sessionKeyFile: key,
      filesRoot: join(root, "files"),
      apiId: 1,
      apiHash: "a".repeat(32),
      version: "test",
      maxUsers: 2,
      maxWorkers: 1,
    },
  };
}
async function serve(app: Awaited<ReturnType<typeof startSaas>>["app"]) {
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    request: (path: string, body?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) =>
      new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          base + path,
          {
            method: body === undefined ? "GET" : "POST",
            headers: {
              host: "mcp.example.test",
              "x-forwarded-proto": "https",
              origin,
              "content-type": "application/json",
              cookie: cookie ?? "",
              ...extraHeaders,
            },
          },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (c) => chunks.push(c));
            incoming.on("end", () => {
              const headers = new Headers();
              for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                headers.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
              resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers }));
            });
          },
        );
        req.on("error", reject);
        req.end(body === undefined ? undefined : JSON.stringify(body));
      }),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
test("missing key fails before any worker or storage is started and config bounds are validated", async () => {
  const s = await setup();
  let spawned = 0;
  const spawn: typeof fork = () => {
    spawned++;
    throw new Error("Unexpected child");
  };
  try {
    await assert.rejects(startSaas({ ...s.config, sessionKeyFile: join(s.root, "missing.key") }, { spawn }), /key/i);
    assert.equal(spawned, 0);
    assert.throws(() => configFromEnv({}), /requires/i);
    assert.throws(
      () =>
        configFromEnv({
          MCP_PUBLIC_URL: origin,
          MCP_AUTH_DIR: s.config.authDir,
          MCP_SESSION_KEY_FILE: s.config.sessionKeyFile,
          MCP_TELEGRAM_FILE_ROOT: s.config.filesRoot,
          TELEGRAM_API_ID: "1",
          TELEGRAM_API_HASH: "a".repeat(32),
          MCP_SAAS_MAX_WORKERS: "0",
        }),
      /worker/i,
    );
  } finally {
    await rm(s.root, { recursive: true, force: true });
  }
});
test("auth reopens with two isolated persistent users and independent healthy control process", async () => {
  const s = await setup();
  let service = await startSaas(s.config);
  let http = await serve(service.app);
  try {
    const a = await http.request("/api/saas/register", { login: "alice", password }),
      b = await http.request("/api/saas/register", { login: "bob", password });
    assert.equal(a.status, 201);
    assert.equal(b.status, 201);
    const cookieA = a.headers.get("set-cookie")?.split(";", 1)[0],
      cookieB = b.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookieA && cookieB);
    const meA = await (await http.request("/api/saas/me", undefined, cookieA)).json(),
      meB = await (await http.request("/api/saas/me", undefined, cookieB)).json();
    assert.notEqual(meA.user.id, meB.user.id);
    await http.close();
    await service.close();
    service = await startSaas(s.config);
    http = await serve(service.app);
    assert.equal((await http.request("/api/saas/me", undefined, cookieA)).status, 200);
    assert.equal((await http.request("/api/saas/me", undefined, cookieB)).status, 200);
    assert.equal((await http.request("/healthz")).status, 200);
    assert.equal((await http.request("/api/saas/register", { login: "overflow", password })).status, 503);
    assert.equal((await http.request("/healthz")).status, 200);
  } finally {
    await http.close();
    await service.close();
    await rm(s.root, { recursive: true, force: true });
  }
});
test("shutdown waits for last child exit before closing database and rejects new admission", async () => {
  const s = await setup();
  const events: string[] = [];
  const original = SaasStore.prototype.close;
  class Child extends EventEmitter {
    connected = true;
    send(message: ParentMessage) {
      if (message.kind === "init")
        queueMicrotask(() => this.emit("message", { kind: "ready", generation: message.generation }));
      return true;
    }
    kill() {
      return true;
    }
  }
  const child = new Child();
  const spawn: typeof fork = () => child as unknown as ChildProcess;
  SaasStore.prototype.close = function () {
    events.push("db-close");
    original.call(this);
  };
  const service = await startSaas(s.config, { spawn });
  const http = await serve(service.app);
  try {
    const registered = await http.request("/api/saas/register", { login: "alice", password });
    const cookie = registered.headers.get("set-cookie")?.split(";", 1)[0];
    const csrf = (await registered.json()).csrfToken;
    const response = await http.request("/api/saas/telegram/login", {}, cookie, { "x-csrf-token": csrf });
    assert.equal(response.status, 202);
    let closed = false;
    const closing = service.close().then(() => {
      closed = true;
    });
    await new Promise<void>((r) => setImmediate(r));
    assert.equal(closed, false);
    assert.equal(events.includes("db-close"), false);
    events.push("last-child-exit");
    child.emit("exit", 0);
    await closing;
    assert.equal(closed, true);
    assert.ok(events.indexOf("last-child-exit") < events.indexOf("db-close"));
  } finally {
    child.emit("exit", 0);
    await http.close();
    await service.close();
    SaasStore.prototype.close = original;
    await rm(s.root, { recursive: true, force: true });
  }
});
test("existing single owner CLI modes retain dispatch and SaaS is explicit", async () => {
  const cli = await readFile(new URL("../cli.ts", import.meta.url), "utf8");
  assert.match(cli, /command === "http"/);
  assert.match(cli, /command === "login"/);
  assert.match(cli, /command === "saas"/);
  assert.match(cli, /import\("\.\/index\.js"\)/);
});

test("worker capacity returns a bounded response while HTTP health stays available", async () => {
  const s = await setup();
  class Child extends EventEmitter {
    connected = true;
    send(message: ParentMessage) {
      if (message.kind === "init")
        queueMicrotask(() => this.emit("message", { kind: "ready", generation: message.generation }));
      return true;
    }
    kill() {
      queueMicrotask(() => this.emit("exit", 0));
      return true;
    }
  }
  const child = new Child();
  const service = await startSaas(s.config, { spawn: (() => child as unknown as ChildProcess) as typeof fork });
  const http = await serve(service.app);
  try {
    const a = await http.request("/api/saas/register", { login: "alice", password });
    const b = await http.request("/api/saas/register", { login: "bob", password });
    const cookieA = a.headers.get("set-cookie")?.split(";", 1)[0];
    const cookieB = b.headers.get("set-cookie")?.split(";", 1)[0];
    const csrfA = (await a.json()).csrfToken;
    const csrfB = (await b.json()).csrfToken;
    assert.equal((await http.request("/api/saas/telegram/login", {}, cookieA, { "x-csrf-token": csrfA })).status, 202);
    const capacity = await http.request("/api/saas/telegram/login", {}, cookieB, { "x-csrf-token": csrfB });
    assert.equal(capacity.status, 503);
    assert.ok(capacity.headers.get("retry-after"));
    assert.equal((await http.request("/healthz")).status, 200);
  } finally {
    await service.close();
    await http.close();
    await rm(s.root, { recursive: true, force: true });
  }
});

test("SaaS forwards configured external MCP origins and rejects unlisted origins", async () => {
  const s = await setup();
  const env = {
    MCP_PUBLIC_URL: origin,
    MCP_AUTH_DIR: s.config.authDir,
    MCP_SESSION_KEY_FILE: s.config.sessionKeyFile,
    MCP_TELEGRAM_FILE_ROOT: s.config.filesRoot,
    TELEGRAM_API_ID: "1",
    TELEGRAM_API_HASH: "a".repeat(32),
    MCP_ALLOWED_ORIGINS: "https://chatgpt.com,https://claude.ai",
  };
  const service = await startSaas(configFromEnv(env));
  const http = await serve(service.app);
  try {
    assert.equal((await http.request("/mcp", undefined, undefined, { origin: "https://chatgpt.com" })).status, 401);
    assert.equal((await http.request("/mcp", undefined, undefined, { origin: "https://claude.ai" })).status, 401);
    assert.equal((await http.request("/mcp", undefined, undefined, { origin: "https://evil.invalid" })).status, 403);
    assert.throws(() => configFromEnv({ ...env, MCP_ALLOWED_ORIGINS: "https://chatgpt.com/path" }), /origin/i);
  } finally {
    await http.close();
    await service.close();
    await rm(s.root, { recursive: true, force: true });
  }
});

test("Telegram Web bootstrap is unavailable and registration creates a password cabinet", async () => {
  const fixture = await setup();
  const runtime = await startSaas(fixture.config);
  const server = await serve(runtime.app);
  try {
    assert.equal((await server.request("/api/saas/telegram-auth/start", {})).status, 401);
    const registered = await server.request("/api/saas/register", { login: "new_user", password });
    assert.equal(registered.status, 201);
    const cookie = registered.headers.getSetCookie()[0].split(";")[0];
    const me = await (await server.request("/api/saas/me", undefined, cookie)).json();
    assert.equal(me.user.hasPassword, true);
    assert.equal(me.telegram.sessionPresent, false);
    assert.equal(
      (await server.request("/api/saas/telegram-auth/start", {}, cookie, { "x-csrf-token": me.csrfToken })).status,
      404,
    );
  } finally {
    await server.close();
    await runtime.close();
    await rm(fixture.root, { recursive: true, force: true });
  }
});
