import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createHttpGateway } from "../http/gateway.js";
import { hashPassword } from "../http/owner.js";
import { SaasAuth } from "../saas/auth.js";
import { createSaasIdentity } from "../saas/identity.js";
import { createSaasStore } from "../saas/store.js";

const origin = "https://mcp.example.test",
  password = "a very private SaaS test password";
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "saas-oauth-"));
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: Buffer.alloc(32, 1) });
  const alice = await auth.register("alice", password),
    bob = await auth.register("bob", password);
  const calls: { userId: string; name: string }[] = [];
  const identity = createSaasIdentity(store, auth, {
    call: async (userId, name) => {
      calls.push({ userId, name });
      return { content: [{ type: "text", text: `executed ${name}` }] };
    },
  });
  let server: Server, gateway: Awaited<ReturnType<typeof createHttpGateway>>, base: string;
  async function start(owner = false) {
    gateway = await createHttpGateway({
      publicUrl: origin,
      storageDir: dir,
      version: "test",
      ownerPasswordHash: await hashPassword(password),
      callTool: async () => ({ content: [{ type: "text", text: "legacy owner" }] }),
      identity: owner ? undefined : identity,
    });
    server = gateway.app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const jars = () => {
    const cookies = new Map<string, string>();
    return async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("host", "mcp.example.test");
      headers.set("x-forwarded-proto", "https");
      headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
      const response = await new Promise<Response>((resolve, reject) => {
        const req = httpRequest(
          base + path,
          { method: init.method ?? "GET", headers: Object.fromEntries(headers) },
          (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on("data", (chunk) => chunks.push(chunk));
            incoming.on("end", () => {
              const responseHeaders = new Headers();
              for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
              resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: responseHeaders }));
            });
          },
        );
        req.on("error", reject);
        req.end(init.body?.toString());
      });
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(";");
        const pos = pair.indexOf("=");
        cookies.set(pair.slice(0, pos), pair.slice(pos + 1));
      }
      return response;
    };
  };
  const form = (data: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
  });
  async function authorize(login: string, beforeConsent?: () => void) {
    const request = jars();
    const registered = await request("/oauth/reg", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.example/callback"],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        client_name: "<script>alert(1)</script>",
      }),
    });
    assert.equal(registered.status, 201, await registered.clone().text());
    const client = await registered.json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    let response = await request(
      `/oauth/auth?${new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://client.example/callback", response_type: "code", scope: "mcp:tools", resource: `${origin}/mcp`, code_challenge: challenge, code_challenge_method: "S256" })}`,
    );
    for (let i = 0; i < 12; i++) {
      const location = response.headers.get("location");
      assert.ok(location, await response.clone().text());
      if (location.startsWith("https://client.example/callback")) {
        const code = new URL(location).searchParams.get("code");
        assert.ok(code, location);
        const exchanged = await request(
          "/oauth/token",
          form({
            grant_type: "authorization_code",
            client_id: client.client_id,
            code,
            code_verifier: verifier,
            redirect_uri: "https://client.example/callback",
            resource: `${origin}/mcp`,
          }),
        );
        assert.equal(exchanged.status, 200, await exchanged.clone().text());
        const tokens = await exchanged.json();
        return { tokens, client, request };
      }
      const target = new URL(location, origin);
      response = await request(target.pathname + target.search);
      if (target.pathname.startsWith("/interaction/") && response.status === 200) {
        const html = await response.text();
        assert.equal(html.includes("<script>alert(1)</script>"), false);
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
        assert.ok(csrf);
        if (beforeConsent && html.includes(">Разрешить доступ</button>")) {
          beforeConsent();
          beforeConsent = undefined;
          const stale = await request(target.pathname, form({ csrf, approve: "yes" }));
          assert.equal(stale.status, 403, "Stale displayed policy cannot grant new permissions");
          const updated = await request(target.pathname);
          const freshHtml = await updated.text();
          assert.match(freshHtml, /Чтение и изменение/);
          const freshCsrf = /name="csrf" value="([^"]+)"/.exec(freshHtml)?.[1];
          assert.ok(freshCsrf);
          assert.notEqual(freshCsrf, csrf);
          response = await request(target.pathname, form({ csrf: freshCsrf, approve: "yes" }));
        } else response = await request(target.pathname, form({ csrf, login, password, approve: "yes" }));
      }
    }
    throw new Error("OAuth did not complete");
  }
  const rpc = async (tokens: { access_token: string }, method: string, params?: unknown) =>
    jars()("/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${tokens.access_token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const refresh = async (issued: Awaited<ReturnType<typeof authorize>>) =>
    issued.request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: issued.client.client_id,
        refresh_token: issued.tokens.refresh_token,
        resource: `${origin}/mcp`,
      }),
    );
  const stop = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await gateway.close();
  };
  await start();
  return {
    store,
    auth,
    alice,
    bob,
    identity,
    calls,
    authorize,
    rpc,
    refresh,
    start,
    stop,
    close: async () => {
      await stop();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("tokens route to their owner; read list and call agree and onboarding is browser only", async () => {
  const s = await setup();
  try {
    s.store.putEncryptedSession(s.alice.userId, "encrypted-A");
    s.store.putEncryptedSession(s.bob.userId, "encrypted-B");
    const a = await s.authorize("alice"),
      b = await s.authorize("bob");
    const list = await s.rpc(a.tokens, "tools/list");
    assert.equal(list.status, 200);
    const value = await list.json();
    const names = value.result.tools.map((tool: { name: string }) => tool.name);
    assert.ok(names.includes("telegram-read-messages"));
    assert.equal(names.includes("telegram-send-message"), false);
    assert.equal(names.includes("telegram-login"), false);
    assert.equal(names.includes("telegram-logout"), false);
    const denied = await s.rpc(a.tokens, "tools/call", {
      name: "telegram-send-message",
      arguments: { chatId: "123", text: "never sent" },
    });
    assert.equal(s.calls.length, 0);
    const deniedBody = await denied.json();
    assert.ok(deniedBody.result?.isError || deniedBody.error);
    for (const issued of [a, b]) {
      const called = await s.rpc(issued.tokens, "tools/call", {
        name: "telegram-status",
        arguments: { userId: s.bob.userId },
      });
      assert.equal(called.status, 200);
    }
    assert.deepEqual(
      s.calls.map((call) => call.userId),
      [s.alice.userId, s.bob.userId],
    );
  } finally {
    await s.close();
  }
});
test("before Telegram setup only status is available; invalid grants and inactive users fail closed", async () => {
  const s = await setup();
  try {
    const a = await s.authorize("alice");
    const listed = await (await s.rpc(a.tokens, "tools/list")).json();
    assert.deepEqual(
      listed.result.tools.map((tool: { name: string }) => tool.name),
      ["telegram-status"],
    );
    const grant = s.store.listGrants(s.alice.userId)[0];
    assert.ok(grant);
    s.store.revokeGrant(s.alice.userId, grant.grantId);
    s.store.bindGrant(s.bob.userId, grant.grantId, grant.clientId, 1);
    assert.equal(
      (
        await s.rpc(a.tokens, "initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1" },
        })
      ).status,
      401,
    );
    const refresh = await s.refresh(a);
    assert.equal(refresh.status, 400);
    assert.equal((await refresh.json()).error, "invalid_grant");
    const b = await s.authorize("bob");
    s.store.disableUser(s.bob.userId);
    assert.equal((await s.rpc(b.tokens, "tools/list")).status, 401);
    assert.equal((await s.refresh(b)).status, 400);
  } finally {
    await s.close();
  }
});
test("policy changes invalidate existing access and refresh even if provider cleanup never runs", async () => {
  const s = await setup();
  try {
    const a = await s.authorize("alice");
    s.store.updatePolicy(s.alice.userId, { profile: "full", chatIds: [], version: 0 });
    assert.equal((await s.rpc(a.tokens, "tools/list")).status, 401);
    const refreshed = await s.refresh(a);
    assert.equal(refreshed.status, 400);
    assert.equal((await refreshed.json()).error, "invalid_grant");
    s.store.putEncryptedSession(s.alice.userId, "encrypted-A");
    const fresh = await s.authorize("alice");
    const list = await (await s.rpc(fresh.tokens, "tools/list")).json();
    assert.ok(list.result.tools.some((tool: { name: string }) => tool.name === "telegram-send-message"));
  } finally {
    await s.close();
  }
});
test("old owner grant never becomes a guest grant when switching to SaaS", async () => {
  const s = await setup();
  try {
    await s.stop();
    await s.start(true);
    const legacy = await s.authorize("owner");
    await s.stop();
    await s.start();
    assert.equal((await s.rpc(legacy.tokens, "tools/list")).status, 401);
    const refreshed = await s.refresh(legacy);
    assert.equal(refreshed.status, 400);
    assert.equal((await refreshed.json()).error, "invalid_grant");
    assert.equal(s.calls.length, 0);
  } finally {
    await s.close();
  }
});

