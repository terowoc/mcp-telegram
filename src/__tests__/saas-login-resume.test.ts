import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginAttempts } from "../saas/login-attempts.js";
import type { LoginEvent } from "../saas/worker-protocol.js";

test("current login resumes only its owner's active QR and disappears after cancellation", async () => {
  let emit: (event: LoginEvent) => void = () => {};
  const attempts = new LoginAttempts({
    prepareLogin: async () => {},
    startLogin: async (_user, _id, callback) => {
      emit = callback;
    },
    submitPassword: () => {},
    cancelLogin: async () => {},
    stopUser: async () => {},
    status: () => ({ state: "stopped", busy: false, sessionPresent: false }),
  });
  try {
    const started = await attempts.start("alice");
    emit({ type: "qr", dataUrl: "data:image/png;base64,fixture", expiresAt: Date.now() + 30000 });
    assert.equal(attempts.getCurrent("bob"), undefined);
    assert.equal(attempts.getCurrent("alice")?.id, started.id);
    assert.equal(attempts.getCurrent("alice")?.state, "qr");
    await attempts.cancel("alice", started.id);
    assert.equal(attempts.getCurrent("alice"), undefined);
  } finally {
    await attempts.close();
  }
});
