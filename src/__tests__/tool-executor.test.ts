import assert from "node:assert/strict";
import { it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { GlobalLock } from "../global-lock.js";
import { wireOwnerExecutor } from "../master.js";
import type { TelegramService } from "../telegram-client.js";
import { ToolExecutor } from "../tool-executor.js";

it("expires queued operations before they can perform a side effect", async () => {
  const lock = new GlobalLock();
  const release = await lock.acquire();
  let calls = 0;
  const executor = new ToolExecutor({
    tools: {
      write: {
        handler: async () => {
          calls++;
          return {};
        },
      },
    },
    lock,
    timeoutMs: 20,
  });
  await assert.rejects(executor.call("write", {}), /timed out|deadline/i);
  release();
  await delay(5);
  assert.equal(calls, 0);
});
it("does not release the execution lock while a timed-out underlying operation is still live", async () => {
  let settle!: () => void;
  let writes = 0;
  const executor = new ToolExecutor({
    tools: {
      slow: {
        handler: () =>
          new Promise((resolve) => {
            settle = () => resolve({});
          }),
      },
      write: {
        handler: async () => {
          writes++;
          return {};
        },
      },
    },
    timeoutMs: 20,
  });
  await assert.rejects(executor.call("slow", {}), /timed out/i);
  await assert.rejects(executor.call("write", {}), /settling|unavailable/i);
  assert.equal(writes, 0);
  settle();
  await delay(5);
  await executor.call("write", {});
  assert.equal(writes, 1);
});
it("cancels queued operations and caps complete tool results", async () => {
  const lock = new GlobalLock();
  const release = await lock.acquire();
  let calls = 0;
  const executor = new ToolExecutor({
    tools: {
      large: {
        handler: async () => {
          calls++;
          return { data: "x".repeat(2000) };
        },
      },
    },
    lock,
    maxResultBytes: 1000,
  });
  const abort = new AbortController();
  const pending = executor.call("large", {}, { signal: abort.signal });
  abort.abort();
  await assert.rejects(pending);
  release();
  assert.equal(calls, 0);
  await assert.rejects(executor.call("large", {}), /output|result/i);
});

it("stdio wrappers share the owner executor and watchdog only fires for unsettled calls", async () => {
  let settle!: () => void;
  let stuck = 0;
  let writes = 0;
  const registry = {
    _registeredTools: {
      slow: {
        handler: async () =>
          new Promise((resolve) => {
            settle = () => resolve({});
          }),
      },
      write: {
        handler: async () => {
          writes++;
          return {};
        },
      },
    },
  };
  const executor = wireOwnerExecutor(registry, {} as TelegramService, {
    toolCallTimeoutMs: 10,
    onStuck: () => stuck++,
  });
  const slow = registry._registeredTools.slow.handler({}, {});
  await assert.rejects(slow, /timed out/i);
  assert.equal(executor.isSettling(), true);
  await assert.rejects(registry._registeredTools.write.handler({}, {}), /unavailable/i);
  assert.equal(writes, 0);
  settle();
  await delay(5);
  await registry._registeredTools.write.handler({}, {});
  assert.equal(writes, 1);
  assert.equal(stuck, 0);
});

it("invokes recovery after an underlying operation fails to settle", async () => {
  let stuck = 0;
  const executor = new ToolExecutor({
    tools: { slow: { handler: async () => new Promise(() => {}) } },
    timeoutMs: 10,
    settlementGraceMs: 10,
    onStuck: () => stuck++,
  });
  await assert.rejects(executor.call("slow", {}), /timed out/i);
  await delay(30);
  assert.equal(stuck, 1);
  assert.equal(executor.isSettling(), true);
});
