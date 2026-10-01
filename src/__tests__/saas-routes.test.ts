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
async function setup(ttlMs?: number, clientName?: (id: string) => Promise<string | undefined>) {
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
    clientName,
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
    assert.equal(me.policy.profile, "full");
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

test("retrying Telegram connect resumes one QR without consuming the new-login quota", async () => {
  const s = await setup();
  try {
    const a = s.jar();
    await a.register("alice");
    const started = await (await a.request("/telegram/login", "POST", {})).json();
    for (let i = 0; i < 6; i++) {
      const retry = await a.request("/telegram/login", "POST", {});
      assert.equal(retry.status, 202);
      assert.equal((await retry.json()).id, started.id);
    }
    assert.equal(s.supervisor.events.size, 1);
    assert.equal((await a.request(`/telegram/login/${started.id}`, "DELETE")).status, 204);
    const next = await a.request("/telegram/login", "POST", {});
    assert.equal(next.status, 202);
    assert.notEqual((await next.json()).id, started.id);
  } finally {
    await s.close();
  }
});

test("connect cannot replace an already linked Telegram session", async () => {
  const s = await setup();
  try {
    const a = s.jar();
    await a.register("alice");
    const user = s.store.findByLogin("alice");
    assert.ok(user);
    s.store.putEncryptedSession(user.id, "existing-encrypted-session");
    s.supervisor.status = () => ({ state: "stopped", busy: false, sessionPresent: true });
    const response = await a.request("/telegram/login", "POST", {});
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "telegram-already-connected" });
    assert.equal(s.supervisor.events.size, 0);
    assert.equal(s.store.getEncryptedSession(user.id), "existing-encrypted-session");
  } finally {
    await s.close();
  }
});

test("authenticated cabinet polling does not exhaust the anonymous global quota", async () => {
  const s = await setup();
  try {
    for (let account = 0; account < 6; account++) {
      const session = await s.auth.register(`user${account}`, password);
      const a = s.jar();
      for (let poll = 0; poll < 110; poll++) {
        const response = await a.request("/telegram/login", "GET", undefined, {
          cookie: `__Host-mcp-saas=${session.sessionToken}`,
        });
        assert.equal(response.status, 200);
      }
    }
    assert.equal((await s.jar().request("/me")).status, 401);
  } finally {
    await s.close();
  }
});

test("connect retries during worker startup share admission and do not spend extra QR quota", async () => {
  const s = await setup();
  let releaseStartup!: () => void;
  let preparing!: () => void;
  const prepared = new Promise<void>((resolve) => {
    preparing = resolve;
  });
  const startup = new Promise<void>((resolve) => {
    releaseStartup = resolve;
  });
  s.supervisor.prepareLogin = async () => {
    preparing();
    await startup;
  };
  try {
    const a = s.jar();
    await a.register("alice");
    const first = a.request("/telegram/login", "POST", {});
    await prepared;
    const retries = [a.request("/telegram/login", "POST", {}), a.request("/telegram/login", "POST", {})];
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseStartup();
    const responses = await Promise.all([first, ...retries]);
    const ids: string[] = [];
    for (const response of responses) {
      assert.equal(response.status, 202);
      ids.push((await response.json()).id);
    }
    assert.equal(new Set(ids).size, 1);
    assert.equal((await a.request(`/telegram/login/${ids[0]}`, "DELETE")).status, 204);
    assert.equal((await a.request("/telegram/login", "POST", {})).status, 202);
  } finally {
    releaseStartup();
    await s.close();
  }
});

test("genuinely new QR attempts still enforce quota after three starts", async () => {
  const s = await setup();
  try {
    const a = s.jar();
    await a.register("alice");
    for (let i = 0; i < 3; i++) {
      const started = await a.request("/telegram/login", "POST", {});
      assert.equal(started.status, 202);
      const id = (await started.json()).id;
      assert.equal((await a.request(`/telegram/login/${id}`, "DELETE")).status, 204);
    }
    const denied = await a.request("/telegram/login", "POST", {});
    assert.equal(denied.status, 429);
    assert.ok(denied.headers.get("retry-after"));
    assert.equal((await a.request("/me")).status, 200);
  } finally {
    await s.close();
  }
});

test("client labels use OAuth metadata only for the authenticated owner's grants", async () => {
  const s = await setup(undefined, async (id) => (id === "client-a" ? "Alice AI" : undefined));
  try {
    const a = s.jar(),
      b = s.jar();
    const alice = await a.register("alice"),
      bob = await b.register("bobby");
    s.store.bindGrant(alice.value.user.id, "grant-a", "client-a", 1);
    s.store.bindGrant(bob.value.user.id, "grant-b", "client-b", 1);
    const listed = await (await a.request("/clients")).json();
    assert.deepEqual(listed.clients, [{ grantId: "grant-a", clientId: "client-a", version: 1, name: "Alice AI" }]);
    const other = await (await b.request("/clients")).json();
    assert.deepEqual(other.clients, [{ grantId: "grant-b", clientId: "client-b", version: 1 }]);
  } finally {
    await s.close();
  }
});
