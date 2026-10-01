import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { FilePolicy } from "./file-policy.js";
import { operationSignal } from "./operation-context.js";

export const MEDIA_CHUNK_BYTES = 512 * 1024;
export const MEDIA_TTL_MS = 60 * 60 * 1000;
export const MEDIA_ID_PATTERN = /^media_[a-f0-9-]{36}$/;
type Metadata = { fileName: string; expiresAt: number; ready: boolean };
export type UploadedMedia = Metadata & { fileId: string; receivedBytes: number };
export type UploadChunk = { fileName?: string; data: string; fileId?: string; offset?: number; final?: boolean };

export function validateMediaName(name: string): string {
  if (
    !name ||
    name === "." ||
    name === ".." ||
    /[/\\]/.test(name) ||
    [...name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    Buffer.byteLength(name) > 200
  )
    throw new Error("Invalid media filename: provide a basename with its extension, without directories");
  return name;
}

/** Account-local file handles. The executor serializes writes for each account. */
export class MediaUploadStore {
  private root: string;
  private directory: string;
  private maxBytes: number;
  private maxStoredBytes: number;
  private maxFiles: number;
  private ttlMs: number;
  private now: () => number;
  constructor(options: {
    root: string;
    maxBytes?: number;
    maxStoredBytes?: number;
    maxFiles?: number;
    ttlMs?: number;
    now?: () => number;
  }) {
    this.root = resolve(options.root);
    this.directory = join(this.root, ".mcp-uploads");
    this.maxBytes = options.maxBytes ?? 20 * 1048576;
    this.maxStoredBytes = options.maxStoredBytes ?? 100 * 1048576;
    this.maxFiles = options.maxFiles ?? 100;
    this.ttlMs = options.ttlMs ?? MEDIA_TTL_MS;
    this.now = options.now ?? Date.now;
    for (const value of [this.maxBytes, this.maxStoredBytes, this.maxFiles, this.ttlMs])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid media storage limit");
  }
  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const rel = relative(await realpath(this.root), await realpath(this.directory));
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe media storage directory");
  }
  private dir(fileId: string) {
    if (!MEDIA_ID_PATTERN.test(fileId)) throw new Error("Invalid media fileId");
    return join(this.directory, fileId);
  }
  private async metadata(fileId: string, allowExpired = false): Promise<Metadata> {
    const dir = this.dir(fileId);
    try {
      const path = await new FilePolicy({ root: this.root }).upload(join(dir, "metadata.json"));
      const info = JSON.parse(await readFile(path, "utf8")) as Metadata;
      validateMediaName(info.fileName);
      if (!Number.isFinite(info.expiresAt) || typeof info.ready !== "boolean")
        throw new Error("Invalid media metadata");
      if (!allowExpired && info.expiresAt <= this.now()) throw new Error("Media fileId expired; upload the file again");
      return info;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new Error("Unknown or expired media fileId; upload the file again");
      throw error;
    }
  }
  private path(fileId: string, info: Metadata) {
    return join(this.dir(fileId), "data", info.fileName);
  }
  private async saveMetadata(fileId: string, info: Metadata) {
    const path = join(this.dir(fileId), "metadata.json");
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temp, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(info));
      } finally {
        await file.close();
      }
      await rename(temp, path);
    } finally {
      await rm(temp, { force: true });
    }
  }
  async prune(graceMs = 0): Promise<void> {
    await this.initialize();
    for (const name of await readdir(this.directory)) {
      if (!MEDIA_ID_PATTERN.test(name)) continue;
      const dir = this.dir(name);
      try {
        const info = await this.metadata(name, true);
        if (info.expiresAt + graceMs <= this.now()) await rm(dir, { recursive: true, force: true });
      } catch (error) {
        if ((await stat(dir)).mtimeMs + this.ttlMs + graceMs <= this.now())
          await rm(dir, { recursive: true, force: true });
        else if (!/unknown|expired/i.test((error as Error).message)) throw error;
      }
    }
  }
  private async checkQuota(bytes: number, files = 0) {
    let used = 0,
      count = files;
    for (const name of await readdir(this.directory)) {
      if (!MEDIA_ID_PATTERN.test(name)) continue;
      try {
        const info = await this.metadata(name, true);
        used += (
          await stat(await new FilePolicy({ root: this.root, maxBytes: this.maxBytes }).upload(this.path(name, info)))
        ).size;
      } catch (error) {
        if (!/unknown or expired/i.test((error as Error).message)) throw error;
        // A worker can terminate before committing metadata. Count its bytes and
        // handle against quota until pruning retires it; other uploads can proceed.
        const data = join(this.dir(name), "data");
        let entries: string[];
        try {
          entries = await readdir(data);
        } catch (readError) {
          if ((readError as NodeJS.ErrnoException).code !== "ENOENT") throw readError;
          entries = [];
        }
        for (const entry of entries) {
          const path = await new FilePolicy({ root: this.root, maxBytes: this.maxBytes }).upload(join(data, entry));
          used += (await stat(path)).size;
        }
      }
      count++;
    }
    if (used + bytes > this.maxStoredBytes || count > this.maxFiles)
      throw new Error("Media storage quota reached; wait for temporary files to expire");
  }
  async resolve(fileId: string): Promise<string> {
    await this.initialize();
    const info = await this.metadata(fileId);
    if (!info.ready) throw new Error("Media upload is incomplete; send the remaining chunks with final=true");
    return new FilePolicy({ root: this.root, maxBytes: this.maxBytes }).upload(this.path(fileId, info));
  }
  private async create(fileName: string): Promise<{ fileId: string; info: Metadata }> {
    validateMediaName(fileName);
    await this.prune();
    await this.checkQuota(0, 1);
    const fileId = `media_${randomUUID()}`;
    const info = { fileName, expiresAt: this.now() + this.ttlMs, ready: false };
    await mkdir(join(this.dir(fileId), "data"), { recursive: true, mode: 0o700 });
    try {
      const file = await open(this.path(fileId, info), "wx", 0o600);
      await file.close();
      await this.saveMetadata(fileId, info);
      return { fileId, info };
    } catch (error) {
      await rm(this.dir(fileId), { recursive: true, force: true });
      throw error;
    }
  }
  async upload(chunk: UploadChunk): Promise<UploadedMedia> {
    if (
      chunk.data.length > Math.ceil(MEDIA_CHUNK_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(chunk.data)
    )
      throw new Error("Invalid base64 chunk or chunk size exceeds 512 KiB");
    const data = Buffer.from(chunk.data, "base64");
    if (data.toString("base64") !== chunk.data) throw new Error("Invalid base64 chunk");
    if (data.length > this.maxBytes) throw new Error("Media size exceeds configured limit");
    const offset = chunk.offset ?? 0;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Invalid media chunk offset");
    if (!chunk.fileId && offset !== 0) throw new Error("First media chunk offset must be zero");
    if (!chunk.fileId && !chunk.fileName) throw new Error("A filename is required for the first media chunk");
    const { fileId, info } = chunk.fileId
      ? { fileId: chunk.fileId, info: await this.metadata(chunk.fileId) }
      : await this.create(chunk.fileName as string);
    const fresh = !chunk.fileId;
    try {
      if (chunk.fileName !== undefined && chunk.fileName !== info.fileName)
        throw new Error("Media filename cannot change during upload");
      const path = await new FilePolicy({ root: this.root, maxBytes: this.maxBytes }).upload(this.path(fileId, info));
      const size = (await stat(path)).size;
      const final = chunk.final ?? true;
      if (info.ready && data.length === 0 && offset === size && final) return { ...info, fileId, receivedBytes: size };
      if (offset < size && offset + data.length <= size) {
        const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        const existing = Buffer.alloc(data.length);
        try {
          await file.read(existing, 0, existing.length, offset);
        } finally {
          await file.close();
        }
        if (!existing.equals(data)) throw new Error("Media chunk offset conflicts with previously uploaded bytes");
        if (final && offset + data.length === size && !info.ready) {
          info.ready = true;
          await this.saveMetadata(fileId, info);
        }
        return { ...info, fileId, receivedBytes: size };
      }
      if (info.ready) throw new Error("Media upload is complete and cannot be modified");
      if (offset !== size) throw new Error(`Media chunk offset must equal receivedBytes (${size})`);
      if (size + data.length > this.maxBytes) throw new Error("Media size exceeds configured limit");
      if (final && size + data.length === 0) throw new Error("Media file must not be empty");
      await this.checkQuota(data.length);
      operationSignal()?.throwIfAborted();
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
      try {
        await file.writeFile(data);
      } finally {
        await file.close();
      }
      info.ready = final;
      await this.saveMetadata(fileId, info);
      return { ...info, fileId, receivedBytes: size + data.length };
    } catch (error) {
      if (fresh) await rm(this.dir(fileId), { recursive: true, force: true });
      throw error;
    }
  }
  async importStream(
    fileName: string,
    stream: AsyncIterable<Uint8Array>,
    maxBytes = this.maxBytes,
  ): Promise<UploadedMedia> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new Error("Media download byte budget exhausted");
    const { fileId, info } = await this.create(fileName);
    let size = 0;
    try {
      const file = await open(this.path(fileId, info), constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        for await (const bytes of stream) {
          operationSignal()?.throwIfAborted();
          if (size + bytes.length > Math.min(this.maxBytes, maxBytes))
            throw new Error("Media size exceeds configured limit or remaining album download budget");
          await this.checkQuota(bytes.length);
          await file.writeFile(bytes);
          size += bytes.length;
        }
      } finally {
        await file.close();
      }
      if (!size) throw new Error("Media file must not be empty");
      info.ready = true;
      await this.saveMetadata(fileId, info);
      return { ...info, fileId, receivedBytes: size };
    } catch (error) {
      await rm(this.dir(fileId), { recursive: true, force: true });
      throw error;
    }
  }
}

export function mediaUploadStore(): MediaUploadStore {
  return new MediaUploadStore({
    root: process.env.MCP_TELEGRAM_FILE_ROOT ?? join(tmpdir(), `mcp-telegram-${process.getuid?.() ?? "local"}`),
    maxBytes: process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES ? Number(process.env.MCP_TELEGRAM_MAX_MEDIA_BYTES) : undefined,
  });
}
