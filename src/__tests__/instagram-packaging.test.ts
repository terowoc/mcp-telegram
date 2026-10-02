import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("Instagram packaging pins a private runtime and copies the worker", async () => {
  const root = new URL("../../", import.meta.url);
  const [docker, pkg, lock, copy] = await Promise.all(
    ["Dockerfile", "package.json", "packaging/instagram/requirements.txt", "scripts/copy-instagram-worker.mjs"].map(
      (p) => readFile(new URL(p, root), "utf8"),
    ),
  );
  assert.match(docker, /python3-venv/);
  assert.match(docker, /--require-hashes/);
  assert.match(docker, /PYTHONDONTWRITEBYTECODE=1/);
  assert.match(lock, /instagrapi==3\.0\.18/);
  assert.match(pkg, /copy-instagram-worker/);
  assert.match(copy, /worker\.py/);
});
