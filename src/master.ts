import { createServer, type Server, type Socket } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { GlobalLock } from "./global-lock.js";
import {
  encodeMessage,
  IpcDecoder,
  type IpcLoginStart,
  type IpcMessage,
  type IpcToolRequest,
  type IpcToolResponse,
  type McpServerInternal,
} from "./ipc-protocol.js";
import { lockPath, releaseLock, releaseSocket, socketPath } from "./lock.js";
import { TelegramService } from "./telegram-client.js";
import { ToolExecutor } from "./tool-executor.js";
import { ToolPolicy } from "./tool-policy.js";
import { registerTools } from "./tools/index.js";
import { ok } from "./tools/shared.js";

const TOOL_CALL_TIMEOUT_MS = 28_000;
const MAX_SOCKET_QUEUE = 64;

let cleanedUp = false;
let ownedPaths: { lock: string; socket: string } | undefined;

function cleanup() {
  if (cleanedUp || !ownedPaths) return;
  cleanedUp = true;
  // Sync unlink only — process.exit handlers cannot await async server.close(),
  // and unlinking the socket file is sufficient to release the listening address.
  releaseSocket(ownedPaths.socket, ownedPaths.lock);
  releaseLock(ownedPaths.lock);
}

process.on("exit", cleanup);

type ActiveLogin = { socket: Socket; abort: AbortController };
type Dispatch = {
  lock: GlobalLock;
  executor: ToolExecutor;
  loginExecutor: ToolExecutor;
  loginAllowed: boolean;
  activeLogin: ActiveLogin | null;
};
const dispatches = new WeakMap<McpServerInternal, Dispatch>();

function diagnosticResult(dispatch: Dispatch, telegram: TelegramService) {
  const status = {
    owner: dispatch.executor.isSettling() || dispatch.loginExecutor.isSettling() ? "settling" : "ready",
    telegram: telegram.diagnostics?.() ?? { connected: false },
    executor: dispatch.executor.diagnostics(),
    login: dispatch.loginExecutor.diagnostics(),
  };
  return ok(JSON.stringify(status), status);
}

export interface HandleClientOptions {
  toolCallTimeoutMs?: number;
  settlementGraceMs?: number;
  /** Production fail-stop: the supervisor replaces an owner with a stuck operation. */
  onStuck?: () => void;
}

function dispatchFor(mcpServer: McpServerInternal, telegram: TelegramService, opts: HandleClientOptions): Dispatch {
  const existing = dispatches.get(mcpServer);
  if (existing) return existing;
  const lock = new GlobalLock();
  const policy = new ToolPolicy();
  // Snapshot original callbacks before owner stdio is wired through this same executor.
  const tools = Object.fromEntries(
    Object.entries(mcpServer._registeredTools).map(([name, tool]) => [name, { ...tool }]),
  );
  const executor = new ToolExecutor({
    tools,
    lock,
    timeoutMs: opts.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS,
    onTimeout: (name) => telegram.markUnhealthy?.(`tool call timed out: ${name}`),
    onStuck: opts.onStuck,
    settlementGraceMs: opts.settlementGraceMs,
    authorize: async (name, args) => {
      if (name === "telegram-logout") await telegram.cancelQrLogin?.();
      return policy.authorize(name, args, async (id) => {
        if (!(await telegram.ensureConnected())) throw new Error("Telegram is not connected");
        return telegram.canonicalChatId(id);
      });
    },
  });
  const loginExecutor = new ToolExecutor({
    lock,
    timeoutMs: 360_000,
    onStuck: opts.onStuck,
    settlementGraceMs: opts.settlementGraceMs,
    onTimeout: () => telegram.markUnhealthy?.("QR login timed out"),
    tools: {
      login_start: {
        handler: async (_args, extra) => {
          const socket = extra.socket as Socket;
          const id = extra.id as string;
          const signal = extra.signal as AbortSignal;
          const result = await telegram.startQrLogin(
            () => {},
            (url) => send(socket, { type: "login_qr", id, url }),
            signal,
          );
          signal.throwIfAborted();
          if (!result.success) return { success: false, error: result.message };
          const me = await telegram.getMe();
          return { success: true, username: me.username ?? undefined };
        },
      },
    },
  });
  const dispatch: Dispatch = {
    lock,
    executor,
    loginExecutor,
    loginAllowed: !!tools["telegram-login"] && tools["telegram-login"].enabled !== false,
    activeLogin: null,
  };
  dispatches.set(mcpServer, dispatch);
  return dispatch;
}

