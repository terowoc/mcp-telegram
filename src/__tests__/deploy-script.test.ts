import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { it } from "node:test";

for (const { fail, stopped, stopFailure = false } of [
  { fail: false, stopped: false },
  { fail: true, stopped: false },
  { fail: true, stopped: true },
  { fail: true, stopped: false, stopFailure: true },
])
  it(`worker-aware deploy preserves coherent auth, key and configuration (fail=${fail}, stopped=${stopped}, stopFailure=${stopFailure})`, {
    skip: process.platform === "win32",
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-deploy-"));
    const image = `ghcr.io/terowoc/mcp-telegram@sha256:${"a".repeat(64)}`;
    const old = `ghcr.io/terowoc/mcp-telegram@sha256:${"b".repeat(64)}`;
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "data/auth/oauth"), { recursive: true });
    writeFileSync(join(dir, "deployment.env"), `MCP_IMAGE=${old}\nMCP_INSTAGRAM_ENABLED=0\n`);
    writeFileSync(join(dir, "data/auth/saas.sqlite"), "users-v1");
    writeFileSync(join(dir, "data/auth/oauth/oauth.sqlite"), "oauth-v1");
    writeFileSync(join(dir, "session-key.bin"), Buffer.alloc(32, 1), { mode: 0o600 });
    writeFileSync(join(dir, "compose.yaml"), "legacy-owner-configuration\n");
    writeFileSync(join(dir, "telegram.env"), "TELEGRAM_API_ID=1\n");
    writeFileSync(join(dir, "bin/flock"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(dir, "bin/free"), "#!/bin/sh\necho 'Mem: 16000 12000 1000 1000 1000 3200'\n");
    writeFileSync(
      join(dir, "bin/docker"),
      `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$*" in
 *'login ghcr.io'*) cat >/dev/null;;
 *'/app/deployment/compose.production.yaml'*) echo 'new-saas-configuration';;
 *'config --quiet'*) exit 0;;
 *'ps -a -q mcp'*) echo old-container;;
 *'ps -q mcp'*) if [ '${stopped}' = false ] || [ -f started ]; then echo old-container; fi;;
 *'stop mcp'*)
   if [ '${stopFailure}' = true ] && [ -f started ]; then exit 1; fi
   echo last-worker-exit >> "$TEST_LOG";;
 *'up -d --no-deps mcp'*)
   touch started
   if grep -q '${image}' deployment.env; then
     echo users-v2 > data/auth/saas.sqlite
     echo oauth-v2 > data/auth/oauth/oauth.sqlite
   fi;;
 *'inspect --format {{.State.Running}} {{.State.ExitCode}}'*) echo 'false 0';;
 *'inspect --format'*)
   if [ '${fail}' = true ] && grep -q '${image}' deployment.env; then echo unhealthy; else echo healthy; fi;;
esac
`,
    );
    // Observe snapshot ordering via the actual filesystem copy command.
    writeFileSync(
      join(dir, "bin/cp"),
      `#!/bin/sh
case "$*" in *'data/auth '*) echo snapshot-start >> "$TEST_LOG";; esac
exec /bin/cp "$@"
`,
    );
    for (const name of ["docker", "flock", "free", "cp"]) chmodSync(join(dir, "bin", name), 0o755);
    const result = spawnSync("bash", [resolve("scripts/deploy-vps.sh"), image], {
      cwd: dir,
      encoding: "utf8",
      input: "temporary-registry-token",
      env: {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        TEST_LOG: join(dir, "commands"),
        MCP_INSTAGRAM_ENABLED: "1",
      },
    });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const commands = readFileSync(join(dir, "commands"), "utf8");
    assert.match(commands, /-p mcp-telegram/);
    assert.doesNotMatch(commands, /prune|down|restart/);
    assert.ok(commands.indexOf("last-worker-exit") < commands.indexOf("snapshot-start"));
    assert.deepEqual(readFileSync(join(dir, "session-key.bin")), Buffer.alloc(32, 1));
    const rolledBack = fail && !stopFailure;
    assert.equal(readFileSync(join(dir, "data/auth/saas.sqlite"), "utf8").trim(), rolledBack ? "users-v1" : "users-v2");
    assert.equal(
      readFileSync(join(dir, "data/auth/oauth/oauth.sqlite"), "utf8").trim(),
      rolledBack ? "oauth-v1" : "oauth-v2",
    );
    assert.equal(
      readFileSync(join(dir, "compose.yaml"), "utf8").trim(),
      rolledBack ? "legacy-owner-configuration" : "new-saas-configuration",
    );
    assert.ok(readFileSync(join(dir, "deployment.env"), "utf8").includes(rolledBack ? old : image));
    const deployment = readFileSync(join(dir, "deployment.env"), "utf8");
    assert.match(deployment, new RegExp(`MCP_INSTAGRAM_ENABLED=${rolledBack ? "0" : "1"}`));
    assert.match(commands, /--entrypoint \/opt\/instagram\/bin\/python .*worker\.py --check/);
    if (!fail) {
      const repeatedEnv = {
        ...process.env,
        PATH: `${join(dir, "bin")}:${process.env.PATH}`,
        TEST_LOG: join(dir, "commands"),
      };
      delete repeatedEnv.MCP_INSTAGRAM_ENABLED;
      const repeated = spawnSync("bash", [resolve("scripts/deploy-vps.sh"), image], {
        cwd: dir,
        encoding: "utf8",
        input: "temporary-registry-token",
        env: repeatedEnv,
      });
      assert.equal(repeated.status, 0, repeated.stderr);
      assert.match(readFileSync(join(dir, "deployment.env"), "utf8"), /MCP_INSTAGRAM_ENABLED=1/);
    }
    assert.doesNotMatch(result.stdout + result.stderr, /temporary-registry-token/);
    if (stopFailure) assert.match(result.stderr, /auth storage left intact/);
    else assert.doesNotMatch(result.stderr, /Rollback failed/);
    rmSync(dir, { recursive: true, force: true });
  });

