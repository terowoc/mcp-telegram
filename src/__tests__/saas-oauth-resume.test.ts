import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { SaasAuth } from "../saas/auth.js";
import { BootstrapContexts } from "../saas/bootstrap-contexts.js";
import { OAuthContinuations } from "../saas/oauth-continuations.js";
import { createSaasRoutes } from "../saas/routes.js";
import { createSaasStore } from "../saas/store.js";

const origin = "https://mcp.example.test";
test("OAuth resume requires cabinet CSRF and the continuation's own browser context", async () => {
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
  const contexts = new BootstrapContexts({ csrfKey: randomBytes(32) });
  const continuations = new OAuthContinuations();
  const user = await auth.register("alice", "long fixture account password");
  const routes = createSaasRoutes({
    auth,
    store,
    publicUrl: origin,
    oauth: { contexts, continuations },
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
  app.get("/fixture-context", (req, res) => {
    const context = contexts.ensure(req, res);
    res.json({
      continuation: continuations.create({
        contextHash: context.contextHash,
        clientId: "fixture",
        interactionUid: "known-interaction",
        expiresAt: Date.now() + 10000,
        requireFreshAuthentication: false,
      }),
    });
  });
  app.use("/api/saas", routes);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const bootstrap = await fetch(`${base}/fixture-context`);
    const contextCookie = bootstrap.headers.getSetCookie()[0].split(";")[0];
    const handle = (await bootstrap.json()).continuation;
    const cookie = `__Host-mcp-saas=${user.sessionToken}; ${contextCookie}`;
    const resume = (cookieHeader: string, csrf = user.csrfToken, requestOrigin = origin) =>
      fetch(`${base}/api/saas/oauth/resume`, {
        method: "POST",
        headers: {
          origin: requestOrigin,
          cookie: cookieHeader,
          "content-type": "application/json",
          "x-csrf-token": csrf,
        },
        body: JSON.stringify({ continuation: handle }),
      });
    assert.equal((await resume(cookie, "wrong")).status, 403);
    assert.equal((await resume(cookie, user.csrfToken, "https://evil.example")).status, 403);
    assert.equal((await resume(`__Host-mcp-saas=${user.sessionToken}`)).status, 409);
    const accepted = await resume(cookie);
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { continueTo: "/interaction/known-interaction" });
    assert.equal((await resume(cookie)).status, 409);
  } finally {
    await routes.close();
    contexts.close();
    continuations.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
  }
});
