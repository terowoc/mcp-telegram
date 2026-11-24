import { constants } from "node:fs";
import { type FileHandle, mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isSafeAbsolutePath } from "./tools/shared.js";

const MIB = 1048576;
/** Telegram's own limit for one file; downloads stream to disk, so nothing smaller is needed. */
export const TELEGRAM_FILE_LIMIT_BYTES = 2000 * MIB;

/** MCP_TELEGRAM_MAX_DOWNLOAD_BYTES, or Telegram's own 2000 MiB. Set 20971520 for the old 20 MiB cap. */
export function maxDownloadBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_TELEGRAM_MAX_DOWNLOAD_BYTES;
  const value = raw ? Number(raw) : TELEGRAM_FILE_LIMIT_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > TELEGRAM_FILE_LIMIT_BYTES * 2)
    throw new Error("Invalid MCP_TELEGRAM_MAX_DOWNLOAD_BYTES");
  return value;
}

/** Name of the worker tool that fetches a message's file to disk. */
export const DOWNLOAD_MEDIA_TOOL = "telegram-download-media";

/**
 * How long one whole media download may take (MCP_TELEGRAM_DOWNLOAD_TIMEOUT_MS, default
 * 60 min, 30 s – 6 h). The browser-link service downloads in short steps (see
 * DOWNLOAD_STEP_MS) and applies this from the moment a download gets its turn; an owner's
 * single-call download gets it as its tool deadline. Every other tool keeps its short deadline.
 */
export function downloadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_TELEGRAM_DOWNLOAD_TIMEOUT_MS;
  const value = raw ? Number(raw) : 60 * 60000;
  if (!Number.isSafeInteger(value) || value < 30000 || value > 6 * 3600000)
    throw new Error("Invalid MCP_TELEGRAM_DOWNLOAD_TIMEOUT_MS");
  return value;
}

/**
 * One download step (a call with offsetBytes) stops reading after this long, so the
 * account's other tool calls, which queue for at most 5 s, get their turn between steps.
 */
export const DOWNLOAD_STEP_MS = 2000;
/** A step also stops early when its next chunk would likely keep the account past this. */
export const DOWNLOAD_STEP_HOLD_MS = 3500;
/**
 * A step whose next chunk hasn't arrived after this long returns early as "stalled" (a slow
 * link or a Telegram flood wait), so it holds the account for less than the 5 s other calls
 * wait. The read itself continues, and the next step picks it up.
 */
export const DOWNLOAD_STEP_STALL_MS = 3000;
/** One download step writes at most this much (the supervisor reserves it per step). */
export const DOWNLOAD_STEP_MAX_BYTES = 64 * MIB;

/**
 * Downloads the browser-link service fetches past their first step at once
 * (MCP_TELEGRAM_DOWNLOAD_CONCURRENCY, default 2, 1–64; always one per Telegram account).
 * Each holds its account's worker between steps, so it stays below MCP_SAAS_MAX_WORKERS
 * (default 4): at least one worker is always left for every other account.
 */
export function downloadConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MCP_TELEGRAM_DOWNLOAD_CONCURRENCY;
  const value = raw ? Number(raw) : 2;
  if (!Number.isSafeInteger(value) || value < 1 || value > 64)
    throw new Error("Invalid MCP_TELEGRAM_DOWNLOAD_CONCURRENCY");
  const workers = Number(env.MCP_SAAS_MAX_WORKERS ?? 4);
  return Number.isSafeInteger(workers) && workers >= 1 ? Math.min(value, Math.max(1, workers - 1)) : value;
}

export class FilePolicy {
  private readonly root?: string;
  private readonly maxBytes: number;
  private readonly maxDownloadBytes: number;
  constructor(options: { root?: string; maxBytes?: number; maxDownloadBytes?: number } = {}) {
    this.root = options.root ? resolve(options.root) : undefined;
    this.maxBytes = options.maxBytes ?? 20 * MIB;
    this.maxDownloadBytes = options.maxDownloadBytes ?? TELEGRAM_FILE_LIMIT_BYTES;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Invalid media size limit");
    if (!Number.isSafeInteger(this.maxDownloadBytes) || this.maxDownloadBytes < 1)
      throw new Error("Invalid media download limit");
  }
  private async confined(path: string, output = false): Promise<string> {
    if (!isSafeAbsolutePath(path)) throw new Error("Unsafe media path: use an absolute local path without traversal");
    if (!this.root) return path;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const target = output ? resolve(await realpath(dirname(path)), basename(path)) : await realpath(path);
    const rel = relative(root, target);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error("Media path must stay inside the configured file root");
    return target;
  }
  async upload(path: string): Promise<string> {
    const target = await this.confined(path);
    if (this.root) {
      const info = await stat(target);
      if (!info.isFile()) throw new Error("Media upload must be a regular file");
      this.checkSize(info.size);
    }
    return target;
  }
  checkSize(bytes: number): void {
    if (this.root && bytes > this.maxBytes) throw new Error("Media size exceeds configured limit");
  }
  /** Downloads from Telegram have their own (larger) limit: they stream to disk, never into memory. */
  checkDownloadSize(bytes: number): void {
    if (this.root && bytes > this.maxDownloadBytes) throw new Error("Media size exceeds configured download limit");
  }
  /** Create a new confined output file (never an existing one, never through a symlink). */
  async openOutput(path: string): Promise<{ handle: FileHandle; path: string }> {
    const target = await this.confined(path, true);
    const handle = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    return { handle, path: target };
  }
  /**
   * Reopen a partial download to continue it: the confined file must already exist, be a
   * regular file (never a symlink) and hold exactly `size` bytes, so two writers or a
   * stale offset can never splice a file together.
   */
  async openPartial(path: string, size: number): Promise<{ handle: FileHandle; path: string }> {
    const target = await this.confined(path, true);
    const handle = await open(target, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size !== size)
        throw new Error("Partial download does not match offsetBytes; start the download again");
    } catch (e) {
      await handle.close();
      throw e;
    }
    return { handle, path: target };
  }
  async save(path: string, data: Buffer): Promise<void> {
    this.checkSize(data.length);
    const { handle } = await this.openOutput(path);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
  }
}

export function mediaPolicy(): FilePolicy {
  return new FilePolicy({
    root: process.env.MCP_TELEGRAM_FILE_ROOT,
    maxBytes: process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES ? Number(process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES) : undefined,
    maxDownloadBytes: maxDownloadBytes(),
  });
}
