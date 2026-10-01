import assert from "node:assert/strict";
import { test } from "node:test";
import { dashboard } from "./helpers/dashboard.js";

const cabinet = {
  user: { id: "alice", login: "alice", hasPassword: true },
  csrfToken: "csrf",
  policy: { profile: "full", chatIds: ["123", "-100456"], version: 1 },
  telegram: { state: "stopped", busy: false, sessionPresent: true },
  mcpUrl: "https://mcp.example.test/mcp",
};
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

test("saving equivalent permissions does not revoke client access", async () => {
  const mutations: string[] = [];
  const ui = await dashboard((path, method) => {
    if (method !== "GET") mutations.push(path);
    return json(cabinet);
  });
  await ui.navigate("access");
  await ui.submit("policyForm", { profile: "full", chatIds: "-100456, 123, 123" });
  assert.deepEqual(mutations, []);
  assert.match(ui.html(), /Права уже сохранены/);
});

test("pending client requests show loading instead of a false empty state", async () => {
  let finish!: (response: Response) => void;
  const ui = await dashboard((path) =>
    path === "/me"
      ? json(cabinet)
      : new Promise<Response>((resolve) => {
          finish = resolve;
        }),
  );
  await ui.navigate("clients");
  assert.match(ui.html(), /Загружаем подключения/);
  assert.doesNotMatch(ui.html(), /Пока нет подключений/);
  finish(json({ clients: [] }));
  await ui.settle();
  assert.match(ui.html(), /Пока нет подключений/);
});

test("failed client requests show retry without claiming there are no connections", async () => {
  const ui = await dashboard((path) => (path === "/me" ? json(cabinet) : json({ error: "capacity" }, 503)));
  await ui.navigate("clients");
  assert.match(ui.html(), /Не удалось загрузить подключения/);
  assert.doesNotMatch(ui.html(), /Пока нет подключений/);
});

test("background status refresh preserves a permission draft", async () => {
  const ui = await dashboard(() => json(cabinet));
  await ui.navigate("access");
  ui.input("chatIds", "987654");
  await ui.focus();
  assert.equal(ui.field("chatIds"), "987654");
});

test("failed form submission preserves login for retry", async () => {
  const ui = await dashboard((path) =>
    json({ error: path === "/me" ? "authentication-required" : "invalid-credentials" }, path === "/me" ? 401 : 403),
  );
  await ui.click("auth-login");
  ui.input("login", "my_saved_login");
  await ui.submit("authForm", { login: "my_saved_login", password: "wrong sufficiently long password" });
  assert.equal(ui.field("login"), "my_saved_login");
});

test("a saved navigation URL restores the selected cabinet page", async () => {
  const ui = await dashboard(() => json(cabinet), { hash: "#access" });
  assert.match(ui.html(), /id="policyForm"/);
  await ui.hash("#account");
  assert.match(ui.html(), /id="deleteForm"/);
});

test("initial server outage offers retry rather than suggesting a new signup", async () => {
  let fail = true;
  const ui = await dashboard(() => (fail ? json({ error: "capacity" }, 503) : json(cabinet)));
  assert.match(ui.html(), /data-action="retry-status"/);
  assert.doesNotMatch(ui.html(), /id="authForm"/);
  fail = false;
  await ui.click("retry-status");
  assert.match(ui.html(), /https:\/\/mcp.example.test\/mcp/);
});

test("client display names are readable and escaped without losing their revoke identifier", async () => {
  const ui = await dashboard((path) =>
    path === "/me"
      ? json(cabinet)
      : json({
          clients: [
            { grantId: "grant-a", clientId: "client-id", version: 1, name: "Friendly AI <script>bad</script>" },
          ],
        }),
  );
  await ui.navigate("clients");
  assert.match(ui.html(), /Friendly AI &lt;script&gt;/);
  assert.doesNotMatch(ui.html(), /<script>bad/);
  assert.match(ui.html(), /data-revoke="grant-a"/);
});
