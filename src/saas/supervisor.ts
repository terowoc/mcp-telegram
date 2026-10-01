import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SaasMediaBudget } from "./media-budget.js";
import type { SessionVault } from "./session-vault.js";
import type { SaasStore } from "./store.js";
import { CapacityError, WorkerBudget } from "./worker-budget.js";

export { CapacityError } from "./worker-budget.js";

import {
  type ChildMessage,
  childMessageSchema,
  type LoginEvent,
  type ParentMessage,
  parseFrame,
} from "./worker-protocol.js";

interface Options {
  store: SaasStore;
  vault: SessionVault;
  apiId: number;
  apiHash: string;
  filesRoot: string;
  maxWorkers?: number;
  idleMs?: number;
  spawn?: typeof fork;
  mediaBudget?: Pick<SaasMediaBudget, "reserve">;
  budget?: WorkerBudget;
}
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  cleanup: () => void;
  settling?: boolean;
  onEvent?: (event: LoginEvent) => void;
  attemptId?: string;
  stagedSession?: string;
  releaseMedia?: () => void;
}
interface Slot {
  lease: { release(): void };
  userId: string;
  policyVersion: number;
  generation: string;
  child?: ChildProcess;
  state: "starting" | "ready" | "stopping";
  ready: Promise<void>;
  resolveReady: () => void;
  rejectReady: (e: Error) => void;
  stopped: Promise<void>;
  resolveStopped: () => void;
  pending: Map<string, Pending>;
  startup?: NodeJS.Timeout;
  idle?: NodeJS.Timeout;
  kill?: NodeJS.Timeout;
  initializing?: Promise<void>;
}

