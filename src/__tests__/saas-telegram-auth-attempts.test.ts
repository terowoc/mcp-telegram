import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SaasAuth } from "../saas/auth.js";
import { SessionVault } from "../saas/session-vault.js";
import { createSaasStore } from "../saas/store.js";
import { TelegramAuthAttempts } from "../saas/telegram-auth-attempts.js";
import type { TelegramAuthEvent } from "../saas/telegram-auth-protocol.js";

function setup() {
  const store = createSaasStore(":memory:"),
    auth = new SaasAuth(store, { csrfKey: randomBytes(32) }),
    vault = new SessionVault(randomBytes(32));
  let callback: (event: TelegramAuthEvent) => void = () => {};
  let attemptId = "",
    now = Date.now(),
    disposeFails = false;
  const worker = {
    start: async (id: string, event: typeof callback) => {
      attemptId = id;
      callback = event;
      event({ type: "token", token: "AQID", expiresAt: Date.now() + 30000 });
    },
    submitPassword: (_password: string) => {},
    dispose: async (_opts: { logout: boolean }) => {
      if (disposeFails) throw new Error("teardown");
    },
  };
  const attempts = new TelegramAuthAttempts({ store, auth, vault, createWorker: () => worker, now: () => now });
  return {
    store,
    auth,
    attempts,
    worker,
    verify: () =>
      callback({
        type: "verified",
        proof: { attemptId, account: { id: "12345" }, session: "synthetic", authenticatedAt: Date.now() },
      }),
    advance: (ms: number) => {
      now += ms;
    },
    failDispose: () => {
      disposeFails = true;
    },
    close: async () => {
      disposeFails = false;
      await attempts.close();
      store.close();
    },
  };
}
test("browser_id_is_not_authentication", async () => {
  const f = setup();
  try {
    const a = await f.attempts.start("owner");
    await assert.rejects(f.attempts.complete("owner", a.id), /verified/i);
    assert.equal(f.store.findByTelegramId("12345"), undefined);
    f.verify();
    assert.equal(JSON.stringify(f.attempts.get("owner", a.id)).includes("synthetic"), false);
    const session = await f.attempts.complete("owner", a.id);
    assert.equal(f.auth.authenticate(session.sessionToken)?.userId, f.store.findByTelegramId("12345")?.id);
  } finally {
    await f.close();
  }
});
test("foreign_cookie_and_origin_cannot_read_or_complete", async () => {
  const f = setup();
  try {
    const a = await f.attempts.start("owner");
    f.verify();
    assert.equal(f.attempts.get("other", a.id), undefined);
    await assert.rejects(f.attempts.complete("other", a.id));
    assert.equal(await f.attempts.cancel("other", a.id), false);
    assert.equal(f.store.findByTelegramId("12345"), undefined);
  } finally {
    await f.close();
  }
});
test("expiry_and_late_success_never_issue_cookie", async () => {
  const f = setup();
  try {
    const a = await f.attempts.start("owner");
    f.advance(300001);
    f.verify();
    await assert.rejects(f.attempts.complete("owner", a.id));
    assert.equal(f.store.findByTelegramId("12345"), undefined);
  } finally {
    await f.close();
  }
});
test("lost_completion_response_cannot_issue_twice", async () => {
  const f = setup();
  try {
    const a = await f.attempts.start("owner");
    f.verify();
    const results = await Promise.allSettled([f.attempts.complete("owner", a.id), f.attempts.complete("owner", a.id)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    await assert.rejects(f.attempts.complete("owner", a.id));
  } finally {
    await f.close();
  }
});
test("old_tab_cannot_complete_after_cancel", async () => {
  const f = setup();
  try {
    const a = await f.attempts.start("owner");
    await f.attempts.cancel("owner", a.id);
    f.verify();
    await assert.rejects(f.attempts.complete("owner", a.id));
    assert.equal(f.store.findByTelegramId("12345"), undefined);
  } finally {
    await f.close();
  }
});
test("worker_stop_failure_fails_complete_without_partial_account", async () => {
  const f = setup();
  try {
    const a = await f.attempts.start("owner");
    f.verify();
    f.failDispose();
    await assert.rejects(f.attempts.complete("owner", a.id));
    assert.equal(f.store.findByTelegramId("12345"), undefined);
  } finally {
    await f.close();
  }
});
test("disable_during_worker_shutdown_fails_complete", async () => {
  const f = setup();
  try {
    const first = await f.attempts.start("owner");
    f.verify();
    const signed = await f.attempts.complete("owner", first.id);
    const second = await f.attempts.start("new");
    f.verify();
    f.worker.dispose = async () => {
      f.store.disableUser(signed.userId);
    };
    await assert.rejects(f.attempts.complete("new", second.id));
    assert.equal(f.auth.authenticate(signed.sessionToken), undefined);
  } finally {
    await f.close();
  }
});
