import { type ChildProcessByStdio, spawn } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { GlobalLock } from "../global-lock.js";
import type { WorkerBudget } from "../saas/worker-budget.js";
import { InstagramPolicy } from "./policy.js";
import { type ChildFrame, childFrame, safeCode } from "./protocol.js";
import type { InstagramStore } from "./store.js";
import { externalId, type InstagramConnection, InstagramError } from "./types.js";
import type { InstagramVault } from "./vault.js";

export interface InstagramAttempt {
  id: string;
  state: "starting" | "needs-code" | "needs-verification" | "connected" | "failed" | "cancelled" | "expired";
  expiresAt: number;
  code?: string;
}
interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
}
interface Slot {
  connection: InstagramConnection;
  generation: string;
  child: ChildProcessByStdio<Writable, Readable, null>;
  ready: Promise<void>;
  resolveReady(): void;
  rejectReady(e: Error): void;
  stopped: Promise<void>;
  resolveStopped(): void;
  stopping: boolean;
  initialized: boolean;
  pending: Map<string, Pending>;
  lock: GlobalLock;
  lastUsed: number;
  claims: number;
  buffer: Buffer;
  lease: { release(): void };
  startup: NodeJS.Timeout;
  kill?: NodeJS.Timeout;
}
type AttemptRecord = {
  owner: string;
  connection: string;
  generation: string;
  view: InstagramAttempt;
  timer: NodeJS.Timeout;
  saved: boolean;
};
interface Options {
  store: InstagramStore;
  vault: InstagramVault;
  budget: WorkerBudget;
  python: string;
  filesRoot: string;
  idleMs: number;
  workerPath?: string;
  spawn?: typeof spawn;
  toolMs?: number;
  loginMs?: number;
}
export class InstagramSupervisor {
  private slots = new Map<string, Slot>();
  private attempts = new Map<string, AttemptRecord>();
  private failures = new Map<string, string>();
  private admission = new GlobalLock(4);
  private closing = false;
  private maintenance: NodeJS.Timeout;
  constructor(private options: Options) {
    options.store.recoverSends();
    this.maintenance = setInterval(
      () => {
        for (const s of this.slots.values())
          if (
            !s.claims &&
            !s.pending.size &&
            !s.lock.isLocked() &&
            !this.activeAttempt(s.connection.id) &&
            Date.now() - s.lastUsed > options.idleMs
          )
            void this.stop(s.connection.id);
      },
      Math.min(options.idleMs, 60000),
    );
    this.maintenance.unref();
  }
  async validateRuntime(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const c = spawn(this.options.python, [this.path(), "--check"], {
        env: this.env(),
        stdio: ["ignore", "pipe", "ignore"],
      });
      let data = "";
      c.stdout.on("data", (b) => {
        data += b;
        if (data.length > 1024) c.kill();
      });
      const timer = setTimeout(() => {
        c.kill("SIGKILL");
        reject(new InstagramError("invalid-runtime"));
      }, 10000);
      c.on("error", () => {
        clearTimeout(timer);
        reject(new InstagramError("invalid-runtime"));
      });
      c.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && data.trim() === "instagram-runtime-ok") resolve();
        else reject(new InstagramError("invalid-runtime"));
      });
    });
  }
  private path(): string {
    return this.options.workerPath ?? fileURLToPath(new URL("./worker.py", import.meta.url));
  }
  private env(): NodeJS.ProcessEnv {
    return { PATH: process.env.PATH, LANG: "C.UTF-8", TZ: "UTC", PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1" };
  }
  private owned(owner: string, id: string): InstagramConnection {
    const c = this.options.store.get(owner, id);
    if (!c) throw new InstagramError("not-found");
    return c;
  }
  status(owner: string, id: string) {
    const c = this.owned(owner, id),
      s = this.slots.get(id);
    return {
      state: s?.stopping ? "stopping" : s?.initialized ? "ready" : s ? "starting" : "stopped",
      busy: !!s?.claims,
      sessionPresent: !!c.envelope,
      account: c.account,
      code: this.failures.get(id),
      cooldownUntil: c.cooldownUntil,
    };
  }
  private activeAttempt(id: string): AttemptRecord | undefined {
    return [...this.attempts.values()].find(
      (a) => a.connection === id && ["starting", "needs-code"].includes(a.view.state),
    );
  }
  private current(s: Slot): boolean {
    return (
      !s.stopping &&
      this.slots.get(s.connection.id) === s &&
      this.options.store.get(s.connection.ownerId, s.connection.id)?.generation === s.connection.generation
    );
  }
  private upstreamAllowed(c: InstagramConnection): void {
    if (c.cooldownUntil > Date.now()) throw new InstagramError("rate-limited");
    const failure = this.failures.get(c.id);
    if (failure && ["needs-login", "needs-verification", "identity-mismatch"].includes(failure))
      throw new InstagramError(failure);
  }
  private failure(s: Slot, code: string): void {
    this.failures.set(s.connection.id, code);
    if (code === "rate-limited") this.options.store.cooldown(s.connection.id, Date.now() + 60000);
    if (["needs-login", "needs-verification", "identity-mismatch"].includes(code)) {
      // Invalid credentials cannot resume automation after a restart. Recovery
      // requires an explicit fresh login, and access changes revoke grants.
      this.options.store.disconnect(s.connection.ownerId, s.connection.id);
      void this.stop(s.connection.id);
    }
  }
  private async acquire(owner: string, id: string): Promise<Slot> {
    const release = await this.admission.acquire();
    try {
      if (this.closing) throw new InstagramError("worker-unavailable");
      const c = this.owned(owner, id);
      // New login attempts have no saved credentials and may recover a blocked session.
      if (c.envelope) this.upstreamAllowed(c);
      else if (c.cooldownUntil > Date.now()) throw new InstagramError("rate-limited");
      let s = this.slots.get(id);
      if (s && (s.stopping || s.connection.generation !== c.generation)) {
        await this.stop(id);
        s = undefined;
      }
      if (!s) {
        let lease: { release(): void };
        try {
          lease = await this.options.budget.reserveWithReclaim(`instagram:${id}`);
        } catch {
          throw new InstagramError("capacity");
        }
        try {
          const root = join(this.options.filesRoot, "instagram", id);
          await mkdir(root, { recursive: true, mode: 0o700 });
          // Admission remains reserved across directory creation and worker startup.
          if (this.closing || this.owned(owner, id).generation !== c.generation)
            throw new InstagramError("worker-unavailable");
          const latest = this.owned(owner, id);
          if (latest.envelope) this.upstreamAllowed(latest);
          else if (latest.cooldownUntil > Date.now()) throw new InstagramError("rate-limited");
          const child = (this.options.spawn ?? spawn)(this.options.python, [this.path()], {
            cwd: root,
            env: this.env(),
            stdio: ["pipe", "pipe", "ignore"],
          }) as ChildProcessByStdio<Writable, Readable, null>;
          let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveStopped!: () => void;
          const ready = new Promise<void>((r, j) => {
            resolveReady = r;
            rejectReady = j;
          });
          void ready.catch(() => {});
          const stopped = new Promise<void>((r) => {
            resolveStopped = r;
          });
          s = {
            connection: c,
            generation: randomUUID(),
            child,
            ready,
            resolveReady,
            rejectReady,
            stopped,
            resolveStopped,
            stopping: false,
            initialized: false,
            pending: new Map(),
            lock: new GlobalLock(4),
            lastUsed: Date.now(),
            claims: 0,
            buffer: Buffer.alloc(0),
            lease,
            startup: setTimeout(() => void this.stop(id), 10000),
          };
          s.startup.unref();
          this.slots.set(id, s);
          const slot = s;
          child.stdout.on("data", (b) => this.read(slot, b));
          child.stdin.on("error", () => void this.stop(id));
          child.on("error", () => {
            this.finalize(slot);
          });
          child.once("exit", () => this.finalize(slot));
          this.send(slot, {
            kind: "init",
            policy: c.policy,
            expectedId: c.account?.id,
            session: c.envelope ? this.options.vault.decrypt(owner, id, c.envelope) : undefined,
          });
        } catch (e) {
          if (s) await this.stop(id);
          else lease.release();
          throw e;
        }
      }
      s.claims++;
      s.lastUsed = Date.now();
      return s;
    } finally {
      release();
    }
  }
  private send(s: Slot, value: Record<string, unknown>): void {
    if (s.stopping) throw new InstagramError("worker-unavailable");
    const frame = `${JSON.stringify({ ...value, generation: s.generation })}\n`;
    if (Buffer.byteLength(frame) > 262144) throw new InstagramError("invalid-request");
    s.child.stdin.write(frame);
  }
  private read(s: Slot, chunk: Buffer): void {
    if (s.stopping) return;
    s.buffer = Buffer.concat([s.buffer, chunk]);
    if (s.buffer.length > 262144) {
      void this.stop(s.connection.id);
      return;
    }
    for (;;) {
      const index = s.buffer.indexOf(10);
      if (index < 0) break;
      const line = s.buffer.subarray(0, index);
      s.buffer = s.buffer.subarray(index + 1);
      try {
        const f = childFrame.parse(JSON.parse(line.toString("utf8")));
        if (f.generation !== s.generation || !this.current(s)) throw new Error();
        this.receive(s, f);
      } catch {
        void this.stop(s.connection.id);
        return;
      }
    }
  }
  private receive(s: Slot, f: ChildFrame): void {
    if (f.kind === "ready") {
      if (s.initialized) throw new Error("Unexpected ready");
      clearTimeout(s.startup);
      if (f.error) {
        this.failure(s, safeCode(f.error));
        s.rejectReady(new InstagramError(safeCode(f.error)));
        void this.stop(s.connection.id);
      } else {
        s.initialized = true;
        this.failures.delete(s.connection.id);
        s.resolveReady();
      }
      return;
    }
    if (f.kind === "session") {
      const a = f.attemptId ? this.attempts.get(f.attemptId) : undefined;
      if (
        f.attemptId &&
        (!a ||
          a.connection !== s.connection.id ||
          a.generation !== s.connection.generation ||
          a.view.state !== "starting" ||
          a.view.expiresAt <= Date.now())
      )
        return;
      if (!f.attemptId && !s.connection.envelope) return;
      const envelope = this.options.vault.encrypt(s.connection.ownerId, s.connection.id, f.session);
      try {
        if (
          this.options.store.save(s.connection.ownerId, s.connection.id, s.connection.generation, envelope, f.account)
        ) {
          s.connection.envelope = envelope;
          s.connection.account = f.account;
          if (a) a.saved = true;
        }
      } catch (e) {
        if (a) {
          a.view.state = "failed";
          a.view.code = e instanceof InstagramError ? e.code : "login-failed";
          clearTimeout(a.timer);
        }
        void this.stop(s.connection.id);
      }
      return;
    }
    if (f.kind === "event") {
      const a = this.attempts.get(f.attemptId);
      if (
        !a ||
        a.connection !== s.connection.id ||
        a.generation !== s.connection.generation ||
        a.view.expiresAt <= Date.now() ||
        !["starting", "needs-code"].includes(a.view.state)
      )
        return;
      if (f.state === "connected" && !a.saved) throw new Error("Unverified login");
      a.view.state = f.state;
      if (f.error) {
        a.view.code = safeCode(f.error);
        if (f.diagnostic) console.warn("[instagram] login rejected", JSON.stringify({ code: a.view.code, ...f.diagnostic }));
        if (a.view.code === "rate-limited") this.options.store.cooldown(s.connection.id, Date.now() + 60000);
      } else delete a.view.code;
      if (f.state !== "needs-code") {
        clearTimeout(a.timer);
        if (f.state !== "connected") void this.stop(s.connection.id);
      }
      return;
    }
    const p = s.pending.get(f.id);
    if (!p) return;
    s.pending.delete(f.id);
    clearTimeout(p.timer);
    p.cleanup();
    if (f.error) {
      const code = safeCode(f.error);
      this.failure(s, code);
      p.reject(new InstagramError(code));
    } else p.resolve(f.result);
  }
  private finalize(s: Slot): void {
    if (this.slots.get(s.connection.id) !== s) return;
    s.stopping = true;
    clearTimeout(s.startup);
    clearTimeout(s.kill);
    s.rejectReady(new InstagramError("worker-unavailable"));
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.cleanup();
      p.reject(new InstagramError("worker-unavailable"));
    }
    s.pending.clear();
    this.slots.delete(s.connection.id);
    s.lease.release();
    s.resolveStopped();
    const a = this.activeAttempt(s.connection.id);
    if (a) {
      clearTimeout(a.timer);
      a.view.state = "failed";
      a.view.code = "worker-unavailable";
    }
  }
  async stop(id: string): Promise<void> {
    const s = this.slots.get(id);
    if (!s) return;
    if (!s.stopping) {
      s.stopping = true;
      s.child.stdin.end(`${JSON.stringify({ kind: "shutdown", generation: s.generation })}\n`);
      s.child.kill("SIGTERM");
      s.kill = setTimeout(() => s.child.kill("SIGKILL"), 2000);
      s.kill.unref();
    }
    await s.stopped;
  }
  async evictIdle(): Promise<void> {
    const idle = [...this.slots.values()]
      .filter(
        (s) =>
          s.initialized &&
          !s.stopping &&
          !s.claims &&
          !s.pending.size &&
          !s.lock.isLocked() &&
          !this.activeAttempt(s.connection.id),
      )
      .sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (idle) await this.stop(idle.connection.id);
  }
  private async request(s: Slot, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (!this.current(s)) throw new InstagramError("worker-unavailable");
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const fail = () => {
        const p = s.pending.get(id);
        if (!p) return;
        s.pending.delete(id);
        clearTimeout(p.timer);
        p.cleanup();
        reject(new InstagramError("worker-unavailable"));
        void this.stop(s.connection.id);
      };
      const timer = setTimeout(fail, this.options.toolMs ?? 45000);
      timer.unref();
      s.pending.set(id, { resolve, reject, timer, cleanup: () => signal.removeEventListener("abort", fail) });
      signal.addEventListener("abort", fail, { once: true });
      try {
        this.send(s, { kind: "tool", id, name, args });
      } catch {
        fail();
      }
    });
  }
  async call(
    owner: string,
    id: string,
    name: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal } = {},
  ): Promise<unknown> {
    const initial = this.owned(owner, id);
    new InstagramPolicy(initial.policy).authorize(name, args);
    if (name === "instagram-status") return this.status(owner, id);
    this.upstreamAllowed(initial);
    if (!initial.envelope) throw new InstagramError("needs-login");
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(this.options.toolMs ?? 45000)])
      : AbortSignal.timeout(this.options.toolMs ?? 45000);
    signal.throwIfAborted();
    const s = await this.acquire(owner, id);
    let unlock: (() => void) | undefined;
    let write = false;
    let dispatched = false;
    let requestId = "";
    try {
      await s.ready;
      unlock = await s.lock.acquire(signal);
      signal.throwIfAborted();
      const c = this.owned(owner, id);
      if (c.generation !== s.connection.generation) throw new InstagramError("worker-unavailable");
      new InstagramPolicy(c.policy).authorize(name, args);
      this.upstreamAllowed(c);
      if (name === "instagram-send-message") {
        requestId = z.uuid().parse(args.requestId);
        const text = z
          .string()
          .refine((v) => [...v].length >= 1 && [...v].length <= 1000)
          .parse(args.text);
        externalId.parse(args.threadId);
        const digest = createHmac("sha256", this.options.vault.digestKey)
          .update(JSON.stringify([c.generation, args.threadId, text]))
          .digest("hex");
        const old = this.options.store.beginSend(id, c.generation, requestId, digest);
        if (old.state === "confirmed") return old.result;
        if (old.state !== "new")
          throw new InstagramError(old.state === "pending" ? "send-in-progress" : "delivery-unknown");
        write = true;
      }
      dispatched = true;
      const result = await this.request(s, name, args, signal);
      if (write) {
        const confirmed = z.strictObject({ id: externalId, timestamp: z.string().max(64) }).parse(result);
        this.options.store.finishSend(id, c.generation, requestId, confirmed);
      }
      return result;
    } catch (e) {
      if (write) {
        this.options.store.finishSend(id, s.connection.generation, requestId);
        throw new InstagramError(dispatched ? "delivery-unknown" : "worker-unavailable");
      }
      throw e;
    } finally {
      if (s.stopping) await s.stopped;
      unlock?.();
      s.claims--;
      s.lastUsed = Date.now();
    }
  }
  async startLogin(
    owner: string,
    id: string,
    credentials: { username: string; password: string },
  ): Promise<InstagramAttempt> {
    const c = this.owned(owner, id);
    if (c.envelope) throw new InstagramError("already-connected");
    if (this.activeAttempt(id)) throw new InstagramError("login-active");
    if (c.cooldownUntil > Date.now()) throw new InstagramError("rate-limited");
    const s = await this.acquire(owner, id);
    try {
      await s.ready;
      if (this.activeAttempt(id)) throw new InstagramError("login-active");
      const view: InstagramAttempt = {
        id: randomUUID(),
        state: "starting",
        expiresAt: Date.now() + (this.options.loginMs ?? 300000),
      };
      // Keep only one bounded view per connection, never credential submissions.
      for (const [key, a] of this.attempts)
        if (a.connection === id) {
          clearTimeout(a.timer);
          this.attempts.delete(key);
        }
      const timer = setTimeout(() => {
        view.state = "expired";
        void this.stop(id);
      }, this.options.loginMs ?? 300000);
      timer.unref();
      this.attempts.set(view.id, { owner, connection: id, generation: c.generation, view, timer, saved: false });
      this.send(s, { kind: "login", attemptId: view.id, credentials });
      return { ...view };
    } finally {
      s.claims--;
    }
  }
  attempt(owner: string, id: string, attempt: string): InstagramAttempt | undefined {
    const a = this.attempts.get(attempt);
    if (!a || a.owner !== owner || a.connection !== id || !this.options.store.get(owner, id)) return undefined;
    return { ...a.view };
  }
  submitCode(owner: string, id: string, attempt: string, code: string): void {
    const a = this.attempts.get(attempt),
      s = this.slots.get(id);
    if (!this.attempt(owner, id, attempt) || !a || a.view.state !== "needs-code" || !s || !this.current(s))
      throw new InstagramError("not-found");
    a.view.state = "starting";
    this.send(s, { kind: "code", attemptId: attempt, code });
  }
  async cancelLogin(owner: string, id: string, attempt: string): Promise<void> {
    const a = this.attempts.get(attempt);
    if (!a || a.owner !== owner || a.connection !== id) throw new InstagramError("not-found");
    if (["starting", "needs-code"].includes(a.view.state)) {
      clearTimeout(a.timer);
      a.view.state = "cancelled";
      await this.stop(id);
    }
  }
  async clearOwner(owner: string, all = false): Promise<void> {
    for (const a of this.attempts.values())
      if (a.owner === owner && ["starting", "needs-code"].includes(a.view.state)) {
        clearTimeout(a.timer);
        a.view.state = "cancelled";
        await this.stop(a.connection);
      }
    if (all)
      await Promise.all(
        [...this.slots.values()].filter((s) => s.connection.ownerId === owner).map((s) => this.stop(s.connection.id)),
      );
  }
  async purge(id: string): Promise<void> {
    await this.stop(id);
    await rm(join(this.options.filesRoot, "instagram", id), { recursive: true, force: true });
    this.options.store.finishRemoval(id);
    this.failures.delete(id);
    for (const [key, a] of this.attempts)
      if (a.connection === id) {
        clearTimeout(a.timer);
        this.attempts.delete(key);
      }
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.maintenance);
    for (const a of this.attempts.values()) clearTimeout(a.timer);
    await Promise.all([...this.slots.keys()].map((id) => this.stop(id)));
    this.attempts.clear();
  }
}
