import { GlobalLock } from "./global-lock.js";
import type { McpRegisteredTool } from "./ipc-protocol.js";
import { MAX_TOOL_RESULT_BYTES } from "./limits.js";
import { runOperation } from "./operation-context.js";

export interface ExecutorOptions {
  tools: Record<string, McpRegisteredTool>;
  lock?: GlobalLock;
  timeoutMs?: number;
  maxResultBytes?: number;
  onTimeout?: (name: string) => void;
  onStuck?: () => void;
  settlementGraceMs?: number;
  authorize?: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
}
export interface CallOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  extra?: Record<string, unknown>;
}

/** Shared dispatch for owner stdio and IPC. Queue time is part of the budget. */
export class ToolExecutor {
  private lock: GlobalLock;
  private settling = false;
  private timeoutMs: number;
  private maxResultBytes: number;
  private counts = { requests: 0, completed: 0, failed: 0, timeouts: 0 };
  constructor(private options: ExecutorOptions) {
    this.lock = options.lock ?? new GlobalLock();
    this.timeoutMs = options.timeoutMs ?? 28000;
    this.maxResultBytes = options.maxResultBytes ?? MAX_TOOL_RESULT_BYTES;
  }
  async call(name: string, args: Record<string, unknown>, options: CallOptions = {}): Promise<unknown> {
    this.counts.requests++;
    try {
      const result = await this.execute(name, args, options);
      this.counts.completed++;
      return result;
    } catch (error) {
      this.counts.failed++;
      throw error;
    }
  }
  private async execute(name: string, args: Record<string, unknown>, options: CallOptions): Promise<unknown> {
    if (this.settling) throw new Error("Telegram executor unavailable: previous operation is still settling");
    const tool = Object.hasOwn(this.options.tools, name) ? this.options.tools[name] : undefined;
    if (!tool || tool.enabled === false) throw new Error(`Unknown tool: ${name}`);
    const deadline = Math.min(options.deadlineAt ?? Infinity, Date.now() + this.timeoutMs);
    if (!Number.isFinite(deadline) || deadline <= Date.now())
      throw new Error(`Tool deadline expired before execution: ${name}`);
    const controller = new AbortController();
    let started = false;
    const abort = () => controller.abort(options.signal?.reason ?? new Error("Tool request cancelled"));
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => {
        this.counts.timeouts++;
        controller.abort(new Error(`Tool call timed out after ${this.timeoutMs}ms: ${name}`));
        if (started) this.options.onTimeout?.(name);
      },
      Math.max(1, deadline - Date.now()),
    );
    let unlock: (() => void) | undefined;
    let operation: Promise<unknown> | undefined;
    let abortedListener: (() => void) | undefined;
    let finished = false;
    try {
      unlock = await this.lock.acquire(controller.signal);
      controller.signal.throwIfAborted();
      // A different operation may have timed out while this request waited.
      if (this.settling) throw new Error("Telegram executor unavailable: previous operation is still settling");
      started = true;
      operation = runOperation(controller.signal, async () => {
        if (tool.inputSchema) {
          const parsed = await tool.inputSchema.safeParseAsync(args);
          if (!parsed.success) throw new Error(`Invalid tool arguments: ${name}`);
          args = parsed.data as Record<string, unknown>;
        }
        controller.signal.throwIfAborted();
        if (this.options.authorize) args = await this.options.authorize(name, args);
        controller.signal.throwIfAborted();
        return tool.handler(args, { ...options.extra, signal: controller.signal });
      });
      operation.then(
        () => {
          finished = true;
        },
        () => {
          finished = true;
        },
      );
      const cancelled = new Promise<never>((_resolve, reject) => {
        abortedListener = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", abortedListener, { once: true });
        if (controller.signal.aborted) abortedListener();
      });
      const result = await Promise.race([operation, cancelled]);
      if (Buffer.byteLength(JSON.stringify(result) ?? "null") > this.maxResultBytes)
        throw new Error("Tool result exceeds output limit; narrow the request or use pagination");
      return result;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (abortedListener) controller.signal.removeEventListener("abort", abortedListener);
      if (operation && !finished) {
        this.settling = true;
        const release = unlock;
        const watchdog = this.options.onStuck
          ? setTimeout(this.options.onStuck, this.options.settlementGraceMs ?? 5000)
          : undefined;
        watchdog?.unref();
        void operation
          .then(
            () => {},
            () => {},
          )
          .finally(() => {
            clearTimeout(watchdog);
            this.settling = false;
            release?.();
          });
      } else unlock?.();
    }
  }
  isSettling(): boolean {
    return this.settling;
  }
  queued(): number {
    return this.lock.waitingCount();
  }
  diagnostics() {
    return { ...this.counts, queued: this.queued(), active: this.lock.isLocked(), settling: this.settling };
  }
}