test("a policy changed after the consent page requires a fresh displayed consent", async () => {
  const s = await setup();
  try {
    await s.authorize("alice", () =>
      s.store.updatePolicy(s.alice.userId, { profile: "full", chatIds: [], version: 0 }),
    );
    assert.equal(s.store.listGrants(s.alice.userId).length, 1);
  } finally {
    await s.close();
  }
});

test("recovery fences remembered OAuth cookies and already displayed consent", async () => {
  const s = await setup();
  try {
    const a = await s.authorize("alice");
    async function consent() {
      let response = await a.request(
        "/oauth/auth?" +
          new URLSearchParams({
            client_id: a.client.client_id,
            redirect_uri: "https://client.example/callback",
            response_type: "code",
            scope: "mcp:tools",
            resource: `${origin}/mcp`,
            code_challenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
            code_challenge_method: "S256",
            prompt: "consent",
          }),
      );
      for (let i = 0; i < 8; i++) {
        const location = response.headers.get("location");
        assert.ok(location);
        const url = new URL(location, origin);
        assert.equal(url.origin, origin);
        response = await a.request(url.pathname + url.search);
        if (url.pathname.startsWith("/interaction/") && response.status === 200)
          return { path: url.pathname, html: await response.text() };
      }
      throw new Error("No interaction");
    }
    const stale = await consent();
    assert.match(stale.html, />Разрешить доступ<\/button>/);
    assert.ok(await s.auth.recover("alice", s.alice.recoveryCodes[0], "a new recovered account password"));
    const csrf = /name="csrf" value="([^"]+)"/.exec(stale.html)?.[1];
    assert.ok(csrf);
    const posted = await a.request(stale.path, {
      method: "POST",
      headers: { origin, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf, approve: "yes" }),
    });
    assert.ok(posted.status >= 400, "Old consent cannot mint another grant after recovery");
    const fresh = await consent();
    assert.match(fresh.html, /autocomplete="current-password"/, "Old OAuth cookie requires fresh password");
  } finally {
    await s.close();
  }
});
