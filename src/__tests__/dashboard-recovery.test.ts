import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboard } from "./helpers/dashboard.js";

const me = (id = "alice", connected = false) => ({
  user: { id, login: id, hasPassword: true },
  csrfToken: "csrf-fixture",
  policy: { profile: "read", chatIds: [], version: 1 },
  telegram: { state: "stopped", busy: false, sessionPresent: connected },
  mcpUrl: "https://mcp.example.test/mcp",
});
const qr = {
  id: "attempt-alice",
  state: "qr",
  dataUrl: "data:image/png;base64,fixture",
  expiresAt: Date.now() + 60000,
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("account login resumes the owner's existing QR without starting another Telegram session", async () => {
  let authenticated = false;
  const requests: string[] = [];
  const ui = await dashboard((path, method) => {
    requests.push(`${method} ${path}`);
    if (path === "/login") {
      authenticated = true;
      return json({});
    }
    if (path === "/me") return authenticated ? json(me()) : json({ error: "authentication-required" }, 401);
    if (path === "/telegram/login") return json({ attempt: qr });
    throw new Error(`Unexpected request ${method} ${path}`);
  });
  await ui.click("auth-login");
  await ui.submit("authForm", { login: "alice", password: "a sufficiently long fixture password" });
  assert.match(ui.html(), /data:image\/png;base64,fixture/);
  assert.ok(requests.includes("GET /telegram/login"));
  assert.equal(requests.includes("POST /telegram/login"), false);
});

test("QR success recovers after a transient status failure", async () => {
  let statusRequests = 0;
  const ui = await dashboard((path) => {
    if (path === "/me") {
      statusRequests++;
      return statusRequests === 2 ? json({ error: "capacity" }, 503) : json(me("alice", statusRequests > 2));
    }
    if (path === "/telegram/login") return json({ attempt: qr });
    if (path === `/telegram/login/${qr.id}`) return json({ ...qr, state: "success", dataUrl: undefined });
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.poll();
  await ui.poll();
  assert.match(ui.html(), /https:\/\/mcp\.example\.test\/mcp/);
  assert.doesNotMatch(ui.html(), /QR-код для подключения Telegram/);
});

test("a successful poll cannot restore the previous account after logout", async () => {
  let releaseStatus!: (value: Response) => void;
  let statuses = 0;
  const ui = await dashboard((path) => {
    if (path === "/me")
      return ++statuses === 1
        ? json(me())
        : new Promise<Response>((r) => {
            releaseStatus = r;
          });
    if (path === "/telegram/login") return json({ attempt: qr });
    if (path === `/telegram/login/${qr.id}`) return json({ ...qr, state: "success", dataUrl: undefined });
    if (path === "/logout") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.poll();
  await ui.click("logout");
  releaseStatus(json(me("alice", true)));
  await ui.settle();
  assert.match(ui.html(), /С возвращением/);
  assert.doesNotMatch(ui.html(), /https:\/\/mcp\.example\.test\/mcp/);
});

test("switching cabinet accounts discards the old client's list", async () => {
  let account = "alice";
  const ui = await dashboard((path) => {
    if (path === "/me") return json(me(account, true));
    if (path === "/clients")
      return json({ clients: [{ grantId: "alice-grant", clientId: "alice-private-client", version: 1 }] });
    throw new Error(`Unexpected request ${path}`);
  });
  // Use the same public navigation event the browser emits.
  await ui.navigate("clients");
  assert.match(ui.html(), /alice-private-client/);
  account = "bob";
  await ui.focus();
  assert.doesNotMatch(ui.html(), /alice-private-client/);
  assert.match(ui.html(), /bob/);
});

test("registration keeps one-time recovery codes even if Telegram attempt lookup would fail", async () => {
  let registered = false;
  const ui = await dashboard((path) => {
    if (path === "/register") {
      registered = true;
      return json({ recoveryCodes: ["one-time-recovery-fixture"] }, 201);
    }
    if (path === "/me") return registered ? json(me()) : json({ error: "authentication-required" }, 401);
    if (path === "/telegram/login") return json({ error: "authentication-required" }, 401);
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.submit("authForm", { login: "alice", password: "a sufficiently long fixture password" });
  assert.ok(ui.html().includes("one-time-recovery-fixture"));
});

test("a delayed client list from the previous account is discarded after switching accounts", async () => {
  let statuses = 0;
  let releaseStatus!: (value: Response) => void;
  let releaseClients!: (value: Response) => void;
  const ui = await dashboard((path) => {
    if (path === "/me")
      return ++statuses === 1
        ? json(me("alice", true))
        : new Promise<Response>((r) => {
            releaseStatus = r;
          });
    if (path === "/clients")
      return new Promise<Response>((r) => {
        releaseClients = r;
      });
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.focus();
  await ui.navigate("clients");
  releaseStatus(json(me("bob", true)));
  await ui.settle();
  releaseClients(json({ clients: [{ grantId: "alice-grant", clientId: "alice-private-client", version: 1 }] }));
  await ui.settle();
  assert.match(ui.html(), /bob/);
  assert.equal(ui.html().includes("alice-private-client"), false);
});

test("a stale unauthorized focus response cannot discard a new account's recovery codes", async () => {
  let current = "alice";
  let releaseStatus!: (value: Response) => void;
  let statuses = 0;
  const ui = await dashboard((path) => {
    if (path === "/me") {
      if (++statuses === 2)
        return new Promise<Response>((r) => {
          releaseStatus = r;
        });
      return json(me(current, true));
    }
    if (path === "/logout") return new Response(null, { status: 204 });
    if (path === "/register") {
      current = "bob";
      return json({ recoveryCodes: ["bob-new-recovery-code"] }, 201);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.focus();
  await ui.click("logout");
  await ui.click("auth-register");
  await ui.submit("authForm", { login: "bob", password: "a sufficiently long fixture password" });
  assert.ok(ui.html().includes("bob-new-recovery-code"));
  releaseStatus(json({ error: "authentication-required" }, 401));
  await ui.settle();
  assert.ok(ui.html().includes("bob-new-recovery-code"));
});

test("a current login reports a failed cabinet refresh after successful authentication", async () => {
  let loggedIn = false;
  const ui = await dashboard((path) => {
    if (path === "/login") {
      loggedIn = true;
      return json({});
    }
    if (path === "/me")
      return loggedIn ? json({ error: "capacity" }, 503) : json({ error: "authentication-required" }, 401);
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.click("auth-login");
  await ui.submit("authForm", { login: "alice", password: "a sufficiently long fixture password" });
  assert.ok(ui.html().includes('role="alert"'));
  assert.ok(ui.html().includes("Сервер занят"));
});

test("QR status renders the new cabinet immediately when the browser account changes", async () => {
  let statuses = 0;
  const ui = await dashboard((path) => {
    if (path === "/me") return json(me(++statuses === 1 ? "alice" : "bob", statuses > 1));
    if (path === "/telegram/login") return json({ attempt: qr });
    if (path === `/telegram/login/${qr.id}`) return json({ ...qr, state: "success", dataUrl: undefined });
    throw new Error(`Unexpected request ${path}`);
  });
  await ui.poll();
  assert.ok(ui.html().includes("bob"));
  assert.equal(ui.html().includes("data:image/png;base64,fixture"), false);
});
