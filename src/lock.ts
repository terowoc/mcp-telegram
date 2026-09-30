import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const DEFAULT_SESSION_DIR = join(homedir(), ".mcp-telegram");

function canonicalSessionPath(): string {
  let path = resolve(process.env.TELEGRAM_SESSION_PATH ?? join(DEFAULT_SESSION_DIR, "session"));
  const missing: string[] = [];
  while (true) {
    try {
      return join(realpathSync.native(path), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(path);
      if (parent === path) throw error;
      missing.unshift(basename(path));
      path = parent;
    }
  }
}

function sessionIdentity(): { dir: string; hash: string } {
  const path = canonicalSessionPath();
  const identity = process.platform === "win32" ? path.toLowerCase() : path;
  return { dir: dirname(path), hash: createHash("sha256").update(identity).digest("hex").slice(0, 32) };
}

export function lockPath(): string {
  const { dir, hash } = sessionIdentity();
  return join(dir, `daemon-${hash}.lock`);
}

/** Full session-file identity isolates accounts even when they share a directory. */
export function socketPath(): string {
  const { dir, hash } = sessionIdentity();
  if (process.platform === "win32") return `\\\\.\\pipe\\mcp-telegram-${hash}`;
  const candidate = join(dir, `daemon-${hash}.sock`);
  if (Buffer.byteLength(candidate) <= 100) return candidate;
  const shortDir = join("/tmp", `mcp-telegram-ipc-${process.getuid?.() ?? "user"}`);
  mkdirSync(shortDir, { recursive: true, mode: 0o700 });
  const info = lstatSync(shortDir);
  const uid = process.getuid?.();
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (uid !== undefined && (info.uid !== uid || (info.mode & 0o077) !== 0))
  )
    throw new Error("Unsafe private IPC directory");
  return join(shortDir, `${hash}.sock`);
}

/**
 * Try to acquire the master lock.
 * Returns true if this process is now the master.
 * Returns false if another live master process holds the lock.
 *
 * Uses PID file + kill -0 to detect stale locks after crashes.
 */
export function tryAcquireLock(): boolean {
  const lock = lockPath();
  const dir = dirname(lock);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const legacy = join(dir, "daemon.lock");
  if (existsSync(legacy)) {
    const pid = Number.parseInt(readFileSync(legacy, "utf8").trim(), 10);
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        console.error(
          "[mcp-telegram] Legacy daemon is running; restart it with the updated version before connecting.",
        );
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      }
    }
  }

  if (existsSync(lock)) {
    try {
      const pid = Number.parseInt(readFileSync(lock, "utf-8").trim(), 10);
      if (!Number.isNaN(pid) && pid > 0) {
        try {
          // kill -0: check if process is alive without sending a signal
          process.kill(pid, 0);
          // Process is alive — another master owns the lock
          return false;
        } catch (err) {
          // ESRCH: process not found — stale lock, take over.
          // EPERM: process is alive but owned by another uid we can't signal —
          // treat as a live owner and DON'T steal the lock.
          if ((err as NodeJS.ErrnoException).code === "EPERM") return false;
          unlinkSync(lock);
        }
      }
    } catch {
      // Unreadable lock — remove and take over
      try {
        unlinkSync(lock);
      } catch {}
    }
  }

  try {
    // O_EXCL flag: atomic exclusive create — prevents TOCTOU race between two simultaneous starts
    writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
    return true;
  } catch {
    // EEXIST: another process just created the lock — we lost the race, become client
    return false;
  }
}

export function releaseLock(lock: string = lockPath()): void {
  try {
    if (existsSync(lock)) {
      const pid = Number.parseInt(readFileSync(lock, "utf-8").trim(), 10);
      // Only remove our own lock
      if (pid === process.pid) unlinkSync(lock);
    }
  } catch {}
}

export function releaseSocket(sock: string = socketPath(), lock: string = lockPath()): void {
  try {
    if (!existsSync(sock)) return;
    // Ownership guard (mirrors releaseLock): never unlink a socket owned by a different,
    // still-alive process. Otherwise any process that imports this module and exits (e.g. a
    // one-shot run or a test on the same host) would delete a running daemon's socket file,
    // leaving the daemon listening in memory but unreachable for new clients.
    if (existsSync(lock)) {
      const pid = Number.parseInt(readFileSync(lock, "utf-8").trim(), 10);
      // Ignore non-positive PIDs (e.g. 0) so kill() can't probe our own process group.
      if (!Number.isNaN(pid) && pid > 0 && pid !== process.pid) {
        try {
          process.kill(pid, 0); // foreign owner still alive?
          return; // yes — leave its socket alone
        } catch (err) {
          // ESRCH: stale owner — safe to remove. EPERM: owner is alive under a
          // different uid (e.g. a systemd daemon) — leave its socket alone too.
          if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        }
      }
    }
    unlinkSync(sock);
  } catch {
    // Best-effort cleanup, called from a process.on("exit") handler where throwing would
    // turn an orderly shutdown into a crash. A leftover socket file is recoverable: the
    // next master calls releaseSocket() again before listening. On win32 socketPath() is a
    // named pipe, existsSync() is false and we return before ever reaching unlinkSync.
  }
}
