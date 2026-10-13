import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { GlobalLock } from "../global-lock.js";
import { MEDIA_CHUNK_BYTES } from "../media-upload.js";
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
  queueWaitMs?: number;
  onTiming?: (timing: {
    tool: string;
    totalMs: number;
    admissionMs: number;
    queueMs: number;
    executionMs: number;
    cold: boolean;
    connectionMs: number;
    connectionCold: boolean;
    outcome: "ok" | "error";
  }) => void;
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
  releaseOperation?: () => void;
  cancelled?: boolean;
  onWorkerTiming?: (timing: { connectionMs: number; connectionCold: boolean }) => void;
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
  lock: GlobalLock;
  claims: number;
  lastUsed: number;
}

export class WorkerSupervisor {
  private slots = new Map<string, Slot>();
  private closing = false;
  private admission = new GlobalLock(32);
  private sequence = 0;
  private readonly maxWorkers: number;
  private readonly mediaBudget: Pick<SaasMediaBudget, "reserve">;
  private readonly budget: WorkerBudget;
  constructor(private options: Options) {
    this.maxWorkers = options.maxWorkers ?? 4;
    this.budget = options.budget ?? new WorkerBudget(this.maxWorkers);
    this.mediaBudget = options.mediaBudget ?? new SaasMediaBudget({ root: options.filesRoot });
    if (!Number.isSafeInteger(this.maxWorkers) || this.maxWorkers < 1 || this.maxWorkers > 32)
      throw new Error("Invalid worker capacity");
    if (
      options.queueWaitMs !== undefined &&
      (!Number.isSafeInteger(options.queueWaitMs) || options.queueWaitMs < 1 || options.queueWaitMs > 10000)
    )
      throw new Error("Invalid worker queue deadline");
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
  private claim(slot: Slot): Slot {
    slot.claims++;
    slot.lastUsed = ++this.sequence;
    clearTimeout(slot.idle);
    return slot;
  }
  private async acquire(userId: string, signal?: AbortSignal): Promise<Slot> {
    try {
      return this.claim(this.acquireSlot(userId, signal));
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error;
    }
    // Serialize replacement and keep the old reservation until the child actually exits.
    const release = await this.admission.acquire(signal);
    try {
      try {
        return this.claim(this.acquireSlot(userId, signal));
      } catch (error) {
        if (!(error instanceof CapacityError)) throw error;
      }
      const idle = [...this.slots.values()]
        .filter((slot) => slot.state === "ready" && !slot.pending.size && !slot.claims && !slot.lock.isLocked())
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new CapacityError();
      await this.waitFor(this.stopSlot(idle), signal);
      return this.claim(this.acquireSlot(userId, signal));
    } finally {
      release();
    }
  }
  async evictIdle(): Promise<void> {
    const release = await this.admission.acquire();
    try {
      if (this.closing) throw new Error("Worker supervisor is closing");
      if (!this.budget.isFull()) return;
      const idle = [...this.slots.values()]
        .filter((slot) => slot.state === "ready" && !slot.pending.size && !slot.claims && !slot.lock.isLocked())
        .sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (!idle) throw new CapacityError();
      await this.stopSlot(idle);
    } finally {
      release();
    }
  }
  private acquireSlot(userId: string, signal?: AbortSignal): Slot {
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
      lock: new GlobalLock(4),
      claims: 0,
      lastUsed: 0,
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
            if (pending.cancelled || !pending.stagedSession) throw new Error("Verified session required");
            this.options.store.putVerifiedTelegramSession(
              slot.userId,
              this.options.vault.encrypt(slot.userId, pending.stagedSession),
              message.event.account,
            );
            pending.stagedSession = undefined;
          }
          pending.onEvent?.(message.event);
        } catch (error) {
          pending.onEvent?.({
            type: "error",
            code:
              error instanceof Error && error.message === "Telegram account already added"
                ? "account-already-added"
                : "login-failed",
          });
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
      if (message.timing) pending.onWorkerTiming?.(message.timing);
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
    pending.releaseOperation?.();
    this.armIdle(slot);
  }
  private armIdle(slot: Slot) {
    clearTimeout(slot.idle);
    if (slot.state !== "ready" || slot.pending.size || slot.claims || slot.lock.isLocked()) return;
    slot.idle = setTimeout(() => {
      void this.stopSlot(slot);
    }, this.options.idleMs ?? 1800000);
    slot.idle.unref();
  }
  private waitReady(slot: Slot, signal?: AbortSignal) {
    return this.waitFor(slot.ready, signal);
  }
  private async waitFor(ready: Promise<void>, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (!signal) {
      await ready;
      return;
    }
    let cancel: () => void = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      cancel = () => reject(new Error("Worker request cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });
    try {
      await Promise.race([ready, cancelled]);
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
      mediaWrites?: Array<{ bytes?: number; files?: number }>;
      queue?: boolean;
      tool?: string;
    } = {},
  ): Promise<unknown> {
    const started = performance.now();
    const deadlineAt = Date.now() + (options.timeoutMs ?? 34000);
    const deadline = new AbortController();
    const deadlineTimer = setTimeout(
      () => deadline.abort(new Error("Telegram worker deadline exceeded")),
      options.timeoutMs ?? 34000,
    );
    deadlineTimer.unref();
    const signal = options.signal ? AbortSignal.any([options.signal, deadline.signal]) : deadline.signal;
    const cold = !this.slots.has(userId);
    let slot: Slot | undefined;
    let releaseOperation: (() => void) | undefined;
    let transferred = false;
    let admissionMs = 0,
      queueMs = 0,
      executionStarted = 0,
      connectionMs = 0,
      connectionCold = false;
    let outcome: "ok" | "error" = "error";
    try {
      slot = await this.acquire(userId, signal);
      await this.waitReady(slot, signal);
      admissionMs = performance.now() - started;
      signal?.throwIfAborted();
      if (slot.state !== "ready") throw new Error("Worker unavailable");
      if ([...slot.pending.values()].some((p) => p.settling || p.cancelled || p.attemptId))
        throw new Error("Telegram worker busy or settling");
      if (!options.queue && slot.lock.isLocked()) throw new Error("Telegram worker busy");
      const queuedAt = performance.now();
      const wait = new AbortController();
      const timer = setTimeout(
        () => wait.abort(new Error("Telegram worker busy: queue deadline exceeded")),
        this.options.queueWaitMs ?? 5000,
      );
      timer.unref();
      try {
        releaseOperation = await slot.lock.acquire(signal ? AbortSignal.any([signal, wait.signal]) : wait.signal);
      } finally {
        clearTimeout(timer);
      }
      queueMs = performance.now() - queuedAt;
      signal?.throwIfAborted();
      if (slot.state !== "ready" || this.slots.get(userId) !== slot) throw new Error("Worker unavailable");
      const user = this.options.store.findUser(userId);
      if (!user || user.disabled || user.policy.version !== slot.policyVersion)
        throw new Error("Telegram worker policy changed");
      if (Date.now() >= deadlineAt) throw new Error("Telegram worker deadline exceeded");
      const mediaReleases: Array<() => void> = [];
      try {
        for (const write of options.mediaWrites ?? []) mediaReleases.push(this.mediaBudget.reserve(userId, write));
      } catch (error) {
        for (const release of mediaReleases) release();
        throw error;
      }
      const releaseMedia = () => {
        for (const release of mediaReleases) release();
      };
      const current = slot;
      const id = randomUUID();
      executionStarted = performance.now();
      const result = await new Promise((resolve, reject) => {
        const cancel = () => {
          const pending = current.pending.get(id);
          if (pending) pending.cancelled = true;
          reject(new Error("Worker request cancelled"));
          try {
            this.send(current, { kind: "cancel", generation: current.generation, id });
          } catch {
            void this.stopSlot(current);
          }
        };
        const cleanup = () => signal?.removeEventListener("abort", cancel);
        const timer = setTimeout(
          () => {
            reject(new Error("Telegram worker deadline exceeded"));
            void this.stopSlot(current);
          },
          Math.max(1, deadlineAt - Date.now()),
        );
        timer.unref();
        current.pending.set(id, {
          resolve,
          reject,
          timer,
          cleanup,
          attemptId: options.attemptId,
          onEvent: options.onEvent,
          releaseMedia,
          releaseOperation,
          onWorkerTiming: (timing) => {
            connectionMs = timing.connectionMs;
            connectionCold = timing.connectionCold;
          },
        });
        transferred = true; // Exclusivity survives logical cancellation until physical settlement.
        signal?.addEventListener("abort", cancel, { once: true });
        try {
          const message = build(current.generation, id);
          if (message.kind === "tool") message.deadlineAt = deadlineAt;
          this.send(current, message);
          if (signal?.aborted) cancel();
        } catch {
          reject(new Error("Worker unavailable"));
          void this.stopSlot(current);
        }
      });
      outcome = result && typeof result === "object" && "isError" in result && result.isError === true ? "error" : "ok";
      return result;
    } finally {
      clearTimeout(deadlineTimer);
      if (!transferred) releaseOperation?.();
      if (slot) {
        slot.claims--;
        this.armIdle(slot);
      }
      if (options.tool && this.options.onTiming) {
        try {
          this.options.onTiming({
            tool: /^telegram-[a-z-]{1,64}$/.test(options.tool) ? options.tool : "unknown",
            totalMs: Math.round(performance.now() - started),
            admissionMs: Math.round(admissionMs),
            queueMs: Math.round(queueMs),
            executionMs: executionStarted ? Math.round(performance.now() - executionStarted) : 0,
            cold,
            connectionMs,
            connectionCold,
            outcome,
          });
        } catch {
          /* Diagnostics must not affect Telegram operations. */
        }
      }
    }
  }

  call(userId: string, name: string, args: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
    const mediaWrites: Array<{ bytes?: number; files?: number }> = [];
    const remote = { bytes: 20 * 1048576 + 1024, files: 3 }; // payload, metadata and atomic metadata replacement
    if (name === "telegram-download-media") mediaWrites.push({});
    if (name === "telegram-upload-media")
      mediaWrites.push(args.fileId ? { bytes: MEDIA_CHUNK_BYTES + 1024, files: 1 } : remote);
    const sourceTools = new Set([
      "telegram-send-file",
      "telegram-send-voice",
      "telegram-send-video-note",
      "telegram-set-profile-photo",
      "telegram-send-story",
      "telegram-edit-story",
      "telegram-edit-group",
    ]);
    if (sourceTools.has(name) && (typeof args.fileUrl === "string" || args.file !== undefined))
      mediaWrites.push(remote);
    let albumDownloads = 0;
    if (name === "telegram-send-album" && Array.isArray(args.items)) {
      for (const item of args.items.slice(0, 10))
        if (item && typeof item === "object" && (typeof item.fileUrl === "string" || item.file !== undefined))
          albumDownloads++;
    }
    if (name === "telegram-send-album" && Array.isArray(args.files)) albumDownloads += Math.min(args.files.length, 10);
    // The album resolver enforces one shared 20 MiB budget for all new downloads.
    if (albumDownloads) mediaWrites.push({ bytes: 20 * 1048576 + albumDownloads * 1024, files: albumDownloads * 3 });
    return this.request(userId, (generation, id) => ({ kind: "tool", generation, id, name, args }), {
      ...options,
      mediaWrites,
      queue: true,
      tool: name,
    });
  }
  async prepareLogin(userId: string): Promise<void> {
    const slot = await this.acquire(userId);
    try {
      await this.waitReady(slot);
      if (slot.state !== "ready" || slot.pending.size || slot.lock.isLocked()) throw new Error("Telegram worker busy");
    } finally {
      slot.claims--;
      this.armIdle(slot);
    }
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