/** Stdio and IPC execute the captured handlers through one owner queue. */
export function wireOwnerExecutor(
  mcpServer: McpServerInternal,
  telegram: TelegramService,
  opts: HandleClientOptions = {},
) {
  const dispatch = dispatchFor(mcpServer, telegram, opts);
  for (const [name, tool] of Object.entries(mcpServer._registeredTools)) {
    tool.handler = (args, extra) => {
      if (name === "telegram-doctor") return Promise.resolve(diagnosticResult(dispatch, telegram));
      if (dispatch.loginExecutor.isSettling())
        return Promise.reject(new Error("Telegram executor unavailable: QR operation is still settling"));
      if (name === "telegram-logout") dispatch.activeLogin?.abort.abort();
      const context = extra ?? (tool.inputSchema ? {} : args);
      return dispatch.executor.call(name, tool.inputSchema ? args : {}, {
        extra: context,
        signal: context?.signal as AbortSignal | undefined,
      });
    };
  }
  return dispatch.executor;
}

export function handleClient(
  socket: Socket,
  mcpServer: McpServerInternal,
  telegram: TelegramService,
  opts: HandleClientOptions = {},
) {
  const dispatch = dispatchFor(mcpServer, telegram, opts);
  const decoder = new IpcDecoder();
  let processing = false;
  const queue: (IpcToolRequest | IpcLoginStart)[] = [];
  const requests = new Map<string, AbortController>();

  async function drainQueue() {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0 && !socket.destroyed) {
        const msg = queue.shift();
        if (!msg) break;
        const controller = requests.get(msg.id);
        if (!controller) continue;
        try {
          if (msg.type === "tool") await handleToolRequest(socket, msg, dispatch, controller.signal);
          else await handleLoginStart(socket, msg, telegram, dispatch, controller);
        } finally {
          requests.delete(msg.id);
        }
      }
    } finally {
      processing = false;
    }
  }

  socket.on("data", (chunk) => {
    let messages: IpcMessage[];
    try {
      messages = decoder.push(chunk);
    } catch {
      socket.destroy();
      return;
    }
    for (const msg of messages) {
      if (msg.type === "cancel") {
        requests.get(msg.id)?.abort(new Error("Tool request cancelled"));
        continue;
      }
      if (msg.type !== "tool" && msg.type !== "login_start") continue;
      if (msg.type === "tool" && msg.tool === "telegram-doctor") {
        send(socket, { type: "tool_response", id: msg.id, result: diagnosticResult(dispatch, telegram) });
        continue;
      }
      if (requests.has(msg.id)) {
        socket.destroy();
        return;
      }
      if (requests.size >= MAX_SOCKET_QUEUE) {
        if (msg.type === "tool")
          send(socket, { type: "tool_response", id: msg.id, error: "Tool queue is full; try again later" });
        else
          send(socket, {
            type: "login_done",
            id: msg.id,
            success: false,
            error: "Tool queue is full; try again later",
          });
        continue;
      }
      const controller = new AbortController();
      requests.set(msg.id, controller);
      // Capture the ceiling on receipt, before this socket's FIFO or QR wait.
      if (msg.type === "tool") {
        msg.deadlineAt = Math.min(
          msg.deadlineAt ?? Infinity,
          Date.now() + (opts.toolCallTimeoutMs ?? TOOL_CALL_TIMEOUT_MS),
        );
        if (msg.tool === "telegram-logout") dispatch.activeLogin?.abort.abort();
      }
      queue.push(msg);
    }
    void drainQueue();
  });
  socket.on("close", () => {
    for (const controller of requests.values()) controller.abort(new Error("IPC connection closed"));
    queue.length = 0;
    requests.clear();
  });
  socket.on("error", () => {});
}

function send(socket: Socket, msg: IpcMessage): void {
  if (socket.destroyed) return;
  try {
    socket.write(encodeMessage(msg));
  } catch {
    socket.destroy();
  }
}

async function handleToolRequest(socket: Socket, req: IpcToolRequest, dispatch: Dispatch, signal: AbortSignal) {
  const response: IpcToolResponse = { type: "tool_response", id: req.id };
  try {
    if (dispatch.loginExecutor.isSettling())
      throw new Error("Telegram executor unavailable: QR operation is still settling");
    response.result = await dispatch.executor.call(req.tool, req.args, { signal, deadlineAt: req.deadlineAt });
  } catch (error) {
    response.error = (error instanceof Error ? error.message : String(error)).slice(0, 2048);
  }
  send(socket, response);
}

