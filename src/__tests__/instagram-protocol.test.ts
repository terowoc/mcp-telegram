import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { childFrame } from "../instagram/protocol.js";

test("login diagnostics reject arbitrary upstream data before it can be logged", () => {
  const frame = {
    generation: randomUUID(),
    kind: "event",
    attemptId: randomUUID(),
    state: "failed",
    error: "rate-limited",
    diagnostic: { phase: "authentication", reason: "please-wait", step: "device", httpStatus: 429 },
  };
  assert.equal(childFrame.safeParse(frame).success, true);
  for (const diagnostic of [
    { ...frame.diagnostic, message: "secret-password" },
    { ...frame.diagnostic, step: "sessionid=private" },
    { ...frame.diagnostic, reason: "SecretPasswordException" },
    { ...frame.diagnostic, httpStatus: 1000 },
  ])
    assert.equal(childFrame.safeParse({ ...frame, diagnostic }).success, false);
});