export class WorkerSupervisor {
  private slots = new Map<string, Slot>();
  private closing = false;
  private readonly maxWorkers: number;
  private readonly mediaBudget: Pick<SaasMediaBudget, "reserve">;
  private readonly budget: WorkerBudget;
  constructor(private options: Options) {
    this.maxWorkers = options.maxWorkers ?? 4;
    this.budget = options.budget ?? new WorkerBudget(this.maxWorkers);
    this.mediaBudget = options.mediaBudget ?? new SaasMediaBudget({ root: options.filesRoot });
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < 1 || this.maxWorkers > 32)
      throw new Error("Invalid worker capacity");
    if (options.idleMs !== undefined && (!Number.isSafeInteger(options.idleMs) || options.idleMs < 1))
      throw new Error("Invalid worker idle deadline");
  }
  status(userId: string) {
    const slot = this.slots.get(userId);
    return {
      state: slot?.state ?? "stopped",
      busy: !!slot?.pending.size,
      sessionPresent: !!this.options.store.getEncryptedSession(userId),
      account: this.options.store.getTelegramAccount(userId),
    };
  }
  private acquire(userId: string, signal?: AbortSignal): Slot {
    signal?.throwIfAborted();
    if (this.closing) throw new Error("Worker supervisor is closing");
    const user = this.options.store.findUser(userId);
    if (!user || user.disabled) throw new Error("User is inactive");
    const existing = this.slots.get(userId);
    if (existing) {
      if (existing.policyVersion !== user.policy.version) {
        void this.stopSlot(existing);
        throw new Error("Telegram worker policy changed; previous worker stopping");
      }
      if (existing.state === "stopping") throw new Error("Telegram worker is stopping");
      return existing;
    }
    if (this.slots.size >= this.maxWorkers) throw new CapacityError();
    let resolveReady!: () => void, rejectReady!: (e: Error) => void, resolveStopped!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    // Acquisitions may be cancelled before their readiness subscription is installed.
    void ready.catch(() => {});
    const stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    const slot: Slot = {
      lease: this.budget.reserve(`user:${userId}`),
      userId,
      policyVersion: user.policy.version,
      generation: randomUUID(),
      state: "starting",
      ready,
      resolveReady,
      rejectReady,
      stopped,
      resolveStopped,
      pending: new Map(),
    };
    this.slots.set(userId, slot); // reserve before any asynchronous work
    slot.startup = setTimeout(() => {
      void this.stopSlot(slot);
    }, 10000);
    slot.startup.unref();
    slot.initializing = (async () => {
      try {
        const fileRoot = join(this.options.filesRoot, userId);
        await mkdir(fileRoot, { recursive: true, mode: 0o700 });
        if (slot.state === "stopping") {
          this.finalize(slot);
          return;
        }
        const child = (this.options.spawn ?? fork)(fileURLToPath(new URL("./worker.js", import.meta.url)), [], {
          env: { NODE_ENV: "production", LANG: "C.UTF-8", TZ: "UTC" },
          execArgv: ["--max-old-space-size=256"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "json",
        });
        slot.child = child;
        child.on("message", (message) => this.receive(slot, message));
        child.once("exit", () => this.finalize(slot));
        child.once("error", () => {
          void this.stopSlot(slot);
        });
        const encrypted = this.options.store.getEncryptedSession(userId);
        this.send(slot, {
          kind: "init",
          generation: slot.generation,
          userId,
          apiId: this.options.apiId,
          apiHash: this.options.apiHash,
          fileRoot,
          policy: user.policy,
          session: encrypted ? this.options.vault.decrypt(userId, encrypted) : undefined,
        });
      } catch {
        if (slot.child) void this.stopSlot(slot);
        else this.finalize(slot);
      }
    })();
    return slot;
  }
  private send(slot: Slot, message: ParentMessage) {
    if (!slot.child?.connected) throw new Error("Telegram worker unavailable");
    if (Buffer.byteLength(JSON.stringify(message)) > 4 * 1048576) throw new Error("Worker frame too large");
    slot.child.send(message, (error) => {
      if (error) void this.stopSlot(slot);
    });
  }
  private receive(slot: Slot, raw: unknown) {
    let message: ChildMessage;
    try {
      message = parseFrame(childMessageSchema, raw);
    } catch {
      void this.stopSlot(slot);
      return;
    }
    if (this.slots.get(slot.userId) !== slot || message.generation !== slot.generation || slot.state === "stopping")
      return;
    if (message.kind === "ready") {
      if (slot.state !== "starting") return;
      clearTimeout(slot.startup);
      slot.state = "ready";
      slot.resolveReady();
      this.armIdle(slot);
      return;
    }
    if (message.kind === "session-save" || message.kind === "session-clear") {
      let ok = false;
      try {
        const user = this.options.store.findUser(slot.userId);
        if (!user || user.disabled) throw new Error("Inactive user");
        const login = [...slot.pending.values()].find((p) => p.attemptId);
        if (login) {
          // QR login saves before getMe. Keep its session private until identity is verified.
          login.stagedSession = message.kind === "session-save" ? message.session : undefined;
        } else if (message.kind === "session-save") {
          this.options.store.putEncryptedSession(slot.userId, this.options.vault.encrypt(slot.userId, message.session));
        } else this.options.store.deleteEncryptedSession(slot.userId);
        ok = true;
      } catch {
        /* do not expose storage or session details */
      }
      try {
        this.send(slot, { kind: "ack", generation: slot.generation, id: message.id, ok });
      } catch {
        void this.stopSlot(slot);
      }
      return;
    }
    const pending = slot.pending.get(message.id);
    if (!pending) return;
    if (message.kind === "event") {
      if (pending.attemptId === message.attemptId) {
        try {
          if (message.event.type === "success") {
            if (!pending.stagedSession) throw new Error("Verified session required");
            this.options.store.putVerifiedTelegramSession(
              slot.userId,
              this.options.vault.encrypt(slot.userId, pending.stagedSession),
              message.event.account,
            );
            pending.stagedSession = undefined;
          }
          pending.onEvent?.(message.event);
        } catch {
          void this.stopSlot(slot);
        }
      }
      return;
    }
    if (message.kind === "settled") {
      this.finishPending(slot, message.id);
      return;
    }
    if (message.kind === "result") {
      pending.cleanup();
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      if (message.settling) {
        pending.settling = true;
        return;
      }
      this.finishPending(slot, message.id);
    }
  }
  private finishPending(slot: Slot, id: string) {
    const pending = slot.pending.get(id);
    if (!pending) return;
    pending.cleanup();
    pending.releaseMedia?.();
    clearTimeout(pending.timer);
    slot.pending.delete(id);
    this.armIdle(slot);
  }
  private armIdle(slot: Slot) {
    clearTimeout(slot.idle);
    if (slot.state !== "ready" || slot.pending.size) return;
    slot.idle = setTimeout(() => {
      void this.stopSlot(slot);
    }, this.options.idleMs ?? 300000);
    slot.idle.unref();
  }
  private async waitReady(slot: Slot, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!signal) {
      await slot.ready;
      return;
    }
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Worker request cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      await Promise.race([slot.ready, cancelled]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  private async request(
    userId: string,
    build: (generation: string, id: string) => ParentMessage,
    options: {
      signal?: AbortSignal;
      attemptId?: string;
      onEvent?: (event: LoginEvent) => void;
      timeoutMs?: number;
      reserveMedia?: boolean;
    } = {},
  ): Promise<unknown> {
    const slot = this.acquire(userId, options.signal);
    await this.waitReady(slot, options.signal);
    options.signal?.throwIfAborted();
    if (slot.state !== "ready") throw new Error("Worker unavailable");
    if (slot.pending.size) throw new Error("Telegram worker busy or settling");
    const releaseMedia = options.reserveMedia ? this.mediaBudget.reserve(userId) : undefined;
    clearTimeout(slot.idle);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = () => {
        reject(new Error("Worker request cancelled"));
        try {
          this.send(slot, { kind: "cancel", generation: slot.generation, id });
        } catch {
          void this.stopSlot(slot);
        }
      };
      const cleanup = () => options.signal?.removeEventListener("abort", cancel);
      const timer = setTimeout(() => {
        reject(new Error("Telegram worker deadline exceeded"));
        void this.stopSlot(slot);
      }, options.timeoutMs ?? 34000);
      timer.unref();
      slot.pending.set(id, {
        resolve,
        reject,
        timer,
        cleanup,
        attemptId: options.attemptId,
        onEvent: options.onEvent,
        releaseMedia,
      });
      options.signal?.addEventListener("abort", cancel, { once: true });
      try {
        this.send(slot, build(slot.generation, id));
        if (options.signal?.aborted) cancel();
      } catch {
        reject(new Error("Worker unavailable"));
        void this.stopSlot(slot);
      }
    });
  }
  call(userId: string, name: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
    return this.request(userId, (generation, id) => ({ kind: "tool", generation, id, name, args }), {
      ...options,
      reserveMedia: name === "telegram-download-media",
    });
  }
  async prepareLogin(userId: string): Promise<void> {
    const slot = this.acquire(userId);
    await this.waitReady(slot);
    if (slot.state !== "ready" || slot.pending.size) throw new Error("Telegram worker busy");
  }
  async startLogin(userId: string, attemptId: string, onEvent: (event: LoginEvent) => void): Promise<void> {
    await this.request(userId, (generation, id) => ({ kind: "login-start", generation, id, attemptId }), {
      attemptId,
      onEvent,
      timeoutMs: 365000,
    });
  }
  submitPassword(userId: string, attemptId: string, password: string): void {
    const slot = this.slots.get(userId);
    if (slot?.state !== "ready" || ![...slot.pending.values()].some((p) => p.attemptId === attemptId))
      throw new Error("Login attempt unavailable");
    this.send(slot, { kind: "login-password", generation: slot.generation, id: randomUUID(), attemptId, password });
  }
  async cancelLogin(userId: string, attemptId: string): Promise<void> {
    const slot = this.slots.get(userId);
    if (!slot) return;
    const found = [...slot.pending.entries()].find(([, p]) => p.attemptId === attemptId);
    if (!found) return;
    this.send(slot, { kind: "cancel", generation: slot.generation, id: found[0] });
    // Stop the process so a cancelled QR cannot later be adopted or persist a session.
    await this.stopSlot(slot);
  }
  private finalize(slot: Slot) {
    slot.lease.release();
    clearTimeout(slot.startup);
    clearTimeout(slot.idle);
    clearTimeout(slot.kill);
    slot.rejectReady(new Error("Worker unavailable"));
    for (const [id, pending] of slot.pending) {
      pending.reject(new Error("Worker unavailable"));
      this.finishPending(slot, id);
    }
    slot.state = "stopping";
    clearTimeout(slot.idle);
    if (this.slots.get(slot.userId) === slot) this.slots.delete(slot.userId);
    slot.resolveStopped();
  }
  private async stopSlot(slot: Slot): Promise<void> {
    if (slot.state === "stopping") return slot.stopped;
    slot.state = "stopping";
    slot.rejectReady(new Error("Worker unavailable"));
    clearTimeout(slot.startup);
    clearTimeout(slot.idle);
    if (!slot.child) {
      await slot.initializing;
      if (this.slots.get(slot.userId) === slot) this.finalize(slot);
      return slot.stopped;
    }
    try {
      this.send(slot, { kind: "shutdown", generation: slot.generation, id: randomUUID() });
    } catch {
      /* signal fallback */
    }
    slot.child.kill("SIGTERM");
    slot.kill = setTimeout(() => slot.child?.kill("SIGKILL"), 5000);
    slot.kill.unref();
    return slot.stopped;
  }
  async stopUser(userId: string) {
    const slot = this.slots.get(userId);
    if (slot) await this.stopSlot(slot);
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.slots.values()].map((slot) => this.stopSlot(slot)));
  }
}
