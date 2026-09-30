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
  it(`deploy updates only mcp and ${fail ? "rolls back failure" : "keeps healthy image"} (stopped=${stopped}, stopFailure=${stopFailure})`, {
    skip: process.platform === "win32",
  }, () => {
    const dir = mkdtempSync(join(tmpdir(), "mcp-deploy-"));
    const image = `ghcr.io/terowoc/mcp-telegram@sha256:${"a".repeat(64)}`;
    const old = `ghcr.io/terowoc/mcp-telegram@sha256:${"b".repeat(64)}`;
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "data/auth"), { recursive: true });
    writeFileSync(join(dir, "deployment.env"), `MCP_IMAGE=${old}\n`);
    writeFileSync(join(dir, "data/auth/proof"), "persist");
    writeFileSync(join(dir, "compose.yaml"), "services: {}\n");
    writeFileSync(join(dir, "bin/flock"), "#!/bin/sh\nexit 0\n");
    writeFileSync(
      join(dir, "bin/docker"),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> "$TEST_LOG"\ncase "$*" in\n *'login ghcr.io'*) cat >/dev/null;;\n *'ps -a -q mcp'*) echo old-container;;\n *'ps -q mcp'*) if [ '${stopped}' = false ] || [ -f started ]; then echo old-container; fi;;\n *'stop mcp'*) if [ '${stopFailure}' = true ] && [ -f started ]; then exit 1; fi;;\n *'up -d --no-deps mcp'*) touch started;;\n *'inspect --format'*) if [ '${fail}' = true ] && grep -q '${image}' deployment.env; then echo unhealthy; else echo healthy; fi;;\nesac\n`,
    );
    chmodSync(join(dir, "bin/docker"), 0o755);
    chmodSync(join(dir, "bin/flock"), 0o755);
    const result = spawnSync("bash", [resolve("scripts/deploy-vps.sh"), image], {
      cwd: dir,
      encoding: "utf8",
      input: "temporary-registry-token",
      env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, TEST_LOG: join(dir, "commands") },
    });
    assert.equal(result.status, fail ? 1 : 0, result.stderr);
    const commands = readFileSync(join(dir, "commands"), "utf8");
    assert.match(commands, /-p mcp-telegram/);
    assert.match(commands, /stop mcp/);
    assert.match(commands, /up -d --no-deps mcp/);
    assert.doesNotMatch(commands, /prune|down|restart/);
    assert.equal(
      readFileSync(join(dir, "deployment.env"), "utf8"),
      `MCP_IMAGE=${fail && !stopFailure ? old : image}\n`,
    );
    assert.equal(readFileSync(join(dir, "data/auth/proof"), "utf8"), "persist");
    assert.doesNotMatch(result.stdout + result.stderr, /temporary-registry-token/);
    if (stopFailure) assert.match(result.stderr, /auth storage left intact/);
    else assert.doesNotMatch(result.stderr, /Rollback failed/);
    rmSync(dir, { recursive: true, force: true });
  });
