import assert from "node:assert/strict";
import { it } from "node:test";
import { encodeMessage, IpcDecoder } from "../ipc-protocol.js";

it("preserves split UTF-8 characters in both requests and responses", () => {
  for (const message of [
    { type: "tool" as const, id: "1", tool: "test", args: { text: "Привет 👋" } },
    { type: "tool_response" as const, id: "2", result: "Привет 👋" },
  ]) {
    const bytes = Buffer.from(encodeMessage(message));
    for (let split = 1; split < bytes.length; split++) {
      const decoder = new IpcDecoder();
      const result = [...decoder.push(bytes.subarray(0, split)), ...decoder.push(bytes.subarray(split))];
      assert.deepEqual(result, [message]);
    }
  }
});
it("rejects oversized complete and unterminated frames but accepts multiple bounded frames", () => {
  assert.throws(() => new IpcDecoder(16).push(Buffer.from("x".repeat(17))), /frame/);
  assert.throws(() => new IpcDecoder(16).push(Buffer.from(`${"x".repeat(17)}\n`)), /frame/);
  const decoder = new IpcDecoder(100);
  const line = encodeMessage({ type: "login_start", id: "1" });
  assert.equal(decoder.push(Buffer.from(line.repeat(10))).length, 10);
});
