import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import {
  type FileHandle,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { Express, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { downloadConcurrency, downloadTimeoutMs, FilePolicy, maxDownloadBytes } from "../file-policy.js";
import type { McpRegisteredTool } from "../ipc-protocol.js";
import { validateMediaName } from "../media-upload.js";
import { isSafeAbsolutePath, WRITE } from "../tools/shared.js";
import type { GatewayIdentity } from "./identity.js";
import { DOWNLOAD_SCRIPT, DOWNLOAD_SCRIPT_PATH, downloadPage } from "./media-download-page.js";

export const DOWNLOAD_TOOL = "telegram-download-media";
const TTL = 5 * 60000;
/** A tool call waits this long for the file; larger files then come back as "preparing". */
const WAIT_MS = 40000;
/** One transfer to a browser or program may run this long (2 GB at about 300 KB/s). */
const TRANSFER_MAX_MS = 2 * 3600000;
/** A transfer whose reader takes nothing for this long is dropped, so it frees its slot. */
const TRANSFER_IDLE_MS = 60000;
/** A running transfer re-checks the link's grant and policy this often. */
const RECHECK_MS = 2000;
/** A download step that fails after progress is retried this many times from the partial file. */
const STEP_RETRIES = 3;
/** Stalled steps in a row (no new chunk for a whole step, about 5 s each) before giving up. */
const MAX_STALLS = 30;
/** Refusals that never reached the worker, so no file was touched. */
const BEFORE_WORKER = /^Telegram worker (busy|capacity reached)/;
/** Refusals that retrying can't fix. */
const FINAL = /^(Media storage |Worker supervisor is closing|Telegram worker policy changed)/;
/** A failure whose message is safe to show to the user (no server paths or internals). */
class PublicDownloadError extends Error {}
/** Fixed messages (from the supervisor or this service) that are safe to show as they are. */
const PUBLIC_MESSAGES = new Set([
  "Media storage quota reached",
  "Media storage disk reserve reached",
  "Downloads unavailable or access revoked",
  "Invalid legacy output path",
  "Download path is outside account storage",
  "Unsafe account storage",
  "Unsafe download storage",
  "Invalid download size",
  "Telegram media download made no progress",
]);
type StepResult = { fileName?: unknown; sizeBytes?: unknown; totalBytes?: unknown; done?: unknown; stalled?: unknown };
const PREFIX = "/media/downloads/";
const UUID = /^[a-f0-9-]{36}$/;
export const downloadSchema = z.object({
  chatId: z.string().min(1),
  messageId: z.number().int().positive().max(2147483647),
  telegramAccountId: z.string().uuid().optional(),
  fileName: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Optional download filename; otherwise uses the original Telegram filename"),
  downloadPath: z
    .string()
    .optional()
    .describe(
      "Optional legacy VPS output path. Omit to receive a browser download link with automatic temporary storage",
    ),
});
export const browserDownloadDefinition = {
  description:
    'Download a file from a Telegram message (up to 2000 MiB, Telegram\'s own limit) and return a private HTTPS link to save it on your device. Open downloadUrl in a browser and click Download; programs and code execution can GET downloadUrl without its fragment, sending the header Authorization: Bearer <token from #token=…> (Range requests work for resuming and seeking). If status is "preparing", the file is still coming from Telegram: the same link answers 202 with receivedBytes until it is ready, so check it again instead of calling this tool again. Links expire five minutes after the file is ready or after their last use and require the originating MCP grant to remain valid. Keep the entire URL, including its fragment. An optional downloadPath preserves legacy VPS output behavior.',
  inputSchema: downloadSchema.shape,
  annotations: WRITE,
};
type Ticket = {
  id: string;
  owner: string;
  selected: string;
  grant: string;
  tokenHash: Buffer;
  expiresAt: number;
  path: string;
  dir?: string;
  legacyPath?: string;
  fileName: string;
  sizeBytes: number;
  handle?: FileHandle;
  ready: boolean;
  active: boolean;
  /** Still streaming from Telegram after the tool call returned. */
  preparing: boolean;
  /** Why a background download failed (kept until the link expires). */
  error?: string;
  /** This download created the file at path (a legacy path may hold a caller's own file). */
  created?: boolean;
};
interface Options {
  root: string;
  origin: string;
  identity: GatewayIdentity;
  now?: () => number;
  validateGrant?: (id: string) => Promise<boolean>;
  /** Largest file a link may carry (default: MCP_TELEGRAM_MAX_DOWNLOAD_BYTES or 2000 MiB). */
  maxBytes?: number;
  /** How long the tool call waits before answering "preparing" (default 40 s). */
  waitMs?: number;
  /** How long one download from Telegram may run (default: MCP_TELEGRAM_DOWNLOAD_TIMEOUT_MS or 60 min). */
  timeoutMs?: number;
  /** Pause before retrying a failed download step (default 1 s, doubled per retry; 5x after a stall). */
  retryDelayMs?: number;
  /** Downloads continuing past their first step at once (default MCP_TELEGRAM_DOWNLOAD_CONCURRENCY or 2). */
  maxFetching?: number;
}
type Created = {
  downloadUrl: string;
  fileName: string;
  sizeBytes: number;
  expiresAt: number;
  status: "ready" | "preparing";
  receivedBytes?: number;
  filePath?: string;
};

/** Private, account-confined file capabilities. Only freshly downloaded Telegram media can be issued. */
export class DirectMediaDownloads {
  private root: string;
  private tickets = new Map<string, Ticket>();
  private controllers = new Set<AbortController>();
  private pending = new Set<Promise<unknown>>();
  private active = new Map<Ticket, Promise<void>>();
  private closed = false;
  private initialized?: Promise<void>;
  private pruning?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private now: () => number;
  private readonly maxBytes: number;
  private readonly waitMs: number;
  private readonly timeoutMs: number;
  private readonly retryDelayMs: number;
  private readonly maxFetching: number;
  /** Downloads that outlived their tool call, so close() can wait for them. */
  private background = new Set<Promise<unknown>>();
  /** Telegram accounts with a download fetching now, and downloads waiting for their turn. */
  private fetching = new Set<string>();
  private queue: Array<{ account: string; start: () => void }> = [];
  constructor(private options: Options) {
    if (!isAbsolute(options.root)) throw new Error("Download storage must be absolute");
    this.root = resolve(options.root);
    this.now = options.now ?? Date.now;
    this.maxBytes = options.maxBytes ?? maxDownloadBytes();
    this.waitMs = options.waitMs ?? WAIT_MS;
    this.timeoutMs = options.timeoutMs ?? downloadTimeoutMs();
    this.retryDelayMs = options.retryDelayMs ?? 1000;
    this.maxFetching = options.maxFetching ?? downloadConcurrency();
  }
  initialize(): Promise<void> {
    if (!this.initialized)
      this.initialized = (async () => {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const info = await lstat(this.root);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Unsafe download storage");
        this.root = await realpath(this.root);
        await this.pruneOrphans();
        if (this.closed) throw new Error("Downloads unavailable");
        this.timer = setInterval(() => void this.prune().catch(() => {}), 30000);
        this.timer.unref();
      })();
    return this.initialized;
  }
  private async allowed(t: Pick<Ticket, "owner" | "grant" | "selected">) {
    const { identity } = this.options;
    if (
      this.closed ||
      !identity.isActive(t.owner) ||
      !identity.isGrantValid(t.owner, t.grant) ||
      !identity
        .toolPolicy(t.owner, t.selected)
        .visible(DOWNLOAD_TOOL, browserDownloadDefinition as unknown as McpRegisteredTool) ||
      (this.options.validateGrant && !(await this.options.validateGrant(t.grant)))
    )
      throw new Error("Downloads unavailable or access revoked");
  }
  async create(owner: string, grant: string, input: unknown, options?: { signal?: AbortSignal }) {
    const operation = this.createFile(owner, grant, input, options);
    this.pending.add(operation);
    try {
      return await operation;
    } finally {
      this.pending.delete(operation);
    }
  }
  private async createFile(
    owner: string,
    grant: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<Created> {
    const args = downloadSchema.parse(input),
      selected = args.telegramAccountId ?? owner;
    if (!UUID.test(owner) || !UUID.test(selected)) throw new Error("Invalid download account");
    await this.allowed({ owner, grant, selected });
    await this.initialize();
    await this.prune();
    if (args.fileName) validateMediaName(args.fileName);
    if (this.tickets.size >= 100 || [...this.tickets.values()].filter((t) => t.owner === owner).length >= 5)
      throw new Error("Download link limit reached; wait for links to expire");
    const id = randomUUID(),
      token = randomBytes(32).toString("base64url");
    const t: Ticket = {
      id,
      owner,
      selected,
      grant,
      tokenHash: createHash("sha256").update(token).digest(),
      expiresAt: this.now() + this.timeoutMs,
      path: "",
      fileName: "",
      sizeBytes: 0,
      ready: false,
      active: false,
      preparing: false,
    };
    this.tickets.set(id, t);
    // The download is owned by this service, not by the tool call: it keeps running when the
    // call answers "preparing". The caller's signal only cancels it until that hand-off.
    const controller = new AbortController();
    this.controllers.add(controller);
    // The time limit starts when the download gets its turn (fetchSteps), not while it waits.
    const signal = controller.signal;
    const cancel = () => controller.abort(options?.signal?.reason);
    if (options?.signal?.aborted) cancel();
    else options?.signal?.addEventListener("abort", cancel, { once: true });
    const link = `${this.options.origin}${PREFIX}${id}#token=${token}`;
    const work = this.fetchFile(t, args, selected, signal).finally(() => this.controllers.delete(controller));
    let waitTimer: NodeJS.Timeout | undefined;
    const waited = new Promise<"waiting">((resolve) => {
      waitTimer = setTimeout(() => resolve("waiting"), this.waitMs);
      waitTimer.unref?.();
    });
    try {
      const first = await Promise.race([work.then(() => "done" as const), waited]);
      if (first === "done")
        return {
          downloadUrl: link,
          fileName: t.fileName,
          sizeBytes: t.sizeBytes,
          expiresAt: t.expiresAt,
          status: "ready",
          ...(t.legacyPath ? { filePath: t.legacyPath } : {}),
        };
    } catch (e) {
      await this.retire(t);
      throw new Error(this.failure(e));
    } finally {
      clearTimeout(waitTimer);
      options?.signal?.removeEventListener("abort", cancel);
    }
    // Still coming from Telegram: hand the link out now and finish in the background.
    t.preparing = true;
    const finishing = work
      // Nothing in here may reject: a rejection of this detached promise would end the process.
      .catch(async (e) => {
        t.error = this.failure(e);
        t.expiresAt = this.now() + TTL;
        await t.handle?.close().catch(() => {});
        t.handle = undefined;
        if (t.dir) await rm(join(t.dir, "data"), { force: true }).catch(() => {});
      })
      .finally(() => {
        t.preparing = false;
        this.background.delete(finishing);
      });
    this.background.add(finishing);
    return {
      downloadUrl: link,
      fileName: args.fileName ?? "",
      sizeBytes: 0,
      expiresAt: t.expiresAt,
      status: "preparing",
      receivedBytes: await this.received(t),
    };
  }
  /** Fetch the file through the account's worker into private storage and arm the ticket. */
  private async fetchFile(t: Ticket, args: z.infer<typeof downloadSchema>, selected: string, signal: AbortSignal) {
    const accountRoot = join(this.root, selected);
    await mkdir(accountRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(accountRoot)).isSymbolicLink()) throw new Error("Unsafe account storage");
    if (args.downloadPath) {
      if (!isSafeAbsolutePath(args.downloadPath)) throw new Error("Invalid legacy output path");
      const target = join(await realpath(dirname(args.downloadPath)), basename(args.downloadPath));
      const rel = relative(accountRoot, target);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || rel.split(/[\\/]/).includes(".mcp-downloads"))
        throw new Error("Download path is outside account storage");
      t.path = target;
      t.legacyPath = args.downloadPath;
    } else {
      const storage = join(accountRoot, ".mcp-downloads");
      await mkdir(storage, { recursive: true, mode: 0o700 });
      if ((await lstat(storage)).isSymbolicLink()) throw new Error("Unsafe download storage");
      t.dir = join(storage, t.id);
      await mkdir(t.dir, { mode: 0o700 });
      t.path = join(t.dir, "data");
      await this.marker(t);
    }
    let workerFileName: string | undefined;
    try {
      workerFileName = await this.fetchSteps(t, args, selected, signal);
    } catch (e) {
      // A legacy path is kept by design, but never a partial file this download created.
      if (t.legacyPath && t.created) await rm(t.path, { force: true });
      throw e;
    }
    signal.throwIfAborted();
    await this.allowed(t);
    await new FilePolicy({ root: accountRoot, maxBytes: this.maxBytes }).upload(t.path);
    t.handle = await open(t.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await t.handle.stat();
    if (!info.isFile() || info.size < 1 || info.size > this.maxBytes) throw new Error("Invalid download size");
    t.sizeBytes = info.size;
    const suggested =
      args.fileName ?? workerFileName ?? (t.legacyPath ? basename(t.legacyPath) : `telegram-${args.messageId}.bin`);
    try {
      t.fileName = validateMediaName(suggested);
    } catch {
      t.fileName = `telegram-${args.messageId}.bin`;
    }
    t.expiresAt = this.now() + TTL;
    if (t.dir) await this.marker(t);
    signal.throwIfAborted();
    await this.allowed(t);
    t.ready = true;
  }
  /**
   * Fetch the file in short steps (offsetBytes), each of which holds the account's worker for
   * a few seconds, so the account's other tool calls get their turn while a large file
   * downloads. A file the first step finishes never queues; continuing past it waits for a
   * turn (fetchTurn), and the time limit runs from then. A step that fails after progress is
   * retried from the partial file's size.
   */
  private async fetchSteps(
    t: Ticket,
    args: z.infer<typeof downloadSchema>,
    selected: string,
    signal: AbortSignal,
  ): Promise<string | undefined> {
    const tooLarge = () =>
      new PublicDownloadError(`The file is larger than the ${Math.floor(this.maxBytes / 1048576)} MiB download limit`);
    // On a legacy path, a file that wasn't there right before a first step is ours to clean up.
    const absent = () =>
      lstat(t.path).then(
        () => false,
        (e) => (e as NodeJS.ErrnoException).code === "ENOENT",
      );
    let fresh = false;
    let offset = 0,
      failures = 0,
      stalls = 0,
      fileName: string | undefined,
      release: (() => void) | undefined,
      // The download's own signal; once it has its turn, also its time limit.
      active = signal;
    try {
      for (;;) {
        active.throwIfAborted();
        if (!release && (offset > 0 || stalls > 0)) {
          // Waiting for a turn is bounded too, so a link can't stay "preparing" indefinitely.
          const waitLimit = AbortSignal.timeout(this.timeoutMs);
          try {
            release = await this.fetchTurn(selected, AbortSignal.any([signal, waitLimit]));
          } catch (e) {
            if (!signal.aborted && waitLimit.aborted)
              throw new PublicDownloadError("Other large downloads are still running; try again later");
            throw e;
          }
          active = AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)]);
        }
        if (!offset && t.legacyPath) fresh = await absent();
        // Access is re-checked between steps, so revoking it stops a background download too.
        await this.allowed(t);
        let result: { isError?: boolean; content?: Array<{ text?: unknown }>; structuredContent?: StepResult };
        let refused = false;
        try {
          result = (await this.options.identity.callTool(
            t.owner,
            DOWNLOAD_TOOL,
            {
              chatId: args.chatId,
              messageId: args.messageId,
              telegramAccountId: selected,
              downloadPath: t.path,
              offsetBytes: offset,
            },
            { signal: active },
          )) as typeof result;
          if (result.isError) {
            if (String(result.content?.[0]?.text ?? "").includes("exceeds configured download limit")) throw tooLarge();
            refused = true;
            throw new Error("Telegram media could not be downloaded");
          }
        } catch (e) {
          active.throwIfAborted();
          const message = e instanceof Error ? e.message : "";
          const beforeWorker = BEFORE_WORKER.test(message) || FINAL.test(message);
          let retry: boolean;
          if (e instanceof PublicDownloadError || FINAL.test(message)) retry = false;
          // Progress was made, so the media and access were fine and the partial file is intact.
          else if (offset) retry = true;
          // The worker refused the first step: no media, no access, or the file already exists.
          else if (refused) retry = false;
          // The first step failed in the worker or on the way (busy, restarted, timed out). Our
          // own storage is started over; a legacy path only when the worker never saw the call.
          else retry = !!t.dir || beforeWorker;
          if (!retry || ++failures > STEP_RETRIES) {
            // A first step on a legacy path whose answer was lost may have created the file there.
            if (!offset && fresh && !refused && !beforeWorker && !(e instanceof PublicDownloadError)) t.created = true;
            throw e;
          }
          await this.pause(this.retryDelayMs * 2 ** (failures - 1), active);
          // A later step continues from what reached the disk (the failed step has settled by the
          // time the next one runs). A first step always restarts at 0, which only creates a file.
          if (offset) offset = await this.received(t);
          else if (t.dir) await rm(t.path, { force: true });
          continue;
        }
        const step = result.structuredContent ?? {};
        const { sizeBytes, totalBytes } = step;
        if (
          typeof sizeBytes !== "number" ||
          typeof totalBytes !== "number" ||
          !Number.isSafeInteger(sizeBytes) ||
          !Number.isSafeInteger(totalBytes) ||
          sizeBytes < offset ||
          sizeBytes > totalBytes
        )
          throw new Error("Invalid download size");
        if (totalBytes > this.maxBytes) throw tooLarge();
        if (sizeBytes > 0) t.created = true;
        failures = 0;
        if (typeof step.fileName === "string") fileName = step.fileName;
        if (step.done === true) return fileName;
        if (step.stalled === true) {
          // No new chunk for a whole step (a slow link or a flood wait). The worker keeps that
          // read going; wait outside the worker, then pick it up. Progress resets the count.
          stalls = sizeBytes > offset ? 0 : stalls + 1;
          if (stalls >= MAX_STALLS) throw new PublicDownloadError("Telegram stopped sending the file; try again later");
          offset = sizeBytes;
          await this.pause(this.retryDelayMs * 2, active);
          continue;
        }
        if (sizeBytes === offset) throw new Error("Telegram media download made no progress");
        stalls = 0;
        offset = sizeBytes;
      }
    } finally {
      release?.();
    }
  }
  /** Wait, or stop at once with the download's own reason when it is cancelled or times out. */
  private async pause(ms: number, signal: AbortSignal) {
    await sleep(ms, undefined, { signal }).catch(() => signal.throwIfAborted());
  }
  /**
   * Wait until this download may fetch from Telegram: one per Telegram account, and at most
   * maxFetching in total, in arrival order. Returns the release for the turn.
   */
  private async fetchTurn(account: string, signal: AbortSignal): Promise<() => void> {
    const free = () => !this.fetching.has(account) && this.fetching.size < this.maxFetching;
    if (!free() || this.queue.length) {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          account,
          start: () => {
            signal.removeEventListener("abort", cancel);
            resolve();
          },
        };
        const cancel = () => {
          const index = this.queue.indexOf(entry);
          if (index >= 0) this.queue.splice(index, 1);
          reject(signal.reason);
        };
        this.queue.push(entry);
        signal.addEventListener("abort", cancel, { once: true });
        if (signal.aborted) cancel();
        else this.startNext();
      });
    }
    this.fetching.add(account);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.fetching.delete(account);
      this.startNext();
    };
  }
  /** Start the first waiting download whose account is free, if a turn is free. */
  private startNext() {
    if (this.fetching.size >= this.maxFetching) return;
    const index = this.queue.findIndex((entry) => !this.fetching.has(entry.account));
    if (index < 0) return;
    const [entry] = this.queue.splice(index, 1);
    // Claim the account now, so another waiter for it can't start in the same tick.
    this.fetching.add(entry.account);
    entry.start();
  }
  /** A failure message that is safe to show: never a server path or an internal error. */
  private failure(e: unknown): string {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "TimeoutError")
      return `Telegram media could not be downloaded within ${Math.round(this.timeoutMs / 60000)} minutes`;
    if (name === "AbortError") return "Telegram media download was cancelled";
    if (e instanceof PublicDownloadError) return e.message;
    const message = e instanceof Error ? e.message : "";
    return PUBLIC_MESSAGES.has(message) ? message : "Telegram media could not be downloaded";
  }
  /** Bytes already on disk for a download that is still running (0 when unknown). */
  private async received(t: Ticket): Promise<number> {
    try {
      return t.path ? (await lstat(t.path)).size : 0;
    } catch {
      return 0;
    }
  }
  private async marker(t: Ticket) {
    const path = join(t.dir as string, "metadata.json");
    const temp = join(t.dir as string, "metadata." + randomUUID() + ".tmp");
    try {
      await writeFile(temp, JSON.stringify({ kind: "mcp-browser-download-v1", expiresAt: t.expiresAt }), {
        mode: 0o600,
        flag: "wx",
      });
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  private async retire(t: Ticket) {
    this.tickets.delete(t.id);
    await t.handle?.close();
    t.handle = undefined;
    if (t.dir) await rm(t.dir, { recursive: true, force: true });
  }
  prune(): Promise<void> {
    if (!this.pruning)
      this.pruning = (async () => {
        for (const t of this.tickets.values())
          if (!t.active && !t.preparing && t.expiresAt <= this.now()) await this.retire(t);
        await this.pruneOrphans();
      })().finally(() => {
        this.pruning = undefined;
      });
    return this.pruning;
  }
  private async pruneOrphans() {
    for (const account of await readdir(this.root, { withFileTypes: true })) {
      if (!account.isDirectory() || !UUID.test(account.name)) continue;
      const base = join(this.root, account.name, ".mcp-downloads");
      try {
        if ((await lstat(base)).isSymbolicLink()) continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw e;
      }
      for (const item of await readdir(base, { withFileTypes: true })) {
        if (!item.isDirectory() || !UUID.test(item.name) || this.tickets.has(item.name)) continue;
        const dir = join(base, item.name),
          path = join(dir, "metadata.json");
        try {
          if ((await lstat(path)).isSymbolicLink()) continue;
          const m = JSON.parse(await readFile(path, "utf8"));
          if (m.kind === "mcp-browser-download-v1" && Number.isFinite(m.expiresAt) && m.expiresAt <= this.now())
            await rm(dir, { recursive: true, force: true });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT" && !(e instanceof SyntaxError)) throw e;
          const entries = await readdir(dir, { withFileTypes: true });
          if (
            (await lstat(dir)).mtimeMs + TTL <= this.now() &&
            entries.every(
              (entry) =>
                entry.isFile() &&
                (entry.name === "data" ||
                  entry.name === "metadata.json" ||
                  /^metadata\.[a-f0-9-]{36}\.tmp$/.test(entry.name)),
            )
          )
            await rm(dir, { recursive: true, force: true });
        }
      }
    }
  }
  mount(app: Express) {
    const headers = {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    };
    app.get(DOWNLOAD_SCRIPT_PATH, (_req, res) => res.set(headers).type("application/javascript").send(DOWNLOAD_SCRIPT));
    app.all(
      `${PREFIX}:id`,
      rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }),
      async (req, res) => {
        res.set(headers);
        if (!UUID.test(String(req.params.id))) {
          res.sendStatus(404);
          return;
        }
        if (req.method === "GET" && !req.headers.authorization && req.headers.accept?.includes("text/html")) {
          res.type("html").send(downloadPage(req.headers.cookie));
          return;
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
          res.set("Allow", "GET, HEAD").sendStatus(405);
          return;
        }
        await this.prune();
        const t = this.tickets.get(String(req.params.id));
        if (!t || (!t.preparing && !t.error && (!t.ready || t.expiresAt <= this.now()))) {
          res.status(410).json({ error: "Download link expired" });
          return;
        }
        const token = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!token || !timingSafeEqual(createHash("sha256").update(token).digest(), t.tokenHash)) {
          res.status(401).json({ error: "Download authorization required" });
          return;
        }
        try {
          await this.allowed(t);
        } catch {
          res.status(403).json({ error: "Download access revoked" });
          return;
        }
        if (t.preparing) {
          // Still streaming from Telegram: say how far it got; the same link works when done.
          res
            .status(202)
            .set("Retry-After", "3")
            .json({ status: "preparing", receivedBytes: await this.received(t) });
          return;
        }
        if (t.error || !t.ready) {
          res.status(502).json({ error: t.error ?? "Telegram media could not be downloaded" });
          return;
        }
        const range = parseRange(req.headers.range, t.sizeBytes);
        if (range === "invalid") {
          res.status(416).set("Content-Range", `bytes */${t.sizeBytes}`).json({ error: "Range not satisfiable" });
          return;
        }
        if (req.method === "HEAD") {
          res
            .attachment(t.fileName)
            .type("application/octet-stream")
            .set({ "Content-Length": String(t.sizeBytes), "Accept-Ranges": "bytes" })
            .end();
          return;
        }
        if (t.active || this.active.size >= 4 || [...this.active.keys()].some((a) => a.owner === t.owner)) {
          res.set("Retry-After", "30").sendStatus(429);
          return;
        }
        t.active = true;
        const operation = this.serve(t, res, range);
        this.active.set(t, operation);
        try {
          await operation;
        } finally {
          t.active = false;
          this.active.delete(t);
          // Each use keeps the link alive a little longer, so a resumed or ranged read can follow.
          t.expiresAt = Math.max(t.expiresAt, this.now() + TTL);
        }
      },
    );
  }
  private async serve(t: Ticket, res: Response, range: { start: number; end: number } | undefined) {
    const controller = new AbortController();
    this.controllers.add(controller);
    // Expiry decides whether a transfer may START; a started one may take as long as a large
    // file needs (up to TRANSFER_MAX_MS) and still stops at once if access is revoked.
    const timer = setTimeout(() => controller.abort(), TRANSFER_MAX_MS);
    timer.unref();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abort);
    let idle: NodeJS.Timeout | undefined;
    try {
      await this.allowed(t);
      controller.signal.throwIfAborted();
      const start = range?.start ?? 0,
        end = range?.end ?? t.sizeBytes - 1;
      const source = t.handle?.createReadStream({ autoClose: false, start, end });
      if (!source) throw new Error("Download unavailable");
      const self = this;
      let checkedAt = Date.now(),
        takenAt = Date.now();
      // A reader that stopped taking bytes (gone without closing, or stalling on purpose) frees
      // its transfer slot after TRANSFER_IDLE_MS instead of holding it for TRANSFER_MAX_MS.
      idle = setInterval(() => {
        if (Date.now() - takenAt > TRANSFER_IDLE_MS) controller.abort();
      }, 5000);
      idle.unref();
      async function* checked() {
        for await (const chunk of source as NonNullable<typeof source>) {
          controller.signal.throwIfAborted();
          // Revocation stops a running transfer within RECHECK_MS without a grant lookup per chunk.
          if (Date.now() - checkedAt >= RECHECK_MS) {
            await self.allowed(t);
            checkedAt = Date.now();
          }
          yield chunk;
          takenAt = Date.now();
        }
      }
      res
        .attachment(t.fileName)
        .type("application/octet-stream")
        .set({ "Content-Length": String(end - start + 1), "Accept-Ranges": "bytes" });
      if (range) res.status(206).set("Content-Range", `bytes ${start}-${end}/${t.sizeBytes}`);
      await pipeline(Readable.from(checked()), res, { signal: controller.signal });
    } catch {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) res.status(403).json({ error: "Download unavailable" });
    } finally {
      clearTimeout(timer);
      clearInterval(idle);
      res.off("close", abort);
      this.controllers.delete(controller);
    }
  }
  stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const controller of this.controllers) controller.abort();
  }
  async close() {
    this.stop();
    await Promise.allSettled([...this.pending, ...this.active.values(), ...this.background]);
    await this.pruning;
    for (const t of this.tickets.values()) await this.retire(t);
  }
}

/**
 * One "bytes=a-b", "bytes=a-" or "bytes=-n" range (RFC 9110 14.2). undefined = send the whole
 * file, which is also the answer to a header this server does not handle (several ranges,
 * another unit, bad syntax); "invalid" = a range the file cannot satisfy (416).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | undefined | "invalid" {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix)) return undefined;
    if (suffix < 1 || size < 1) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]),
    last = m[2] ? Number(m[2]) : undefined;
  if (!Number.isSafeInteger(start) || (last !== undefined && (!Number.isSafeInteger(last) || last < start)))
    return undefined;
  if (start >= size) return "invalid";
  return { start, end: Math.min(last ?? size - 1, size - 1) };
}
