import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboard } from "./helpers/dashboard.js";

const id = "e1b079c5-d151-4177-a316-cc12a73aa876";
function cabinet(connected = false) {
  return {
    user: { id: "owner", login: "alice", hasPassword: true },
    csrfToken: "token",
    policy: { profile: "read", chatIds: [], version: 1 },
    telegram: { state: "stopped", busy: false, sessionPresent: false },
    mcpUrl: "https://mcp.test/mcp",
    instagram: {
      enabled: true,
      accounts: [
        {
          id,
          label: "<Personal>",
          policy: { profile: "read", threadIds: [] },
          removalPending: false,
          instagram: {
            state: "stopped",
            busy: false,
            sessionPresent: connected,
            account: connected ? { id: "123", username: "alice" } : undefined,
          },
        },
      ],
    },
  };
}
test("Instagram-only connection can reach MCP setup with escaped account labels", async () => {
  const d = await dashboard(
    (path) => new Response(JSON.stringify(path === "/me" ? cabinet(true) : { attempt: undefined }), { status: 200 }),
  );
  await d.hash("#mcp");
  assert.match(d.html(), /https:\/\/mcp.test\/mcp/);
  await d.hash("#instagram");
  assert.match(d.html(), /Instagram/);
  assert.match(d.html(), /&lt;Personal&gt;/);
  assert.doesNotMatch(d.html(), /<Personal>/);
});
test("Instagram password/code submissions use explicit routes and clear sensitive fields", async () => {
  const calls: { path: string; body: unknown }[] = [];
  const d = await dashboard((path, method, body) => {
    if (path === "/me") return new Response(JSON.stringify(cabinet()));
    if (path.endsWith("/login") && method === "POST") {
      calls.push({ path, body });
      return new Response(JSON.stringify({ id: "attempt", state: "needs-code", expiresAt: Date.now() + 300000 }), {
        status: 202,
      });
    }
    if (path.endsWith("/code")) {
      calls.push({ path, body });
      return new Response(null, { status: 202 });
    }
    return new Response(JSON.stringify({ attempt: undefined }));
  });
  await d.hash("#instagram");
  await d.submit("instagramLoginForm", { username: "alice", instagramPassword: "private-password" });
  assert.equal(calls[0].path, `/instagram/accounts/${id}/login`);
  assert.deepEqual(calls[0].body, { username: "alice", password: "private-password" });
  assert.doesNotMatch(d.html(), /private-password/);
  assert.equal(d.field("instagramPassword"), undefined);
  await d.submit("instagramCodeForm", { instagramCode: "123456" });
  assert.equal(calls[1].path, `/instagram/accounts/${id}/login/attempt/code`);
  assert.doesNotMatch(d.html(), /value="123456"/);
});
test("disabled Instagram cannot open through a saved hash", async () => {
  const state = cabinet();
  state.instagram.enabled = false;
  const d = await dashboard(() => new Response(JSON.stringify(state)), { hash: "#instagram" });
  assert.match(d.html(), /telegramForm|Подключить Telegram|QR/);
  assert.doesNotMatch(d.html(), /instagramLoginForm/);
});
test("Instagram login errors explain cabinet reauthentication", async () => {
  const d = await dashboard((path) =>
    path === "/me"
      ? new Response(JSON.stringify(cabinet()))
      : new Response(JSON.stringify({ error: "reauthentication-required" }), { status: 403 }),
  );
  await d.hash("#instagram");
  await d.submit("instagramLoginForm", { username: "alice", instagramPassword: "private-password" });
  assert.match(d.html(), /Войдите в кабинет снова/);
});
