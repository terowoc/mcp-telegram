import assert from "node:assert/strict";
import type { ChildProcess, fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SaasMediaBudget } from "../saas/media-budget.js";
import { SessionVault } from "../saas/session-vault.js";
import { createSaasStore } from "../saas/store.js";
import { WorkerSupervisor } from "../saas/supervisor.js";
import type { ParentMessage } from "../saas/worker-protocol.js";

class Child extends EventEmitter {
  pid = 1;
  connected = true;
  sent: ParentMessage[] = [];
  autoReady = true;
  autoExit = true;
  send(message: ParentMessage) {
    this.sent.push(message);
    if (message.kind === "init" && this.autoReady)
      queueMicrotask(() => this.emit("message", { kind: "ready", generation: message.generation }));
    if (message.kind === "shutdown" && this.autoExit) queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
  kill() {
    if (this.autoExit) queueMicrotask(() => this.emit("exit", 0));
    return true;
  }
  reply(index = this.sent.length - 1, result: unknown = { ok: true }, settling = false) {
    const request = this.sent[index];
    assert.ok("id" in request);
    this.emit("message", { kind: "result", generation: request.generation, id: request.id, result, settling });
  }
}
function setup(
  options: {
    maxWorkers?: number;
    idleMs?: number;
    queueWaitMs?: number;
    onTiming?: ConstructorParameters<typeof WorkerSupervisor>[0]["onTiming"];
    autoReady?: boolean;
    autoExit?: boolean;
    mediaBudget?: { reserve: (userId: string) => () => void };
  } = {},
) {
  const store = createSaasStore(":memory:");
  const users = Array.from({ length: 5 }, (_, i) => store.register(`user${i}`, "hash", []));
  const vault = new SessionVault(Buffer.alloc(32, 1));
  store.putEncryptedSession(users[0].id, vault.encrypt(users[0].id, "session-A"));
  const children: Child[] = [];
  const spawn: typeof fork = (_file, _args, opts) => {
    assert.equal(opts?.env?.MCP_TELEGRAM_OWNER_PASSWORD, undefined);
    assert.equal(opts?.env?.TELEGRAM_2FA_PASSWORD, undefined);
    assert.equal(opts?.env?.MCP_SAAS_SESSION_KEY_FILE, undefined);
    assert.deepEqual(opts?.execArgv, ["--max-old-space-size=256"]);
    const child = new Child();
    child.pid = children.length + 1;
    child.autoReady = options.autoReady ?? true;
    child.autoExit = options.autoExit ?? true;
    children.push(child);
    return child as unknown as ChildProcess;
  };
  const supervisor = new WorkerSupervisor({
    store,
    vault,
    apiId: 1,
    apiHash: "hash",
    filesRoot: "/tmp/saas-worker-tests",
    spawn,
    ...options,
  });
  return { store, users, vault, children, supervisor };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
test("media uploads and URL sends hold all storage reservations until worker settlement", async () => {
  let held = 0;
  const s = setup({
    mediaBudget: {
      reserve: () => {
        held++;
        return () => {
          held--;
        };
      },
    },
  });
  try {
    for (const [name, args, expected] of [
      ["telegram-upload-media", { fileName: "video.mp4", data: "eA==" }, 1],
      ["telegram-send-file", { chatId: "42", fileUrl: "https://public.test/a" }, 1],
      [
        "telegram-send-file",
        { chatId: "me", file: { download_url: "https://public.test/a", file_id: "file-native" } },
        1,
      ],
      [
        "telegram-send-album",
        { chatId: "42", items: [{ fileUrl: "https://public.test/a" }, { fileUrl: "https://public.test/b" }] },
        1,
      ],
      ["telegram-send-file", { chatId: "42", fileId: "media_11111111-1111-4111-8111-111111111111" }, 0],
      [
        "telegram-send-album",
        {
          chatId: "me",
          files: [
            { download_url: "https://public.test/a", file_id: "file-a" },
            { download_url: "https://public.test/b", file_id: "file-b" },
          ],
        },
        1,
      ],
    ] as const) {
      const before = s.children[0]?.sent.length ?? 0;
      const call = s.supervisor.call(s.users[0].id, name, args);
      await waitFor(() => (s.children[0]?.sent.length ?? 0) > Math.max(before, 1));
      assert.equal(held, expected, name);
      s.children[0].reply();
      await call;
      assert.equal(held, 0);
    }
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});
test("five and ten native album files fit the default account admission quota", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-album-quota-"));
  const s = setup({ mediaBudget: new SaasMediaBudget({ root, availableBytes: () => 1e10 }) });
  try {
    for (const count of [5, 10]) {
      const before = s.children[0]?.sent.length ?? 0;
      let error: unknown;
      const call = s.supervisor
        .call(s.users[0].id, "telegram-send-album", {
          chatId: "me",
          files: Array.from({ length: count }, (_, i) => ({
            download_url: `https://public.test/${i}`,
            file_id: `file-${i}`,
          })),
        })
        .catch((value) => {
          error = value;
        });
      await waitFor(() => error !== undefined || (s.children[0]?.sent.length ?? 0) > Math.max(before, 1));
      assert.equal(error, undefined);
      s.children[0].reply();
      await call;
    }
  } finally {
    await s.supervisor.close();
    s.store.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("a login success without saved session stops that worker without throwing in the gateway", async () => {
  const s = setup();
  try {
    const user = s.users[1];
    const events: unknown[] = [];
    const login = s.supervisor.startLogin(user.id, "attempt", (event) => events.push(event)).catch((error) => error);
    await waitFor(() => s.children[0]?.sent.some((message) => message.kind === "login-start") === true);
    const request = s.children[0].sent.find((message) => message.kind === "login-start");
    assert.ok(request && "id" in request);
    assert.doesNotThrow(() =>
      s.children[0].emit("message", {
        kind: "event",
        generation: request.generation,
        id: request.id,
        attemptId: "attempt",
        event: { type: "success", account: { id: "111" } },
      }),
    );
    assert.ok((await login) instanceof Error);
    assert.deepEqual(events, [{ type: "error", code: "login-failed" }]);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "fixture readiness deadline");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("workers never share identity policy or session", async () => {
  const s = setup();
  try {
    const a = s.supervisor.call(s.users[0].id, "telegram-status", {});
    const b = s.supervisor.call(s.users[1].id, "telegram-status", {});
    await waitFor(() => s.children.length === 2 && s.children.every((child) => child.sent.length === 2));
    assert.equal(s.children.length, 2);
    const childA = s.children.find((child) => child.sent[0]?.kind === "init" && child.sent[0].userId === s.users[0].id);
    const childB = s.children.find((child) => child.sent[0]?.kind === "init" && child.sent[0].userId === s.users[1].id);
    assert.ok(childA && childB);
    const [initA, initB] = [childA.sent[0], childB.sent[0]];
    assert.equal(initA.kind, "init");
    assert.equal(initB.kind, "init");
    if (initA.kind !== "init" || initB.kind !== "init") throw new Error("Expected init");
    assert.equal(initA.userId, s.users[0].id);
    assert.equal(initA.session, "session-A");
    assert.equal(initB.session, undefined);
    assert.notEqual(initA.fileRoot, initB.fileRoot);
    assert.notEqual(initA.generation, initB.generation);
    assert.notEqual(s.children[0].pid, s.children[1].pid);
    s.children[0].reply();
    s.children[1].reply();
    await Promise.all([a, b]);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});
test("capacity includes starting and stopping workers; cancelled admission consumes no slot", async () => {
  const s = setup({ maxWorkers: 4, autoReady: false, autoExit: false });
  const calls = s.users.slice(0, 4).map((u) => s.supervisor.call(u.id, "telegram-status", {}).catch((e) => e));
  try {
    await waitFor(() => s.children.length === 4);
    assert.equal(s.children.length, 4);
    await assert.rejects(s.supervisor.call(s.users[4].id, "telegram-status", {}), /capacity/i);
    const childA = s.children.find((child) => child.sent[0]?.kind === "init" && child.sent[0].userId === s.users[0].id);
    assert.ok(childA);
    const stopped = s.supervisor.stopUser(s.users[0].id);
    await assert.rejects(s.supervisor.call(s.users[4].id, "telegram-status", {}), /capacity/i);
    childA.emit("exit", 0);
    await stopped;
    const aborted = new AbortController();
    aborted.abort();
    await assert.rejects(s.supervisor.call(s.users[4].id, "telegram-status", {}, { signal: aborted.signal }));
    assert.equal(s.children.length, 4);
  } finally {
    const closing = s.supervisor.close();
    s.children.forEach((child) => {
      child.emit("exit", 0);
    });
    await closing;
    await Promise.all(calls);
    s.store.close();
  }
});
test("stale generation cannot save a session and ACK follows encrypted persistence", async () => {
  const s = setup();
  try {
    const call = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    const child = s.children[0],
      init = child.sent[0];
    const before = s.store.getEncryptedSession(s.users[0].id);
    child.emit("message", { kind: "session-save", generation: "stale", id: "old", session: "evil" });
    assert.equal(s.store.getEncryptedSession(s.users[0].id), before);
    child.emit("message", {
      kind: "session-save",
      generation: init.generation,
      id: "save",
      session: "new-session",
      userId: s.users[1].id,
    });
    assert.equal(s.vault.decrypt(s.users[0].id, s.store.getEncryptedSession(s.users[0].id) ?? ""), "new-session");
    assert.equal(s.store.getEncryptedSession(s.users[1].id), undefined);
    assert.equal(child.sent.at(-1)?.kind, "ack");
    const ack = child.sent.at(-1);
    assert.ok(ack?.kind === "ack");
    assert.equal(ack.ok, true);
    child.reply(1);
    await call;
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});
test("cancelled call retains settlement exclusivity", async () => {
  const s = setup();
  try {
    const abort = new AbortController();
    const call = s.supervisor.call(s.users[0].id, "telegram-status", {}, { signal: abort.signal });
    await waitFor(() => s.children[0]?.sent.length === 2);
    const child = s.children[0],
      request = child.sent[1];
    abort.abort();
    await assert.rejects(call);
    child.reply(1, undefined, true);
    await assert.rejects(s.supervisor.call(s.users[0].id, "telegram-status", {}), /busy|settling/i);
    child.emit("message", { kind: "settled", generation: request.generation, id: request.id });
    const next = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => child.sent.at(-1)?.kind === "tool");
    child.reply();
    await next;
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});
test("idle worker releases its slot and shutdown waits for workers", async () => {
  const s = setup({ maxWorkers: 1, idleMs: 20 });
  const call = s.supervisor.call(s.users[0].id, "telegram-status", {});
  await waitFor(() => s.children[0]?.sent.length === 2);
  s.children[0].reply();
  await call;
  await waitFor(() => s.supervisor.status(s.users[0].id).state === "stopped");
  assert.equal(s.supervisor.status(s.users[0].id).state, "stopped");
  const next = s.supervisor.call(s.users[1].id, "telegram-status", {});
  await waitFor(() => s.children[1]?.sent.length === 2);
  s.children[1].reply();
  await next;
  s.children[1].autoExit = false;
  let closed = false;
  const closing = s.supervisor.close().then(() => {
    closed = true;
  });
  await tick();
  assert.equal(closed, false);
  await assert.rejects(s.supervisor.call(s.users[2].id, "telegram-status", {}), /closing|closed/i);
  s.children[1].emit("exit", 0);
  await closing;
  assert.equal(closed, true);
  s.store.close();
});

test("changing policy never reuses a worker with the previous policy", async () => {
  const s = setup();
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    s.children[0].reply();
    await first;
    s.store.updatePolicy(s.users[0].id, { profile: "read", chatIds: ["123"], version: 0 });
    const changed = s.supervisor.call(s.users[0].id, "telegram-status", {});
    const rejection = assert.rejects(changed, /policy|stopping/i);
    await tick();
    if (s.children[0].sent.at(-1)?.kind === "tool") s.children[0].reply();
    await rejection;
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("media admission remains reserved across cancellation until physical settlement", async () => {
  let held = 0;
  const s = setup({
    mediaBudget: {
      reserve: () => {
        if (held) throw new Error("Media storage quota reached");
        held++;
        return () => held--;
      },
    },
  });
  try {
    const abort = new AbortController();
    const pending = s.supervisor.call(s.users[0].id, "telegram-download-media", {}, { signal: abort.signal });
    const rejected = assert.rejects(pending);
    await waitFor(() => s.children[0]?.sent.length === 2);
    const child = s.children[0];
    const request = child.sent[1];
    assert.ok("id" in request);
    assert.equal(held, 1);
    abort.abort();
    await rejected;
    child.reply(1, undefined, true);
    await assert.rejects(s.supervisor.call(s.users[1].id, "telegram-download-media", {}), /quota/);
    child.emit("message", { kind: "settled", generation: request.generation, id: request.id });
    assert.equal(held, 0);
    const next = s.supervisor.call(s.users[1].id, "telegram-download-media", {});
    await waitFor(() => s.children[1]?.sent.at(-1)?.kind === "tool");
    s.children[1].reply();
    await next;
    assert.equal(held, 0);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("rejected legacy reconnect preserves the bound session and next worker identity", async () => {
  const s = setup();
  try {
    const user = s.users[0];
    s.store.putTelegramAccount(user.id, { id: "111" });
    s.store.commitTelegramLogin(s.store.planTelegramLogin({ id: "111" }, user.id), {
      account: { id: "111" },
      envelope: s.vault.encrypt(user.id, "session-A"),
      browserSession: {
        idHash: "fixture",
        csrfHash: "fixture",
        expiresAt: Date.now() + 10000,
        authenticatedAt: Date.now(),
      },
    });
    const before = s.store.getEncryptedSession(user.id);
    const login = s.supervisor.startLogin(user.id, "attempt", () => {}).catch((error) => error);
    await waitFor(() => s.children[0]?.sent.some((m) => m.kind === "login-start") === true);
    const child = s.children[0];
    const request = child.sent.find((m) => m.kind === "login-start");
    assert.ok(request && "id" in request);
    child.emit("message", { kind: "session-save", generation: request.generation, id: "save", session: "session-B" });
    child.emit("message", {
      kind: "event",
      generation: request.generation,
      id: request.id,
      attemptId: "attempt",
      event: { type: "success", account: { id: "222" } },
    });
    assert.ok((await login) instanceof Error);
    assert.equal(s.store.getEncryptedSession(user.id), before);
    assert.equal(s.store.getTelegramAccount(user.id)?.id, "111");
    const call = s.supervisor.call(user.id, "telegram-status", {});
    await waitFor(() => s.children[1]?.sent.length === 2);
    const init = s.children[1].sent[0];
    assert.ok(init.kind === "init");
    assert.equal(init.session, "session-A");
    s.children[1].reply();
    await call;
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("verified matching legacy reconnect atomically replaces its session and metadata", async () => {
  const s = setup();
  try {
    const user = s.users[0];
    const login = s.supervisor.startLogin(user.id, "attempt", () => {});
    await waitFor(() => s.children[0]?.sent.some((m) => m.kind === "login-start") === true);
    const child = s.children[0];
    const request = child.sent.find((m) => m.kind === "login-start");
    assert.ok(request && "id" in request);
    const before = s.store.getEncryptedSession(user.id);
    child.emit("message", {
      kind: "session-save",
      generation: request.generation,
      id: "save",
      session: "verified-session",
    });
    assert.equal(s.store.getEncryptedSession(user.id), before, "login persistence waits for getMe identity");
    child.emit("message", {
      kind: "event",
      generation: request.generation,
      id: request.id,
      attemptId: "attempt",
      event: { type: "success", account: { id: "111" } },
    });
    child.reply(child.sent.indexOf(request), { success: true });
    await login;
    assert.equal(s.vault.decrypt(user.id, s.store.getEncryptedSession(user.id)!), "verified-session");
    assert.equal(s.store.getTelegramAccount(user.id)?.id, "111");
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

// A completed account must not monopolize limited process capacity until idle expiry.
test("idle LRU eviction waits for physical exit before admitting a different account", async () => {
  const s = setup({ maxWorkers: 1, autoExit: false });
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    s.children[0].reply();
    await first;
    const second = s.supervisor.call(s.users[1].id, "telegram-status", {}).catch((error) => error);
    await tick();
    await tick();
    assert.equal(s.children.length, 1);
    assert.equal(s.supervisor.status(s.users[0].id).state, "stopping");
    s.children[0].emit("exit", 0);
    await waitFor(() => s.children[1]?.sent.length === 2);
    s.children[1].reply();
    assert.deepEqual(await second, { ok: true });
  } finally {
    const closed = s.supervisor.close();
    s.children.forEach((child) => {
      child.emit("exit", 0);
    });
    await closed;
    s.store.close();
  }
});

test("brief concurrent calls on one account execute FIFO without busy errors", async () => {
  const s = setup();
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    const second = s.supervisor.call(s.users[0].id, "telegram-read-messages", { chatId: "me" }).catch((error) => error);
    await tick();
    assert.equal(s.children[0].sent.length, 2);
    s.children[0].reply(1, { first: true });
    await first;
    await waitFor(() => s.children[0].sent.length === 3);
    s.children[0].reply(2, { second: true });
    assert.deepEqual(await second, { second: true });
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("cancelled queued call never reaches the Telegram worker", async () => {
  const s = setup();
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    const abort = new AbortController();
    const second = s.supervisor.call(s.users[0].id, "telegram-status", {}, { signal: abort.signal });
    const rejected = assert.rejects(second, /cancel|abort/i);
    await tick();
    abort.abort();
    await rejected;
    s.children[0].reply();
    await first;
    await tick();
    assert.equal(s.children[0].sent.filter((message) => message.kind === "tool").length, 1);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("queue deadline rejects waiting work without stopping the running operation", async () => {
  const s = setup({ queueWaitMs: 20 });
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    const before = performance.now();
    await assert.rejects(s.supervisor.call(s.users[0].id, "telegram-status", {}), /queue|busy/i);
    assert.ok(performance.now() - before >= 15, "short operation is given time to finish");
    assert.equal(s.supervisor.status(s.users[0].id).state, "ready");
    assert.equal(s.children[0].sent.length, 2);
    s.children[0].reply();
    assert.deepEqual(await first, { ok: true });
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("queued calls stay bounded and a busy account cannot be evicted", async () => {
  const s = setup({ maxWorkers: 1 });
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 2);
    const queued = Array.from({ length: 4 }, () =>
      s.supervisor.call(s.users[0].id, "telegram-status", {}).catch((error) => error),
    );
    await tick();
    await assert.rejects(s.supervisor.call(s.users[0].id, "telegram-status", {}), /queue.*full/i);
    await assert.rejects(s.supervisor.call(s.users[1].id, "telegram-status", {}), /capacity/i);
    assert.equal(s.children.length, 1);
    s.children[0].reply();
    await first;
    for (let i = 0; i < queued.length; i++) {
      await waitFor(() => s.children[0].sent.length === i + 3);
      s.children[0].reply();
      assert.deepEqual(await queued[i], { ok: true });
    }
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("warming slots does not let an idle process expire during a queue handoff", async () => {
  const s = setup({ idleMs: 1, autoReady: false });
  try {
    const first = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await waitFor(() => s.children[0]?.sent.length === 1);
    const second = s.supervisor.call(s.users[0].id, "telegram-status", {});
    await tick();
    s.children[0].emit("message", { kind: "ready", generation: s.children[0].sent[0].generation });
    await waitFor(() => s.children[0].sent.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(s.supervisor.status(s.users[0].id).state, "ready");
    s.children[0].reply();
    await first;
    await waitFor(() => s.children[0].sent.length === 3);
    s.children[0].reply();
    await second;
    assert.equal(s.children.length, 1);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("tool timings distinguish connection delay without recording account identity or arguments", async () => {
  const timings: unknown[] = [];
  const s = setup({ onTiming: (timing) => timings.push(timing) });
  try {
    const call = s.supervisor.call(s.users[0].id, "telegram-read-messages", { chatId: "private-fixture-secret" });
    await waitFor(() => s.children[0]?.sent.length === 2);
    const request = s.children[0].sent[1];
    assert.ok(request.kind === "tool");
    assert.ok(request.deadlineAt && request.deadlineAt > Date.now());
    s.children[0].emit("message", {
      kind: "result",
      generation: request.generation,
      id: request.id,
      result: { ok: true },
      timing: { connectionMs: 250, connectionCold: true },
    });
    await call;
    assert.equal(timings.length, 1);
    const timing = timings[0] as Record<string, unknown>;
    assert.equal(timing.connectionMs, 250);
    assert.equal(timing.connectionCold, true);
    assert.equal(timing.tool, "telegram-read-messages");
    assert.equal(JSON.stringify(timing).includes("private-fixture-secret"), false);
    assert.equal(JSON.stringify(timing).includes(s.users[0].id), false);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});

test("duplicate Telegram QR success never overwrites another account or saves the rejected candidate", async () => {
  const s = setup();
  try {
    const owner = s.users[0],
      work = s.store.createTelegramConnection(owner.id, "Work");
    s.store.putTelegramAccount(owner.id, { id: "123" });
    const original = s.store.getEncryptedSession(owner.id);
    const events: unknown[] = [];
    const login = s.supervisor
      .startLogin(work.id, "work-attempt", (event) => events.push(event))
      .catch((error) => error);
    await waitFor(() => s.children[0]?.sent.some((message) => message.kind === "login-start") === true);
    const child = s.children[0],
      request = child.sent.find((message) => message.kind === "login-start");
    assert.ok(request && "id" in request);
    child.emit("message", {
      kind: "session-save",
      generation: request.generation,
      id: "save",
      session: "rejected-candidate",
    });
    child.emit("message", {
      kind: "event",
      generation: request.generation,
      id: request.id,
      attemptId: "work-attempt",
      event: { type: "success", account: { id: "123" } },
    });
    await login;
    assert.deepEqual(events, [{ type: "error", code: "account-already-added" }]);
    assert.equal(s.store.getEncryptedSession(work.id), undefined);
    assert.equal(s.store.getEncryptedSession(owner.id), original);
  } finally {
    await s.supervisor.close();
    s.store.close();
  }
});
