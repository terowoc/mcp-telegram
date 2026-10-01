import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { SaasAuth } from "../saas/auth.js";
import { BootstrapContexts } from "../saas/bootstrap-contexts.js";
import { createSaasRoutes } from "../saas/routes.js";
import { SessionVault } from "../saas/session-vault.js";
import { createSaasStore } from "../saas/store.js";
import { TelegramAuthAttempts } from "../saas/telegram-auth-attempts.js";
import type { TelegramAuthEvent } from "../saas/telegram-auth-protocol.js";
import { createTelegramAuthRoutes } from "../saas/telegram-auth-routes.js";
import { CapacityError } from "../saas/worker-budget.js";

const origin = "https://mcp.example.test";
async function setup() {
  const store = createSaasStore(":memory:"),
    auth = new SaasAuth(store, { csrfKey: randomBytes(32) }),
    vault = new SessionVault(randomBytes(32));
  const contexts = new BootstrapContexts({ csrfKey: randomBytes(32) });
  let full = false,
    started = 0;
  const callbacks = new Map<string, (e: TelegramAuthEvent) => void>();
  const attempts = new TelegramAuthAttempts({
    auth,
    store,
    vault,
    createWorker: () => ({
      start: async (id: string, event: (e: TelegramAuthEvent) => void) => {
        if (full) throw new CapacityError();
        started++;
        callbacks.set(id, event);
        event({ type: "token", token: "AQID", expiresAt: Date.now() + 30000 });
      },
      submitPassword: () => {},
      dispose: async () => {},
    }),
  });
  const router = createTelegramAuthRoutes({
    auth,
    store,
    vault,
    attempts,
    contexts,
    publicUrl: origin,
    revokeGrants: async () => {},
  });
  const saas = createSaasRoutes({
    auth,
    store,
    publicUrl: origin,
    revokeGrants: async () => {},
    supervisor: {
      prepareLogin: async () => {},
      startLogin: async () => {},
      submitPassword: () => {},
      cancelLogin: async () => {},
      stopUser: async () => {},
      status: () => ({ state: "stopped", busy: false, sessionPresent: false }),
    },
  });
  const app = express();
  app.set("trust proxy", 1);
  app.use("/api/saas/telegram-auth", router);
  app.use("/api/saas", saas);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/saas`;
  function jar(ip = "192.0.2.1") {
    const cookies = new Map<string, string>();
    let csrf = "";
    async function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
      const res = await fetch(base + path, {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          "x-forwarded-for": ip,
          cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
          "x-csrf-token": csrf,
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      for (const cookie of res.headers.getSetCookie()) {
        const pair = cookie.split(";", 1)[0],
          pos = pair.indexOf("=");
        cookies.set(pair.slice(0, pos), pair.slice(pos + 1));
      }
      return res;
    }
    return {
      request,
      context: async () => {
        const res = await request("/telegram-auth/start", "POST", {});
        assert.equal(res.status, 200);
        const body = await res.json();
        csrf = body.csrfToken;
        return res;
      },
      start: async () => {
        const res = await request("/telegram-auth/start", "POST", {});
        return { res, body: await res.json() };
      },
      legacy: async (login: string, password: string) => {
        const res = await request("/login", "POST", { login, password });
        assert.equal(res.status, 200);
      },
      setCsrf: (value: string) => {
        csrf = value;
      },
    };
  }
  return {
    store,
    auth,
    vault,
    attempts,
    jar,
    started: () => started,
    setFull: () => {
      full = true;
    },
    verify: (id: string, accountId = "12345") =>
      callbacks.get(id)?.({
        type: "verified",
        proof: { attemptId: id, account: { id: accountId }, session: "server-secret", authenticatedAt: Date.now() },
      }),
    close: async () => {
      await router.close();
      await saas.close();
      contexts.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      store.close();
    },
  };
}

test("initial_context_does_not_spawn and wrong origin cannot start", async () => {
  const f = await setup();
  try {
    const jar = f.jar(),
      res = await jar.context();
    assert.equal(f.started(), 0);
    assert.match(res.headers.get("set-cookie") ?? "", /HttpOnly/);
    assert.equal(
      (await jar.request("/telegram-auth/start", "POST", {}, { origin: "https://evil.example" })).status,
      403,
    );
    const { res: started, body } = await jar.start();
    assert.equal(started.status, 201);
    assert.equal(body.state, "token");
    assert.equal((await f.jar().request(`/telegram-auth/${body.id}`)).status, 401);
    const other = f.jar();
    await other.context();
    assert.equal((await other.request(`/telegram-auth/${body.id}`)).status, 404);
    assert.equal(JSON.stringify(body).includes("server-secret"), false);
  } finally {
    await f.close();
  }
});
test("verified completion issues one secure cabinet cookie and denies replay", async () => {
  const f = await setup();
  try {
    const jar = f.jar();
    await jar.context();
    const { body } = await jar.start();
    assert.equal((await jar.request(`/telegram-auth/${body.id}/complete`, "POST", { id: "victim" })).status, 409);
    f.verify(body.id);
    const res = await jar.request(`/telegram-auth/${body.id}/complete`, "POST", {});
    assert.equal(res.status, 200);
    const signed = await res.json();
    jar.setCsrf(signed.csrfToken);
    assert.match(res.headers.get("set-cookie") ?? "", /__Host-mcp-saas/);
    const me = await (await jar.request("/me")).json();
    assert.equal(me.user.hasPassword, false);
    assert.equal(me.telegram.sessionPresent, false);
    assert.equal(f.store.getTelegramAccount(me.user.id)?.id, "12345");
    assert.equal((await jar.request(`/telegram-auth/${body.id}/complete`, "POST", {})).status, 401);
  } finally {
    await f.close();
  }
});
test("legacy_link_checks_cookie_fresh_password_and_server_id", async () => {
  const f = await setup();
  try {
    const old = await f.auth.register("alice", "a long private legacy password");
    f.store.putEncryptedSession(old.userId, f.vault.encrypt(old.userId, "old"));
    f.store.putTelegramAccount(old.userId, { id: "12345" });
    const jar = f.jar();
    await jar.legacy("alice", "a long private legacy password");
    await jar.context();
    const result = await jar.start();
    f.verify(result.body.id);
    assert.equal(
      (await jar.request(`/telegram-auth/${result.body.id}/complete`, "POST", { legacyPassword: "wrong" })).status,
      403,
    );
    assert.equal(f.store.findByTelegramId("12345"), undefined);
    assert.equal(
      (
        await jar.request(`/telegram-auth/${result.body.id}/complete`, "POST", {
          legacyPassword: "a long private legacy password",
        })
      ).status,
      200,
    );
    assert.equal(f.store.findByTelegramId("12345")?.id, old.userId);
  } finally {
    await f.close();
  }
});
test("start_limits_and_shared_capacity_return_retry", async () => {
  const f = await setup();
  try {
    const jar = f.jar();
    await jar.context();
    f.setFull();
    const { res } = await jar.start();
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), "30");
  } finally {
    await f.close();
  }
});
test("actual start limits do not count context issuance", async () => {
  const f = await setup();
  try {
    const jar = f.jar();
    await jar.context();
    for (let i = 0; i < 5; i++) {
      const { res, body } = await jar.start();
      assert.equal(res.status, 201);
      assert.equal((await jar.request(`/telegram-auth/${body.id}`, "DELETE")).status, 204);
    }
    assert.equal((await jar.start()).res.status, 429);
  } finally {
    await f.close();
  }
});
test("passwordless deletion requires fresh server authentication and explicit confirmation", async () => {
  const f = await setup();
  try {
    const jar = f.jar();
    await jar.context();
    const { body } = await jar.start();
    f.verify(body.id);
    const signed = await (await jar.request(`/telegram-auth/${body.id}/complete`, "POST", {})).json();
    jar.setCsrf(signed.csrfToken);
    assert.equal((await jar.request("/account", "DELETE", {})).status, 403);
    assert.equal((await jar.request("/account", "DELETE", { confirm: true })).status, 204);
    assert.equal(f.store.findByTelegramId("12345"), undefined);
  } finally {
    await f.close();
  }
});
