import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedMap } from "../bounded-map.js";

test("failed parallel reads drain outstanding work before releasing the operation", async () => {
  let finish!: () => void;
  let drained = false,
    ended = false;
  const deferred = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const seen: number[] = [];
  const result = boundedMap([1, 2, 3, 4], 2, async (item) => {
    seen.push(item);
    if (item === 1) {
      await new Promise((resolve) => setImmediate(resolve));
      throw new Error("read failed");
    }
    await deferred;
    drained = true;
    return item;
  }).catch((error) => {
    ended = true;
    return error;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(ended, false);
  assert.equal(drained, false);
  finish();
  assert.match((await result).message, /read failed/);
  assert.equal(drained, true);
  assert.deepEqual(seen, [1, 2]);
});

test("cancelled batch starts no further requests and waits for already started reads", async () => {
  const abort = new AbortController();
  let finish!: () => void;
  const deferred = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const seen: number[] = [];
  const result = boundedMap(
    [1, 2, 3],
    2,
    async (item) => {
      seen.push(item);
      await deferred;
      return item;
    },
    abort.signal,
  );
  const rejected = assert.rejects(result, /abort/i);
  abort.abort();
  finish();
  await rejected;
  assert.deepEqual(seen, [1, 2]);
});
