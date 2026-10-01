import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SaasAuth } from "../saas/auth.js";
import { createSaasIdentity } from "../saas/identity.js";
import { createSaasStore } from "../saas/store.js";

const setup = async () => {
  const store = createSaasStore(":memory:");
  const auth = new SaasAuth(store, { csrfKey: randomBytes(32) });
  const owner = await auth.register("alice", "a private test password long enough");
  const other = await auth.register("bobby", "another private password long enough");
  return { store, auth, owner: owner.userId, other: other.userId };
};
test("owned connections have separate storage, bounded capacity and no cabinet login", async () => {
  const s = await setup();
  try {
    const account = s.store.createTelegramConnection(s.owner, "Работа");
    assert.equal(s.store.ownsTelegramConnection(s.owner, account.id), true);
    assert.equal(s.store.ownsTelegramConnection(s.other, account.id), false);
    assert.equal(s.store.listTelegramConnections(s.owner).length, 2);
    assert.throws(() => s.store.createTelegramConnection(account.id, "Nested"));
    assert.equal(await s.auth.login(account.login, "anything"), undefined);
    s.store.putVerifiedTelegramSession(s.owner, "primary-encrypted", { id: "123" });
    s.store.putVerifiedTelegramSession(account.id, "work-encrypted", { id: "456" });
    assert.equal(s.store.getEncryptedSession(s.owner), "primary-encrypted");
    assert.throws(() => s.store.putVerifiedTelegramSession(account.id, "bad", { id: "123" }), /already/i);
    assert.equal(s.store.getEncryptedSession(account.id), "work-encrypted");
    for (let n = 0; n < 3; n++) s.store.createTelegramConnection(s.owner, `Account ${n}`);
    assert.throws(() => s.store.createTelegramConnection(s.owner, "Sixth"), /capacity/i);
    assert.equal(s.store.listTelegramConnections(s.other).length, 1);
  } finally {
    s.store.close();
  }
});
test("AI explicit selection isolates senders and enforces selected policy even in a union catalog", async () => {
  const s = await setup();
  try {
    const work = s.store.createTelegramConnection(s.owner, "Работа");
    const foreign = s.store.createTelegramConnection(s.other, "Other");
    s.store.putVerifiedTelegramSession(s.owner, "primary", { id: "123" });
    s.store.putVerifiedTelegramSession(work.id, "work", { id: "456" });
    const calls: unknown[] = [];
    const identity = createSaasIdentity(s.store, s.auth, {
      call: async (id, name, args) => {
        calls.push({ id, name, args });
        return { content: [{ type: "text", text: id }] };
      },
    });
    await identity.callTool(s.owner, "telegram-send-message", { chatId: "me", text: "primary" });
    await identity.callTool(s.owner, "telegram-send-message", {
      telegramAccountId: work.id,
      chatId: "me",
      text: "work",
    });
    assert.deepEqual(calls, [
      { id: s.owner, name: "telegram-send-message", args: { chatId: "me", text: "primary" } },
      { id: work.id, name: "telegram-send-message", args: { chatId: "me", text: "work" } },
    ]);
    await assert.rejects(
      identity.callTool(s.owner, "telegram-send-message", { telegramAccountId: foreign.id, chatId: "me", text: "no" }),
    );
    await assert.rejects(
      identity.callTool(s.owner, "telegram-send-message", { telegramAccountId: null, chatId: "me", text: "no" }),
    );
    s.store.updatePolicy(work.id, { profile: "read", chatIds: [], version: 0 });
    await assert.rejects(
      identity.callTool(s.owner, "telegram-send-message", { telegramAccountId: work.id, chatId: "me", text: "no" }),
      /policy|unavailable/i,
    );
    const listed = (await identity.callTool(s.owner, "telegram-list-accounts", {})) as {
      structuredContent: { accounts: { id: string }[] };
    };
    assert.deepEqual(
      listed.structuredContent.accounts.map((a) => a.id),
      [s.owner, work.id],
    );
    assert.equal(calls.length, 2);
    await assert.rejects(identity.callTool(s.owner, "telegram-login", { telegramAccountId: work.id }));
  } finally {
    s.store.close();
  }
});

test("account membership changes invalidate an open OAuth consent binding", async () => {
  const s = await setup();
  try {
    const identity = createSaasIdentity(s.store, s.auth, { call: async () => ({}) });
    const before = identity.consentBinding?.(s.owner);
    const work = s.store.createTelegramConnection(s.owner, "Work");
    const created = identity.consentBinding?.(s.owner);
    assert.notEqual(created, before);
    assert.throws(() => identity.bindGrant(s.owner, "stale", "client", before), /consent/i);
    assert.equal(s.store.findGrant("stale"), undefined);
    s.store.updatePolicy(work.id, { profile: "read", chatIds: [], version: 0 });
    assert.notEqual(identity.consentBinding?.(s.owner), created);
  } finally {
    s.store.close();
  }
});