it("rejects symlinked project storage before stopping any container", {
  skip: process.platform === "win32",
}, async () => {
  const { symlinkSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "mcp-storage-"));
  const outside = mkdtempSync(join(tmpdir(), "unrelated-storage-"));
  mkdirSync(join(dir, "bin"));
  mkdirSync(join(outside, "auth"));
  writeFileSync(join(dir, "session-key.bin"), Buffer.alloc(32, 1), { mode: 0o600 });
  writeFileSync(join(dir, "deployment.env"), `MCP_IMAGE=ghcr.io/terowoc/mcp-telegram@sha256:${"a".repeat(64)}\n`);
  writeFileSync(join(dir, "compose.yaml"), "legacy\n");
  symlinkSync(outside, join(dir, "data"));
  writeFileSync(join(dir, "bin/free"), "#!/bin/sh\necho 'Mem: 16000 12000 1000 1000 1000 3200'\n");
  writeFileSync(join(dir, "bin/flock"), "#!/bin/sh\nexit 0\n");
  writeFileSync(
    join(dir, "bin/docker"),
    `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_LOG"
case "$*" in
 *'/app/deployment/compose.production.yaml'*) echo 'new-compose';;
 *'ps -a -q mcp'*|*'ps -q mcp'*) echo fixture-container;;
 *'inspect --format {{.State.Running}} {{.State.ExitCode}}'*) echo 'false 0';;
 *'inspect --format'*) echo healthy;;
esac
`,
  );
  for (const name of ["docker", "free", "flock"]) chmodSync(join(dir, "bin", name), 0o755);
  try {
    const result = spawnSync(
      "bash",
      [resolve("scripts/deploy-vps.sh"), `ghcr.io/terowoc/mcp-telegram@sha256:${"b".repeat(64)}`],
      {
        cwd: dir,
        encoding: "utf8",
        input: "synthetic-token",
        env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, TEST_LOG: join(dir, "commands") },
      },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /private project directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

for (const reason of ["invalid-key", "low-memory"])
  it(`preflight ${reason} leaves previous deployment untouched`, {
    skip: process.platform === "win32",
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-preflight-"));
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "session-key.bin"), Buffer.alloc(reason === "invalid-key" ? 31 : 32, 1), { mode: 0o600 });
    writeFileSync(join(dir, "compose.yaml"), "previous-config");
    writeFileSync(join(dir, "bin/free"), "#!/bin/sh\necho 'Mem: 16000 14000 1000 1000 1000 1024'\n");
    writeFileSync(join(dir, "bin/flock"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(dir, "bin/docker"), "#!/bin/sh\necho unexpected-docker-call >&2\nexit 99\n");
    for (const name of ["docker", "free", "flock"]) chmodSync(join(dir, "bin", name), 0o755);
    try {
      const result = spawnSync(
        "bash",
        [resolve("scripts/deploy-vps.sh"), `ghcr.io/terowoc/mcp-telegram@sha256:${"a".repeat(64)}`],
        {
          cwd: dir,
          encoding: "utf8",
          env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` },
        },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /previous service is unchanged/);
      assert.doesNotMatch(result.stderr, /unexpected-docker-call/);
      assert.equal(readFileSync(join(dir, "compose.yaml"), "utf8"), "previous-config");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
