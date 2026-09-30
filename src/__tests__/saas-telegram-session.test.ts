import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";
import bigInt from "big-integer";
import { TelegramClient } from "telegram";
import { AuthKey } from "telegram/crypto/AuthKey.js";
import { StringSession } from "telegram/sessions/index.js";
import { Api } from "telegram/tl/index.js";
import { TelegramService } from "../telegram-client.js";
import type { TelegramSessionStore } from "../telegram-session-store.js";

let validSession: string;
const original = {
  connect: TelegramClient.prototype.connect,
  destroy: TelegramClient.prototype.destroy,
  invoke: TelegramClient.prototype.invoke,
  getMe: TelegramClient.prototype.getMe,
};
let destroyed: number;

function store(initial?: string): TelegramSessionStore {
  let session = initial;
  return {
    load: async () => session,
    save: async (value) => {
      session = value;
    },
    clear: async () => {
      session = undefined;
    },
    hasSession: () => session !== undefined,
  };
}

before(async () => {
  const session = new StringSession("");
  session.setDC(2, "149.154.167.51", 443);
  const key = new AuthKey();
  await key.setKey(Buffer.alloc(256, 7));
  session.setAuthKey(key);
  validSession = session.save();
});
beforeEach(() => {
  destroyed = 0;
  TelegramClient.prototype.connect = async function () {
    const fixture = new StringSession(validSession);
    await fixture.load();
    this.session.setDC(fixture.dcId, fixture.serverAddress, fixture.port);
    this.session.setAuthKey(fixture.authKey);
  };
  TelegramClient.prototype.destroy = async () => {
    destroyed++;
  };
  TelegramClient.prototype.getMe = async () => new Api.User({ id: bigInt(1) });
  TelegramClient.prototype.invoke = async (request) => {
    if (request instanceof Api.auth.ExportLoginToken)
      return new Api.auth.LoginTokenSuccess({
        authorization: new Api.auth.Authorization({ user: new Api.User({ id: bigInt(1) }) }),
      });
    if (request instanceof Api.auth.LogOut) return true;
    throw new Error("Unexpected Telegram request in fixture");
  };
});
afterEach(() => Object.assign(TelegramClient.prototype, original));

// A file fallback would overwrite/delete the sentinel even though hosted storage is configured.
test("injected store never touches plaintext or legacy file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "saas-session-"));
  const path = join(dir, "session");
  await writeFile(path, "legacy-sentinel");
  const persisted = store(validSession);
  const service = new TelegramService(1, "hash", { sessionPath: path, sessionStore: persisted });
  try {
    assert.equal(await service.loadSession(), true);
    assert.equal(service.getSessionString(), validSession);
    assert.equal(service.hasLocalSession(), true);
    const result = await service.startQrLogin(() => {});
    assert.equal(result.success, true);
    assert.equal(await persisted.load(), validSession);
    await service.clearSession();
    assert.equal(service.hasLocalSession(), false);
    assert.equal(await readFile(path, "utf8"), "legacy-sentinel");
  } finally {
    await service.disconnect();
    await rm(dir, { recursive: true, force: true });
  }
});

test("logout clears only injected store including a disconnected session", async () => {
  const a = store(validSession);
  const b = store(validSession);
  const service = new TelegramService(1, "hash", { sessionStore: a });
  await service.loadSession();
  assert.equal(await service.logOut(), false);
  assert.equal(await a.load(), undefined);
  assert.equal(service.getSessionString(), "");
  assert.equal(await b.load(), validSession);
});

test("failed save fails QR login before adopting the new client", async () => {
  const persisted = store();
  persisted.save = async () => {
    throw new Error("Persistence unavailable");
  };
  const service = new TelegramService(1, "hash", { sessionStore: persisted });
  const result = await service.startQrLogin(() => {});
  try {
    assert.equal(result.success, false);
    assert.equal(service.isConnected(), false);
    assert.equal(service.getSessionString(), "");
    assert.equal(destroyed, 1);
  } finally {
    await service.disconnect();
  }
});

test("two factor password wait is cancellable even when callback does not settle", async () => {
  TelegramClient.prototype.invoke = async () => {
    throw Object.assign(new Error("SESSION_PASSWORD_NEEDED"), { errorMessage: "SESSION_PASSWORD_NEEDED" });
  };
  const service = new TelegramService(1, "hash", { sessionStore: store() });
  const abort = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const login = service.startQrLogin(() => {}, undefined, abort.signal, {
    requestPassword: async (signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(receivedSignal, "password must be requested from this attempt");
    abort.abort();
    const result = await Promise.race([
      login,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Cancellation did not settle")), 300);
        timer.unref();
      }),
    ]);
    assert.equal(result.success, false);
    assert.equal(receivedSignal.aborted, true);
    assert.equal(service.isConnected(), false);
    assert.equal(destroyed, 1);
  } finally {
    abort.abort();
    await login;
    await service.disconnect();
  }
});
