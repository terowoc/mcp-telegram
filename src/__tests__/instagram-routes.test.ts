import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import type { InstagramSupervisor } from "../instagram/supervisor.js";
import { SaasAuth } from "../saas/auth.js";
import { createSaasRoutes } from "../saas/routes.js";
import { createSaasStore } from "../saas/store.js";

test("Instagram browser routes enforce CSRF/ownership and omit all session secrets", async () => {
  const store = createSaasStore(":memory:"),
    auth = new SaasAuth(store, { csrfKey: randomBytes(32) }),
    origin = "http://localhost";
  const a = await auth.register("alice", "a private password long enough"),
    b = await auth.register("bobby", "a private password long enough");
  const stopped: string[] = [];
  const ig = {
    status: () => ({ state: "stopped", sessionPresent: false }),
    startLogin: async () => ({ id: randomUUID(), state: "starting", expiresAt: Date.now() + 300000 }),
    stop: async (id: string) => {
      stopped.push(id);
    },
    purge: async (id: string) => {
      store.instagram.finishRemoval(id);
    },
    clearOwner: async (owner: string, all: boolean) => {
      if (all) {
        assert.equal(store.findUser(owner)?.disabled, true);
        assert.equal(store.instagram.get(owner, store.instagram.ownedIds(owner)[0]), undefined);
      }
    },
    cancelLogin: async () => {},
    attempt: () => undefined,
  } as unknown as InstagramSupervisor;
  const telegram = {
    status: () => ({ state: "stopped" as const, busy: false, sessionPresent: false }),
    prepareLogin: async () => {},
    startLogin: async () => {},
    submitPassword: () => {},
    cancelLogin: async () => {},
    stopUser: async () => {},
  };
  const router = createSaasRoutes({
    store,
    auth,
    supervisor: telegram,
    publicUrl: origin,
    revokeGrants: async () => {},
    instagram: ig,
  });
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = "GET", body?: unknown, session = a, csrf = true) =>
    fetch(base + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        cookie: `__Host-mcp-saas=${session.sessionToken}`,
        ...(csrf ? { "x-csrf-token": session.csrfToken } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  try {
    assert.equal((await request("/instagram/accounts", "POST", { label: "Personal" }, a, false)).status, 403);
    const created = await request("/instagram/accounts", "POST", { label: "Personal" });
    assert.equal(created.status, 201);
    const c = (await created.json()).account;
    assert.equal(
      (await request(`/instagram/accounts/${c.id}/login`, "POST", { username: "alice", password: "private" }, b))
        .status,
      404,
    );
    const login = await request(`/instagram/accounts/${c.id}/login`, "POST", {
      username: "alice",
      password: "private",
    });
    assert.equal(login.status, 202);
    assert.doesNotMatch(await login.text(), /password|private/);
    assert.equal(
      (
        await request(`/instagram/accounts/${c.id}/login`, "POST", {
          username: "alice",
          password: "private",
          surprise: "oops",
        })
      ).status,
      400,
    );
    const row = store.instagram.get(a.userId, c.id)!;
    store.instagram.save(a.userId, c.id, row.generation, "secret-envelope", { id: "123", username: "alice" });
    const me = await (await request("/me")).text();
    assert.doesNotMatch(me, /secret-envelope/);
    assert.match(me, /instagram/);
    store.bindGrant(a.userId, "grant", "client", store.findUser(a.userId)!.policy.version);
    assert.equal(
      (
        await request(`/instagram/accounts/${c.id}/policy`, "PUT", {
          profile: "full",
          threadIds: ["123456789012345678901234567890"],
        })
      ).status,
      200,
    );
    assert.equal(store.findGrant("grant"), undefined);
    assert.equal((await request(`/instagram/accounts/${c.id}/disconnect`, "POST", {})).status, 204);
    assert.equal(store.instagram.get(a.userId, c.id)?.envelope, undefined);
    assert.ok(stopped.includes(c.id));
    assert.equal((await request("/account", "DELETE", { password: "a private password long enough" })).status, 204);
    assert.equal(store.findUser(a.userId), undefined);
    assert.equal(store.instagram.ownedIds(a.userId).length, 0);
  } finally {
    await router.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
  }
});

test("cabinet deletion drains a real pending Instagram login before deleting its owner", async () => {
  const { InstagramSupervisor } = await import("../instagram/supervisor.js");
  const { InstagramVault } = await import("../instagram/vault.js");
  const { WorkerBudget } = await import("../saas/worker-budget.js");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const store = createSaasStore(":memory:"),
    auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
  const a = await auth.register("alice", "a private password long enough");
  const connection = store.instagram.create(a.userId, "Personal");
  const root = await mkdtemp(join(tmpdir(), "ig-deletion-"));
  const budget = new WorkerBudget(1);
  const ig = new InstagramSupervisor({
    store: store.instagram,
    vault: new InstagramVault(randomBytes(32)),
    budget,
    python: process.execPath,
    workerPath: fileURLToPath(new URL("./fixtures/instagram-worker.mjs", import.meta.url)),
    filesRoot: root,
    idleMs: 10000,
  });
  const attempt = await ig.startLogin(a.userId, connection.id, { username: "code", password: "private" });
  for (let i = 0; i < 50 && ig.attempt(a.userId, connection.id, attempt.id)?.state !== "needs-code"; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(ig.attempt(a.userId, connection.id, attempt.id)?.state, "needs-code");
  const origin = "http://localhost";
  const telegram = {
    status: () => ({ state: "stopped" as const, busy: false, sessionPresent: false }),
    prepareLogin: async () => {},
    startLogin: async () => {},
    submitPassword: () => {},
    cancelLogin: async () => {},
    stopUser: async () => {},
  };
  const router = createSaasRoutes({
    store,
    auth,
    supervisor: telegram,
    instagram: ig,
    publicUrl: origin,
    revokeGrants: async () => {},
  });
  const app = express();
  app.use(router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/account`, {
      method: "DELETE",
      headers: {
        origin,
        "content-type": "application/json",
        cookie: `__Host-mcp-saas=${a.sessionToken}`,
        "x-csrf-token": a.csrfToken,
      },
      body: JSON.stringify({ password: "a private password long enough" }),
    });
    assert.equal(response.status, 204);
    assert.equal(budget.isFull(), false);
    assert.equal(store.findUser(a.userId), undefined);
    assert.equal(store.instagram.ownedIds(a.userId).length, 0);
    assert.throws(() => ig.submitCode(a.userId, connection.id, attempt.id, "123456"));
  } finally {
    await router.close();
    await ig.close();
    await new Promise<void>((r) => server.close(() => r()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
