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
import { BootstrapContexts } from "../saas/bootstrap-contexts.js";
import { createSaasIdentity } from "../saas/identity.js";
import { OAuthContinuations } from "../saas/oauth-continuations.js";
import { createSaasStore } from "../saas/store.js";

const origin = "https://mcp.example.test",
  password = "a very private SaaS test password";
async function setup(unified = false) {
  const dir = await mkdtemp(join(tmpdir(), "saas-oauth-"));
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: Buffer.alloc(32, 1) });
  const alice = await auth.register("alice", password),
    bob = await auth.register("bob", password);
  const contexts = new BootstrapContexts({ csrfKey: randomBytes(32) });
  const continuations = new OAuthContinuations();
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
      cabinetLogin: unified ? { contexts, continuations } : undefined,
    });
    server = gateway.app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  const jars = (cabinetToken?: string) => {
    const cookies = new Map<string, string>();
    if (cabinetToken) cookies.set("__Host-mcp-saas", cabinetToken);
    const request = async (path: string, init: RequestInit = {}) => {
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
    request.setCabinet = (token: string) => cookies.set("__Host-mcp-saas", token);
    return request;
  };
  const form = (data: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(data),
  });
  async function authorize(
    login: string,
    beforeConsent?: () => void,
    cabinetToken?: string,
    params: Record<string, string> = {},
  ) {
    const request = jars(cabinetToken);
    let freshLogins = 0;
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
      `/oauth/auth?${new URLSearchParams({ client_id: client.client_id, redirect_uri: "https://client.example/callback", response_type: "code", scope: "mcp:tools", resource: `${origin}/mcp`, code_challenge: challenge, code_challenge_method: "S256", ...params })}`,
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
        let html = await response.text();
        if (unified && html.includes("mcp_login=")) {
          assert.equal(++freshLogins, 1, "Only the login interaction may require a fresh login");
          await new Promise((resolve) => setTimeout(resolve, 5));
          const fresh = await auth.login(login, password);
          assert.ok(fresh);
          request.setCabinet(fresh.sessionToken);
          html = await (await request(target.pathname)).text();
        }
        assert.equal(html.includes("<script>alert(1)</script>"), false);
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
        assert.ok(csrf);
        if (cabinetToken) assert.equal(html.includes('autocomplete="current-password"'), false);
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
        } else
          response = await request(
            target.pathname,
            form({
              csrf,
              login,
              password,
              approve: "yes",
              ...(html.includes('name="use_session"') ? { use_session: "yes" } : {}),
            }),
          );
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
    jars,
    contexts,
    continuations,
    calls,
    authorize,
    rpc,
    refresh,
    start,
    stop,
    close: async () => {
      await stop();
      contexts.close();
      continuations.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}
