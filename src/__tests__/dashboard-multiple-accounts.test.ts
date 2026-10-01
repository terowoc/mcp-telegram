import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboard } from "./helpers/dashboard.js";

const owner = "11111111-1111-4111-8111-111111111111",
  work = "22222222-2222-4222-8222-222222222222";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const account = (id: string, label: string, connected: boolean) => ({
  id,
  label,
  primary: id === owner,
  policy: { profile: "full", chatIds: [], version: 1 },
  telegram: { state: "stopped", busy: false, sessionPresent: connected },
});
test("dashboard adds a named account, starts its QR and sends its cloud password to the selected connection", async () => {
  const accounts = [account(owner, "Основной", true)];
  const requests: string[] = [];
  let state = "qr";
  const ui = await dashboard((path, method, body) => {
    requests.push(`${method} ${path}`);
    if (path.startsWith("/me")) {
      const selected = new URLSearchParams(path.split("?")[1]).get("telegramAccountId") ?? owner;
      const current = accounts.find((a) => a.id === selected);
      assert.ok(current);
      return json({
        user: { id: owner, login: "alice", hasPassword: true },
        csrfToken: "csrf",
        telegramAccountId: selected,
        accounts,
        policy: current.policy,
        telegram: current.telegram,
        mcpUrl: "https://mcp.test/mcp",
      });
    }
    if (path === "/telegram/accounts" && method === "POST") {
      assert.equal(body?.label, "Работа");
      accounts.push(account(work, "Работа", false));
      return json({ account: accounts[1] }, 201);
    }
    if (path === `/telegram/login?telegramAccountId=${work}`)
      return method === "POST"
        ? json({ id: "qr-work", state, dataUrl: "data:image/png;base64,work", expiresAt: Date.now() + 60000 })
        : json({});
    if (path === `/telegram/login/qr-work?telegramAccountId=${work}`)
      return json({
        id: "qr-work",
        state,
        dataUrl: state === "qr" ? "data:image/png;base64,work" : undefined,
        expiresAt: Date.now() + 60000,
      });
    if (path === `/telegram/login/qr-work/password?telegramAccountId=${work}`) {
      assert.equal(body?.password, "cloud-secret");
      return json({ ok: true }, 202);
    }
    throw new Error(`Unexpected ${method} ${path}`);
  });
  assert.match(ui.html(), /Telegram-аккаунты/);
  await ui.submit("addTelegramAccountForm", { label: "Работа" });
  assert.match(ui.html(), /data:image\/png;base64,work/);
  const inputIds = [...ui.html().matchAll(/<input[^>]*id="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(inputIds).size, inputIds.length, "Every label must target its own form's field");
  assert.ok(requests.includes(`POST /telegram/login?telegramAccountId=${work}`));
  state = "needs-password";
  await ui.poll();
  await ui.submit("telegramPasswordForm", { password: "cloud-secret" });
  assert.ok(requests.includes(`POST /telegram/login/qr-work/password?telegramAccountId=${work}`));
});

test("a stale selected-account status cannot replace the primary after 404 fallback", async () => {
  let selectedRequests = 0;
  let stale!: (value: Response) => void;
  const requests: string[] = [];
  const accounts = [account(owner, "Основной", true), account(work, "Work", true)];
  const me = (id: string) => ({
    user: { id: owner, login: "alice", hasPassword: true },
    csrfToken: "csrf",
    accounts,
    telegramAccountId: id,
    policy: accounts[0].policy,
    telegram: accounts[0].telegram,
    mcpUrl: "https://mcp.test/mcp",
  });
  const ui = await dashboard((path, method) => {
    requests.push(`${method} ${path}`);
    if (path === "/me") return json(me(owner));
    if (path === `/me?telegramAccountId=${work}`) {
      if (++selectedRequests === 1) return json(me(work));
      if (selectedRequests === 2)
        return new Promise<Response>((resolve) => {
          stale = resolve;
        });
      return json({ error: "not-found" }, 404);
    }
    if (path === "/telegram/disconnect") return new Response(null, { status: 204 });
    throw new Error(`Unexpected ${method} ${path}`);
  });
  await ui.click(`select-account:${work}`);
  await ui.focus();
  await ui.focus();
  stale(json(me(work)));
  await ui.settle();
  assert.match(ui.html(), new RegExp(`data-action="select-account:${owner}" aria-pressed="true"`));
  assert.doesNotMatch(ui.html(), new RegExp(`data-action="select-account:${work}" aria-pressed="true"`));
  await ui.navigate("telegram");
  await ui.click("disconnect");
  assert.ok(requests.includes("POST /telegram/disconnect"));
});
