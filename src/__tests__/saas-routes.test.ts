import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { SaasAuth } from "../saas/auth.js";
import { LoginAttempts } from "../saas/login-attempts.js";
import { createSaasRoutes } from "../saas/routes.js";
import { createSaasStore } from "../saas/store.js";
import { CapacityError } from "../saas/supervisor.js";
import type { LoginEvent } from "../saas/worker-protocol.js";

const origin = "https://mcp.example.test",
  password = "a private account test password";
class Supervisor {
  events = new Map<string, (event: LoginEvent) => void>();
  passwords: { userId: string; attemptId: string; password: string }[] = [];
  stopped: string[] = [];
  full = false;
  status() {
    return { state: "stopped" as const, busy: false, sessionPresent: false };
  }
  async prepareLogin() {
    if (this.full) throw new CapacityError();
  }
  async startLogin(userId: string, attemptId: string, onEvent: (e: LoginEvent) => void) {
    this.events.set(`${userId}:${attemptId}`, onEvent);
  }
  submitPassword(userId: string, attemptId: string, password: string) {
    this.passwords.push({ userId, attemptId, password });
  }
  async cancelLogin(userId: string, attemptId: string) {
    this.events.delete(`${userId}:${attemptId}`);
  }
  async stopUser(userId: string) {
    this.stopped.push(userId);
  }
}
async function setup(ttlMs?: number) {
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: Buffer.alloc(32, 1) });
  const supervisor = new Supervisor();
  const revoked: string[][] = [];
  const attempts = new LoginAttempts(supervisor, ttlMs ? { ttlMs, qrDeadlineMs: ttlMs } : undefined);
  const router = createSaasRoutes({
    auth,
    store,
    supervisor,
    attempts,
    publicUrl: origin,
    revokeGrants: async (ids) => {
      revoked.push(ids);
    },
  });
  const app = express();
  app.use("/api/saas", router);
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/saas`;
  function jar() {
    let cookie = "";
    let csrf = "";
    return {
      request: async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(base + path, {
          method,
          headers: { origin, "content-type": "application/json", cookie, "x-csrf-token": csrf, ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const set = response.headers.get("set-cookie");
        if (set) cookie = set.split(";", 1)[0];
        return response;
      },
      register: async (login: string) => {
        const response = await fetch(`${base}/register`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: JSON.stringify({ login, password }),
        });
        assert.equal(response.status, 201);
        cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
        const value = await response.json();
        csrf = value.csrfToken;
        return { value, cookie, cookieHeader: response.headers.get("set-cookie") ?? "" };
      },
    };
  }
  return {
    store,
    auth,
    supervisor,
    attempts,
    revoked,
    jar,
    close: async () => {
      await router.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
    },
  };
}
test("anonymous and cross origin mutations are denied; secure cookies and redacted DTOs", async () => {
  const s = await setup();
  try {
    const a = s.jar();
    assert.equal((await a.request("/me")).status, 401);
    assert.equal(
      (await a.request("/register", "POST", { login: "alice", password }, { origin: "https://evil.invalid" })).status,
      403,
    );
    const { value, cookie, cookieHeader } = await a.register("alice");
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /Secure/);
    assert.match(cookieHeader, /SameSite=Lax/);
    assert.match(cookie, /^__Host-mcp-saas=/);
    assert.equal(value.recoveryCodes.length, 8);
    const response = await a.request("/me");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const me = await response.json();
    assert.equal(me.user.login, "alice");
    assert.equal(me.policy.profile, "read");
    assert.equal(me.mcpUrl, `${origin}/mcp`);
    assert.equal(JSON.stringify(me).includes("passwordHash"), false);
    assert.equal(
      (await a.request("/policy", "PUT", { profile: "full", chatIds: [] }, { "x-csrf-token": "wrong" })).status,
      403,
    );
    assert.equal((await a.request("/logout", "POST", {}, { origin: "https://evil.invalid" })).status, 403);
  } finally {
    await s.close();
  }
});
test("foreign attempt and grant return 404 and no password reaches another user", async () => {
  const s = await setup();
  try {
    const a = s.jar(),
      b = s.jar();
    await a.register("alice");
    await b.register("bob");
    const user = s.store.findByLogin("alice");
    assert.ok(user);
    s.store.bindGrant(user.id, "grant-A", "client", 1);
    const started = await a.request("/telegram/login", "POST", {});
    assert.equal(started.status, 202);
    const attempt = await started.json();
    assert.equal((await b.request(`/telegram/login/${attempt.id}`)).status, 404);
    assert.equal(
      (await b.request(`/telegram/login/${attempt.id}/password`, "POST", { password: "private-cloud-password" }))
        .status,
      404,
    );
    assert.equal((await b.request("/clients/grant-A", "DELETE")).status, 404);
    assert.equal(s.supervisor.passwords.length, 0);
    assert.equal((await a.request("/clients")).status, 200);
  } finally {
    await s.close();
  }
});
test("QR password cancel and expiry are terminal and user bound", async () => {
  const s = await setup(150);
  try {
    const a = s.jar();
    await a.register("alice");
    const user = s.store.findByLogin("alice");
    assert.ok(user);
    const started = await (await a.request("/telegram/login", "POST", {})).json();
    assert.equal(
      (await a.request(`/telegram/login/${started.id}/password`, "POST", { password: "secret" })).status,
      409,
    );
    s.supervisor.events.get(`${user.id}:${started.id}`)?.({ type: "needs-password" });
    const accepted = await a.request(`/telegram/login/${started.id}/password`, "POST", { password: "secret" });
    assert.equal(accepted.status, 202);
    assert.deepEqual(await accepted.json(), { ok: true });
    assert.equal(s.supervisor.passwords[0].userId, user.id);
    assert.equal((await a.request(`/telegram/login/${started.id}`, "DELETE")).status, 204);
    assert.equal(
      (await a.request(`/telegram/login/${started.id}/password`, "POST", { password: "again" })).status,
      409,
    );
    s.supervisor.events.get(`${user.id}:${started.id}`)?.({ type: "success", account: { id: "1" } });
    assert.equal((await (await a.request(`/telegram/login/${started.id}`)).json()).state, "cancelled");
    const another = await (await a.request("/telegram/login", "POST", {})).json();
    await new Promise((resolve) => setTimeout(resolve, 180));
    assert.equal((await a.request(`/telegram/login/${another.id}`)).status, 404);
  } finally {
    await s.close();
  }
});
test("policy commits grant invalidation before worker stop and disconnect only clears owner session", async () => {
  const s = await setup();
  try {
    const a = s.jar(),
      b = s.jar();
    await a.register("alice");
    await b.register("bob");
    const alice = s.store.findByLogin("alice"),
      bob = s.store.findByLogin("bob");
    assert.ok(alice && bob);
    s.store.bindGrant(alice.id, "grant", "client", 1);
    s.store.putEncryptedSession(alice.id, "encrypted-A");
    s.store.putEncryptedSession(bob.id, "encrypted-B");
    s.supervisor.stopUser = async (id) => {
      assert.equal(s.store.findGrant("grant"), undefined);
      s.supervisor.stopped.push(id);
    };
    const update = await a.request("/policy", "PUT", { profile: "full", chatIds: ["123"], userId: bob.id });
    assert.equal(update.status, 200);
    assert.equal(s.store.findUser(alice.id)?.policy.version, 2);
    assert.equal(s.store.findUser(bob.id)?.policy.version, 1);
    assert.equal((await a.request("/telegram/disconnect", "POST", {})).status, 204);
    assert.equal(s.store.getEncryptedSession(alice.id), undefined);
    assert.equal(s.store.getEncryptedSession(bob.id), "encrypted-B");
  } finally {
    await s.close();
  }
});
test("account deletion requires password and purges active access; recovery revokes old sessions", async () => {
  const s = await setup();
  try {
    const a = s.jar();
    const { value } = await a.register("alice");
    const user = s.store.findByLogin("alice");
    assert.ok(user);
    s.store.bindGrant(user.id, "grant", "client", 1);
    assert.equal((await a.request("/account", "DELETE", { password: "wrong" })).status, 403);
    const recovered = await a.request("/recover", "POST", {
      login: "alice",
      recoveryCode: value.recoveryCodes[0],
      newPassword: `${password}new`,
    });
    assert.equal(recovered.status, 200);
    assert.equal((await a.request("/me")).status, 401);
    assert.equal(s.store.findGrant("grant"), undefined);
    const logged = await a.request("/login", "POST", { login: "alice", password: `${password}new` });
    assert.equal(logged.status, 200);
    const body = await logged.json();
    const deleted = await a.request(
      "/account",
      "DELETE",
      { password: `${password}new` },
      { "x-csrf-token": body.csrfToken },
    );
    assert.equal(deleted.status, 204);
    assert.equal(s.store.findUser(user.id), undefined);
    assert.equal((await a.request("/me")).status, 401);
  } finally {
    await s.close();
  }
});
test("capacity returns Retry-After and public registration is rate limited", async () => {
  const s = await setup();
  try {
    const a = s.jar();
    await a.register("alice");
    s.supervisor.full = true;
    const response = await a.request("/telegram/login", "POST", {});
    assert.equal(response.status, 503);
    assert.ok(response.headers.get("retry-after"));
    for (let i = 0; i < 4; i++)
      assert.equal((await a.request("/register", "POST", { login: `user${i}`, password })).status, 201);
    assert.equal((await a.request("/register", "POST", { login: "overflow", password })).status, 429);
  } finally {
    await s.close();
  }
});
