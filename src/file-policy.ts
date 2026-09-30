import { constants } from "node:fs";
import { mkdir, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { isSafeAbsolutePath } from "./tools/shared.js";

export class FilePolicy {
  private readonly root?: string;
  private readonly maxBytes: number;
  constructor(options: { root?: string; maxBytes?: number } = {}) {
    this.root = options.root ? resolve(options.root) : undefined;
    this.maxBytes = options.maxBytes ?? 20 * 1048576;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) throw new Error("Invalid media size limit");
  }
  private async confined(path: string, output = false): Promise<string> {
    if (!isSafeAbsolutePath(path)) throw new Error("Unsafe media path: use an absolute local path without traversal");
    if (!this.root) return path;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await realpath(this.root);
    const target = output
      ? resolve(await realpath(dirname(path)), basename(path))
      : await realpath(path);
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
  async save(path: string, data: Buffer): Promise<void> {
    this.checkSize(data.length);
    const target = await this.confined(path, true);
    const file = await open(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await file.writeFile(data);
    } finally {
      await file.close();
    }
  }
}

export function mediaPolicy(): FilePolicy {
  return new FilePolicy({
    root: process.env.MCP_TELEGRAM_FILE_ROOT,
    maxBytes: process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES ? Number(process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES) : undefined,
  });
}
