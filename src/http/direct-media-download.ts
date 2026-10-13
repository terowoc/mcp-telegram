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
import type { Express, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { FilePolicy } from "../file-policy.js";
import type { McpRegisteredTool } from "../ipc-protocol.js";
import { validateMediaName } from "../media-upload.js";
import { isSafeAbsolutePath, WRITE } from "../tools/shared.js";
import type { GatewayIdentity } from "./identity.js";
import { DOWNLOAD_SCRIPT, DOWNLOAD_SCRIPT_PATH, downloadPage } from "./media-download-page.js";

export const DOWNLOAD_TOOL = "telegram-download-media";
export const DOWNLOAD_MAX_BYTES = 20 * 1048576;
const TTL = 5 * 60000;
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
    "Download a file from a Telegram message and return a private HTTPS link to save it on your device. Open downloadUrl in a browser and click Download. Links expire after five minutes and require the originating MCP grant to remain valid. Keep the entire URL, including its fragment. Maximum 20 MiB. An optional downloadPath preserves legacy VPS output behavior.",
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
};
interface Options {
  root: string;
  origin: string;
  identity: GatewayIdentity;
  now?: () => number;
  validateGrant?: (id: string) => Promise<boolean>;
}

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
  constructor(private options: Options) {
    if (!isAbsolute(options.root)) throw new Error("Download storage must be absolute");
    this.root = resolve(options.root);
    this.now = options.now ?? Date.now;
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
  private async createFile(owner: string, grant: string, input: unknown, options?: { signal?: AbortSignal }) {
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
      expiresAt: this.now() + TTL,
      path: "",
      fileName: "",
      sizeBytes: 0,
      ready: false,
      active: false,
    };
    this.tickets.set(id, t);
    const controller = new AbortController();
    this.controllers.add(controller);
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(45000),
      ...(options?.signal ? [options.signal] : []),
    ]);
    try {
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
        t.dir = join(storage, id);
        await mkdir(t.dir, { mode: 0o700 });
        t.path = join(t.dir, "data");
        await this.marker(t);
      }
      signal.throwIfAborted();
      const result = (await this.options.identity.callTool(
        owner,
        DOWNLOAD_TOOL,
        { chatId: args.chatId, messageId: args.messageId, telegramAccountId: selected, downloadPath: t.path },
        { signal },
      )) as { isError?: boolean; structuredContent?: { fileName?: string } };
      if (result.isError) throw new Error("Telegram media could not be downloaded");
      signal.throwIfAborted();
      await this.allowed(t);
      await new FilePolicy({ root: accountRoot, maxBytes: DOWNLOAD_MAX_BYTES }).upload(t.path);
      t.handle = await open(t.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const info = await t.handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > DOWNLOAD_MAX_BYTES) throw new Error("Invalid download size");
      t.sizeBytes = info.size;
      const suggested =
        args.fileName ??
        result.structuredContent?.fileName ??
        (t.legacyPath ? basename(t.legacyPath) : `telegram-${args.messageId}.bin`);
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
      return {
        downloadUrl: `${this.options.origin}${PREFIX}${id}#token=${token}`,
        fileName: t.fileName,
        sizeBytes: t.sizeBytes,
        expiresAt: t.expiresAt,
        ...(t.legacyPath ? { filePath: t.legacyPath } : {}),
      };
    } catch (e) {
      await this.retire(t);
      throw e;
    } finally {
      this.controllers.delete(controller);
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
          if (t.ready && !t.active && t.expiresAt <= this.now()) await this.retire(t);
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
        if (!t?.ready || t.expiresAt <= this.now()) {
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
        if (req.method === "HEAD") {
          res.attachment(t.fileName).type("application/octet-stream").set("Content-Length", String(t.sizeBytes)).end();
          return;
        }
        if (t.active || this.active.size >= 4 || [...this.active.keys()].some((a) => a.owner === t.owner)) {
          res.sendStatus(429);
          return;
        }
        t.active = true;
        const operation = this.serve(t, res);
        this.active.set(t, operation);
        try {
          await operation;
        } finally {
          t.active = false;
          this.active.delete(t);
        }
      },
    );
  }
  private async serve(t: Ticket, res: Response) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(120000, t.expiresAt - this.now())));
    timer.unref();
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.on("close", abort);
    try {
      await this.allowed(t);
      controller.signal.throwIfAborted();
      const source = t.handle?.createReadStream({ autoClose: false, start: 0, end: t.sizeBytes - 1 });
      if (!source) throw new Error("Download unavailable");
      const self = this;
      async function* checked() {
        for await (const chunk of source as NonNullable<typeof source>) {
          controller.signal.throwIfAborted();
          if (t.expiresAt <= self.now()) throw new Error("Expired download");
          await self.allowed(t);
          yield chunk;
        }
      }
      res
        .attachment(t.fileName)
        .type("application/octet-stream")
        .set({ "Content-Length": String(t.sizeBytes), "Accept-Ranges": "none" });
      await pipeline(Readable.from(checked()), res, { signal: controller.signal });
    } catch {
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) res.status(403).json({ error: "Download unavailable" });
    } finally {
      clearTimeout(timer);
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
    await Promise.allSettled([...this.pending, ...this.active.values()]);
    await this.pruning;
    for (const t of this.tickets.values()) await this.retire(t);
  }
}
