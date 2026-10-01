import { type ChildProcess, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { WorkerBudget } from "./worker-budget.js";

const id = z.string().min(1).max(128);
export const telegramAuthEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("token"),
    token: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/),
    expiresAt: z.number().int(),
  }),
  z.object({ type: z.literal("needs-password") }),
  z.object({
    type: z.literal("verified"),
    proof: z.object({
      attemptId: id,
      account: z.object({ id: z.string().regex(/^[1-9]\d{0,19}$/), username: z.string().max(64).optional() }),
      session: z.string().min(1).max(16384),
      authenticatedAt: z.number().int(),
    }),
  }),
  z.object({ type: z.literal("error"), code: z.enum(["login-failed", "worker-unavailable"]) }),
]);
export type TelegramAuthEvent = z.infer<typeof telegramAuthEventSchema>;
export const telegramAuthParentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("init"),
    generation: id,
    attemptId: id,
    apiId: z.number().int().positive(),
    apiHash: z.string().min(1).max(128),
  }),
  z.object({ kind: z.literal("password"), generation: id, attemptId: id, password: z.string().min(1).max(1024) }),
  z.object({ kind: z.literal("shutdown"), generation: id, attemptId: id, logout: z.boolean() }),
]);
const childSchema = z.object({ generation: id, attemptId: id, event: telegramAuthEventSchema });

export class TelegramAuthWorker {
  private child?: ChildProcess;
  private generation = randomUUID();
  private attemptId?: string;
  private stopping = false;
  private stopped?: Promise<void>;
  private onEvent?: (event: TelegramAuthEvent) => void;
  constructor(private options: { budget: WorkerBudget; apiId: number; apiHash: string; spawn?: typeof fork }) {}

  async start(attemptId: string, onEvent: (event: TelegramAuthEvent) => void): Promise<void> {
    if (this.attemptId || this.stopping) throw new Error("Worker already started");
    const lease = this.options.budget.reserve(`bootstrap:${attemptId}`);
    this.attemptId = attemptId;
    this.onEvent = onEvent;
    let resolveStopped!: () => void;
    this.stopped = new Promise<void>((resolve) => {
      resolveStopped = resolve;
    });
    try {
      const child = (this.options.spawn ?? fork)(
        fileURLToPath(new URL("./telegram-auth-worker.js", import.meta.url)),
        [],
        {
          env: { NODE_ENV: "production", LANG: "C.UTF-8", TZ: "UTC", TELEGRAM_LOG_LEVEL: "none" },
          execArgv: ["--max-old-space-size=256"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
          serialization: "json",
        },
      );
      this.child = child;
      const finish = () => {
        const unexpected = !this.stopping;
        this.stopping = true;
        lease.release();
        resolveStopped();
        if (unexpected) onEvent({ type: "error", code: "worker-unavailable" });
      };
      child.once("exit", finish);
      child.once("error", () => {
        if (!this.stopping) onEvent({ type: "error", code: "worker-unavailable" });
        if (!child.pid) finish();
        else void this.dispose({ logout: false });
      });
      child.on("message", (raw) => {
        if (this.stopping) return;
        const parsed = childSchema.safeParse(raw);
        if (!parsed.success) {
          void this.dispose({ logout: true });
          onEvent({ type: "error", code: "worker-unavailable" });
          return;
        }
        const message = parsed.data;
        if (message.generation !== this.generation || message.attemptId !== attemptId) return;
        if (message.event.type === "verified" && message.event.proof.attemptId !== attemptId) return;
        onEvent(message.event);
      });
      child.send({
        kind: "init",
        generation: this.generation,
        attemptId,
        apiId: this.options.apiId,
        apiHash: this.options.apiHash,
      });
    } catch {
      if (!this.child?.pid) {
        lease.release();
        resolveStopped();
      } else await this.dispose({ logout: true });
      throw new Error("Worker unavailable");
    }
  }
  submitPassword(password: string): void {
    if (this.stopping || !this.child?.connected || !this.attemptId) throw new Error("Worker unavailable");
    this.child.send({ kind: "password", generation: this.generation, attemptId: this.attemptId, password });
  }
  async dispose(options: { logout: boolean }): Promise<void> {
    if (!this.stopped) {
      this.stopping = true;
      return;
    }
    if (!this.stopping) {
      this.stopping = true;
      const child = this.child;
      if (child?.connected)
        child.send(
          { kind: "shutdown", generation: this.generation, attemptId: this.attemptId, logout: options.logout },
          (error) => {
            if (error) child.kill("SIGTERM");
          },
        );
      else child?.kill("SIGTERM");
      const kill = setTimeout(() => child?.kill("SIGKILL"), 5000);
      kill.unref();
      void this.stopped.finally(() => clearTimeout(kill));
    }
    await this.stopped;
    this.onEvent = undefined;
  }
}