test("existing_cabinet_cookie_skips_password_but_not_consent", async () => {
  const s = await setup(true);
  try {
    const a = await s.authorize("alice", undefined, s.alice.sessionToken);
    assert.equal(s.store.listGrants(s.alice.userId).length, 1);
    assert.equal(s.store.listGrants(s.bob.userId).length, 0);
    assert.equal((await s.rpc(a.tokens, "tools/list")).status, 200);
  } finally {
    await s.close();
  }
});
async function loginInteraction(
  s: Awaited<ReturnType<typeof setup>>,
  params: Record<string, string> = {},
  token?: string,
) {
  const request = s.jars(token);
  const registered = await request("/oauth/reg", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: ["https://client.example/callback"],
      response_types: ["code"],
      grant_types: ["authorization_code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const client = await registered.json();
  let response = await request(
    "/oauth/auth?" +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: "https://client.example/callback",
        response_type: "code",
        scope: "mcp:tools",
        resource: origin + "/mcp",
        code_challenge: createHash("sha256").update("x".repeat(43)).digest("base64url"),
        code_challenge_method: "S256",
        ...params,
      }),
  );
  for (let i = 0; i < 8; i++) {
    const location = response.headers.get("location");
    assert.ok(location);
    const target = new URL(location, origin);
    if (target.origin !== origin) return { request, path: target.href, html: "", response };
    response = await request(target.pathname + target.search);
    if (target.pathname.startsWith("/interaction/"))
      return { request, path: target.pathname, html: await response.text(), response };
  }
  throw new Error("Missing login interaction");
}
test("prompt_login_and_max_age_require_new_proof even when cookie was initially absent", async () => {
  for (const params of [{ prompt: "login" }, { max_age: "0", scope: "openid mcp:tools" }]) {
    const s = await setup(true);
    try {
      const flow = await loginInteraction(s, params);
      assert.match(flow.html, /mcp_login=/, JSON.stringify({ params, path: flow.path }));
      await new Promise((r) => setTimeout(r, 5));
      const fresh = await s.auth.login("alice", password);
      assert.ok(fresh);
      flow.request.setCabinet(fresh.sessionToken);
      const page = await flow.request(flow.path),
        html = await page.text();
      assert.match(
        html,
        /name="use_session"/,
        "A fresh login must return to this interaction without another login loop",
      );
    } finally {
      await s.close();
    }
  }
});
test("fresh OAuth login reaches consent and token without a second reauthentication", async () => {
  for (const params of [{ prompt: "login" }, { max_age: "0", scope: "openid mcp:tools" }]) {
    const s = await setup(true);
    try {
      const issued = await s.authorize("alice", undefined, s.alice.sessionToken, params);
      assert.equal((await s.rpc(issued.tokens, "tools/list")).status, 200);
      assert.equal(s.store.listGrants(s.alice.userId).length, 1);
    } finally {
      await s.close();
    }
  }
});
test("prompt_none_returns_login_required", async () => {
  const s = await setup(true);
  try {
    const flow = await loginInteraction(s, { prompt: "none" });
    assert.equal(new URL(flow.path).searchParams.get("error"), "login_required");
  } finally {
    await s.close();
  }
});
test("credential_reset_during_continuation_denies_old_session and account switch invalidates displayed login", async () => {
  const s = await setup(true);
  try {
    const flow = await loginInteraction(s, {}, s.alice.sessionToken);
    const csrf = /name="csrf" value="([^"]+)"/.exec(flow.html)?.[1];
    assert.ok(csrf);
    flow.request.setCabinet(s.bob.sessionToken);
    assert.equal(
      (
        await flow.request(flow.path, {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf, use_session: "yes", approve: "yes" }),
        })
      ).status,
      403,
    );
    flow.request.setCabinet(s.alice.sessionToken);
    await s.auth.recover("alice", s.alice.recoveryCodes[0], "a new recovered private password");
    assert.equal(
      (
        await flow.request(flow.path, {
          method: "POST",
          headers: { origin, "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ csrf, use_session: "yes", approve: "yes" }),
        })
      ).status,
      403,
    );
  } finally {
    await s.close();
  }
});
test("expired_or_foreign_interaction_is_rejected and continuation cannot redirect off origin", async () => {
  const c = new OAuthContinuations();
  const input = {
    interactionUid: "validated_uid",
    clientId: "client",
    contextHash: "owner",
    expiresAt: Date.now() + 1000,
    requireFreshAuthentication: true,
  };
  assert.throws(() => c.create({ ...input, interactionUid: "https://evil.example/" }));
  const handle = c.create(input);
  assert.equal(c.consume(handle, "foreign"), undefined);
  assert.equal(c.consume(handle, "owner")?.interactionUid, "validated_uid");
  assert.equal(c.consume(handle, "owner"), undefined);
  const expired = c.create({ ...input, expiresAt: Date.now() - 1 });
  assert.equal(c.consume(expired, "owner"), undefined);
  c.close();
});
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

test("remembered OAuth session cannot silently authorize a switched or logged-out cabinet", async () => {
  const s = await setup(true);
  try {
    const first = await s.authorize("alice", undefined, s.alice.sessionToken);
    const params = {
      client_id: first.client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      scope: "mcp:tools",
      resource: origin + "/mcp",
      code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url"),
      code_challenge_method: "S256",
    };
    const same = await first.request("/oauth/auth?" + new URLSearchParams({ ...params, prompt: "none" }));
    assert.ok(
      new URL(same.headers.get("location")!, origin).searchParams.get("code"),
      "same active cabinet may reuse its grant",
    );
    first.request.setCabinet(s.bob.sessionToken);
    for (const prompt of ["none", ""]) {
      const response = await first.request(
        "/oauth/auth?" + new URLSearchParams({ ...params, ...(prompt ? { prompt } : {}) }),
      );
      const target = new URL(response.headers.get("location")!, origin);
      assert.equal(target.searchParams.get("code"), null);
      if (prompt) assert.equal(target.searchParams.get("error"), "login_required");
      else assert.equal(target.origin, origin);
    }
    first.request.setCabinet(s.alice.sessionToken);
    s.auth.logout(s.alice.sessionToken);
    const loggedOut = await first.request("/oauth/auth?" + new URLSearchParams({ ...params, prompt: "none" }));
    assert.equal(new URL(loggedOut.headers.get("location")!, origin).searchParams.get("error"), "login_required");
  } finally {
    await s.close();
  }
});
