import { randomUUID } from "node:crypto";
import { GlobalLock } from "../global-lock.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import type { TelegramSessionStore } from "../telegram-session-store.js";
import { ToolExecutor } from "../tool-executor.js";
import {
  type ChildMessage,
  type ParentMessage,
  parentMessageSchema,
  parseFrame,
  type WorkerInit,
} from "./worker-protocol.js";

// No connection credentials, vault key or parent configuration are inherited.
let generation: string | undefined;
let initializing = false;
let shuttingDown = false;
let telegram: import("../telegram-client.js").TelegramService | undefined;
let executor: ToolExecutor | undefined;
let loginExecutor: ToolExecutor | undefined;
const operations = new Map<string, AbortController>();
const acks = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let passwordWait: { attemptId: string; resolve: (password: string | undefined) => void } | undefined;

function send(message: ChildMessage) {
  if (!process.connected || !process.send) process.exit(1);
  if (Buffer.byteLength(JSON.stringify(message)) > 4 * 1048576) throw new Error("Worker frame too large");
  process.send(message, (error) => {
    if (error) process.exit(1);
  });
}
function persistence(kind: "session-save" | "session-clear", session?: string): Promise<void> {
  if (!generation || shuttingDown) return Promise.reject(new Error("Session persistence unavailable"));
  const current = generation,
    id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      acks.delete(id);
      reject(new Error("Session persistence unavailable"));
    }, 10000);
    acks.set(id, { resolve, reject, timer });
    if (kind === "session-save") send({ kind, generation: current, id, session: session ?? "" });
    else send({ kind, generation: current, id });
  });
}
async function initialize(init: WorkerInit) {
  generation = init.generation;
  process.env.MCP_TELEGRAM_FILE_ROOT = init.fileRoot;
  process.env.MCP_TOOL_PROFILE = init.policy.profile;
  process.env.MCP_ALLOWED_CHAT_IDS = init.policy.chatIds.join(",");
  process.env.TELEGRAM_LOG_LEVEL = "none";
  delete process.env.TELEGRAM_2FA_PASSWORD;
  let saved = init.session;
  const sessionStore: TelegramSessionStore = {
    load: async () => saved,
    hasSession: () => !!saved,
    save: async (session) => {
      await persistence("session-save", session);
      saved = session;
    },
    clear: async () => {
      await persistence("session-clear");
      saved = undefined;
    },
  };
  const [{ TelegramService }, { McpServer }, { registerTools }, { ToolPolicy }] = await Promise.all([
    import("../telegram-client.js"),
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("../tools/index.js"),
    import("../tool-policy.js"),
  ]);
  if (shuttingDown) return;
  telegram = new TelegramService(init.apiId, init.apiHash, {
    sessionPath: `${init.fileRoot}/session-unused`,
    sessionStore,
  });
  const server = new McpServer({ name: "tg-bridge-worker", version: "1" });
  registerTools(server, telegram);
  const tools = (server as unknown as McpServerInternal)._registeredTools;
  delete tools["telegram-login"];
  delete tools["telegram-logout"];
  const lock = new GlobalLock(0);
  const policy = new ToolPolicy(init.policy);
  const onStuck = () => process.exit(1);
  executor = new ToolExecutor({
    tools,
    lock,
    onStuck,
    authorize: (name, args) =>
      policy.authorize(name, args, async (id) => {
        if (!telegram || !(await telegram.ensureConnected())) throw new Error("Telegram unavailable");
        return telegram.canonicalChatId(id);
      }),
  });
  loginExecutor = new ToolExecutor({
    lock,
    timeoutMs: 360000,
    onStuck,
    tools: {
      login: {
        handler: async (args, extra) => {
          const attemptId = args.attemptId as string;
          const signal = extra.signal as AbortSignal;
          const requestId = extra.id as string;
          if (!telegram) throw new Error("Worker unavailable");
          const outcome = await telegram.startQrLogin(
            (dataUrl) =>
              send({
                kind: "event",
                generation: init.generation,
                id: requestId,
                attemptId,
                event: { type: "qr", dataUrl, expiresAt: Date.now() + 30000 },
              }),
            undefined,
            signal,
            {
              requestPassword: async (passwordSignal) => {
                send({
                  kind: "event",
                  generation: init.generation,
                  id: requestId,
                  attemptId,
                  event: { type: "needs-password" },
                });
                let cancel: () => void = () => {};
                try {
                  return await new Promise<string | undefined>((resolve) => {
                    passwordWait = { attemptId, resolve };
                    cancel = () => resolve(undefined);
                    passwordSignal.addEventListener("abort", cancel, { once: true });
                    if (passwordSignal.aborted) cancel();
                  });
                } finally {
                  passwordSignal.removeEventListener("abort", cancel);
                  passwordWait = undefined;
                }
              },
            },
          );
          signal.throwIfAborted();
          if (!outcome.success) {
            send({
              kind: "event",
              generation: init.generation,
              id: requestId,
              attemptId,
              event: { type: "error", code: "login-failed" },
            });
            return { success: false };
          }
          const account = await telegram.getMe();
          send({
            kind: "event",
            generation: init.generation,
            id: requestId,
            attemptId,
            event: { type: "success", account: { id: account.id, username: account.username } },
          });
          return { success: true };
        },
      },
    },
  });
  send({ kind: "ready", generation: init.generation });
}
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of operations.values()) controller.abort();
  passwordWait?.resolve(undefined);
  passwordWait = undefined;
  for (const pending of acks.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Worker stopping"));
  }
  acks.clear();
  try {
    await telegram?.disconnect();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => {
  void shutdown();
});
process.on("disconnect", () => {
  void shutdown();
});
process.on("message", (raw) => {
  let message: ParentMessage;
  try {
    message = parseFrame(parentMessageSchema, raw);
  } catch {
    void shutdown();
    return;
  }
  if (message.kind === "init") {
    if (initializing) {
      void shutdown();
      return;
    }
    initializing = true;
    void initialize(message).catch(() => shutdown());
    return;
  }
  if (message.generation !== generation) return;
  if (message.kind === "shutdown") {
    void shutdown();
    return;
  }
  if (shuttingDown) return;
  if (message.kind === "ack") {
    const pending = acks.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    acks.delete(message.id);
    if (message.ok) pending.resolve();
    else pending.reject(new Error("Session persistence unavailable"));
    return;
  }
  if (message.kind === "cancel") {
    operations.get(message.id)?.abort();
    return;
  }
  if (message.kind === "login-password") {
    if (passwordWait?.attemptId === message.attemptId) {
      const waiting = passwordWait;
      passwordWait = undefined;
      waiting.resolve(message.password);
    }
    return;
  }
  if (!executor || !loginExecutor || operations.size) {
    send({ kind: "result", generation: message.generation, id: message.id, error: "Telegram worker busy" });
    return;
  }
  const current = message.kind === "tool" ? executor : loginExecutor;
  const controller = new AbortController();
  operations.set(message.id, controller);
  void (async () => {
    let result: unknown, error: string | undefined;
    try {
      result =
        message.kind === "tool"
          ? await current.call(message.name, message.args, { signal: controller.signal })
          : await current.call(
              "login",
              { attemptId: message.attemptId },
              { signal: controller.signal, extra: { id: message.id } },
            );
    } catch {
      error = controller.signal.aborted ? "Worker request cancelled" : "Telegram operation failed";
    }
    const settling = current.isSettling();
    send({ kind: "result", generation: message.generation, id: message.id, result, error, settling });
    if (settling) {
      const interval = setInterval(() => {
        if (current.isSettling()) return;
        clearInterval(interval);
        operations.delete(message.id);
        send({ kind: "settled", generation: message.generation, id: message.id });
      }, 25);
      interval.unref();
    } else operations.delete(message.id);
  })().catch(() => shutdown());
});