async function handleLoginStart(
  socket: Socket,
  req: IpcLoginStart,
  _telegram: TelegramService,
  dispatch: Dispatch,
  abort: AbortController,
) {
  const fail = (error: string) =>
    send(socket, { type: "login_done", id: req.id, success: false, error: error.slice(0, 2048) });
  if (!dispatch.loginAllowed) {
    fail("Authentication writes are disabled by the owner profile");
    return;
  }
  if (dispatch.activeLogin) {
    fail("Another QR login is already in progress");
    return;
  }
  if (dispatch.executor.isSettling() || dispatch.loginExecutor.isSettling()) {
    fail("Telegram executor unavailable: previous operation is still settling");
    return;
  }
  dispatch.activeLogin = { socket, abort };
  try {
    const result = (await dispatch.loginExecutor.call(
      "login_start",
      {},
      {
        signal: abort.signal,
        extra: { socket, id: req.id },
      },
    )) as { success: boolean; error?: string; username?: string };
    send(socket, { type: "login_done", id: req.id, ...result });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  } finally {
    dispatch.activeLogin = null;
  }
}

export interface OwnerHandle {
  server: McpServer;
  srv: Server;
  gracefulExit: () => Promise<void>;
  beforeShutdown?: () => Promise<void>;
  executor: ToolExecutor;
  isHealthy: () => boolean;
}

/**
 * Bootstrap the connection owner shared by master (stdio) and serve (daemon) modes:
 * build the tool registry, listen on the IPC socket, install a graceful shutdown that
 * disconnects Telegram, and auto-connect the single client. No stdio is attached here —
 * the caller decides whether to also serve a stdio MCP session (master) or not (serve).
 */
export async function startOwner(
  telegram: TelegramService,
  version: string,
  opts: { label?: string } = {},
): Promise<OwnerHandle> {
  const label = opts.label ?? "mcp-telegram";

  const server = new McpServer({ name: "mcp-telegram", version });
  registerTools(server, telegram);
  const mcpServer = server as unknown as McpServerInternal;
  const executor = wireOwnerExecutor(mcpServer, telegram, {
    onStuck: () => {
      console.error(`[${label}] Timed-out operation did not settle; terminating owner for safe recovery`);
      process.exit(1);
    },
  });
  ownedPaths = { lock: lockPath(), socket: socketPath() };

  // Remove a stale socket file from a previous crash before attempting to listen.
  releaseSocket();

  const sock = ownedPaths.socket;
  const srv = createServer((socket) => {
    console.error(`[${label}] client connected`);
    socket.on("close", () => console.error(`[${label}] client disconnected`));
    handleClient(socket, mcpServer, telegram);
  });

  await new Promise<void>((resolve, reject) => {
    srv.listen(sock, resolve);
    srv.once("error", reject);
  });

  const { chmod } = await import("node:fs/promises");
  try {
    await chmod(sock, 0o600);
  } catch {
    // Best-effort hardening of the IPC endpoint. Expected to fail on win32, where `sock` is
    // a named pipe rather than a file (see socketPath()); the pipe's default DACL already
    // restricts it to the creating user's session. Also fails on filesystems without POSIX
    // modes. Neither case is worth refusing to serve over.
  }

  console.error(`[${label}] IPC socket ready: ${sock}`);

  let shuttingDown = false;
  const handle: OwnerHandle = {
    server,
    srv,
    executor,
    gracefulExit: async () => {},
    isHealthy: () => !executor.isSettling() && !dispatchFor(mcpServer, telegram, {}).loginExecutor.isSettling(),
  };
  const gracefulExit = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.error(`[${label}] Shutting down, disconnecting from Telegram...`);
    try {
      await handle.beforeShutdown?.();
      await telegram.disconnect();
    } catch (err) {
      console.error(`[${label}] Disconnect error:`, err);
    }
    process.exit(0);
  };

  process.on("SIGINT", gracefulExit);
  process.on("SIGTERM", gracefulExit);

  // Auto-connect with saved session — catch to avoid unhandled rejection.
  telegram
    .loadSession()
    .then(async () => {
      if (await telegram.connect()) {
        const me = await telegram.getMe();
        console.error(`[${label}] connected as @${me.username}`);
      } else if (telegram.lastError) {
        console.error(`[${label}] ${telegram.lastError}`);
      }
    })
    .catch((err: unknown) => {
      console.error(`[${label}] Auto-connect failed:`, err);
    });

  handle.gracefulExit = gracefulExit;
  return handle;
}

export async function runMaster(apiId: number, apiHash: string, version: string): Promise<void> {
  const telegram = new TelegramService(apiId, apiHash);
  const { server, gracefulExit } = await startOwner(telegram, version, { label: "mcp-telegram (master)" });

  // Parent (Claude Code / MCP client) can close stdio without sending a signal.
  // Without this, the process keeps running as an orphan with a live Telegram connection,
  // blocking auth_key from being reused — causes AUTH_KEY_DUPLICATED on next start.
  process.stdin.on("end", gracefulExit);

  // Master also serves the launching window directly over stdio.
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp-telegram] MCP server running on stdio (master)");
}
