import { lstatSync, readdirSync, statfsSync } from "node:fs";
import { join, resolve } from "node:path";

const MIB = 1048576;
interface Options {
  root: string;
  maxFileBytes?: number;
  maxUserBytes?: number;
  maxTotalBytes?: number;
  maxUserFiles?: number;
  maxTotalFiles?: number;
  minFreeBytes?: number;
  availableBytes?: () => number;
}
type Usage = { bytes: number; files: number };

/** One gateway owns admission; reservations remain held until physical worker settlement. */
export class SaasMediaBudget {
  private readonly root: string;
  private readonly maxFileBytes: number;
  private readonly maxUserBytes: number;
  private readonly maxTotalBytes: number;
  private readonly maxUserFiles: number;
  private readonly maxTotalFiles: number;
  private readonly minFreeBytes: number;
  private readonly reservations = new Map<string, Usage>();
  constructor(private options: Options) {
    this.root = resolve(options.root);
    this.maxFileBytes = options.maxFileBytes ?? 20 * MIB;
    this.maxUserBytes = options.maxUserBytes ?? 100 * MIB;
    this.maxTotalBytes = options.maxTotalBytes ?? 500 * MIB;
    this.maxUserFiles = options.maxUserFiles ?? 100;
    this.maxTotalFiles = options.maxTotalFiles ?? 1000;
    this.minFreeBytes = options.minFreeBytes ?? 256 * MIB;
    for (const value of [
      this.maxFileBytes,
      this.maxUserBytes,
      this.maxTotalBytes,
      this.maxUserFiles,
      this.maxTotalFiles,
      this.minFreeBytes,
    ])
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid media storage budget");
  }

  reserve(userId: string, request: { bytes?: number; files?: number } = {}): () => void {
    if (!/^[a-f0-9-]{36}$/.test(userId)) throw new Error("Invalid media user");
    const bytes = request.bytes ?? this.maxFileBytes,
      files = request.files ?? 1;
    if (!Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(files) || files < 1)
      throw new Error("Invalid media reservation");
    const total: Usage = { bytes: 0, files: 0 },
      user: Usage = { bytes: 0, files: 0 };
    let entries = 0;
    const scan = (path: string, isUser: boolean) => {
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error("Media storage quota cannot inspect symlinks");
      if (info.isDirectory()) {
        for (const entry of readdirSync(path)) {
          if (++entries > this.maxTotalFiles * 2 + 256) throw new Error("Media storage entry quota reached");
          scan(join(path, entry), isUser || (path === this.root && entry === userId));
        }
      } else if (info.isFile()) {
        total.bytes += info.size;
        total.files++;
        if (isUser) {
          user.bytes += info.size;
          user.files++;
        }
      } else throw new Error("Media storage quota requires regular files");
    };
    scan(this.root, false);
    const reserved = [...this.reservations.values()].reduce(
      (sum, value) => ({ bytes: sum.bytes + value.bytes, files: sum.files + value.files }),
      { bytes: 0, files: 0 },
    );
    const own = this.reservations.get(userId) ?? { bytes: 0, files: 0 };
    if (
      user.bytes + own.bytes + bytes > this.maxUserBytes ||
      user.files + own.files + files > this.maxUserFiles ||
      total.bytes + reserved.bytes + bytes > this.maxTotalBytes ||
      total.files + reserved.files + files > this.maxTotalFiles
    )
      throw new Error("Media storage quota reached");
    let available: number;
    if (this.options.availableBytes) available = this.options.availableBytes();
    else {
      const disk = statfsSync(this.root);
      available = disk.bavail * disk.bsize;
    }
    if (!Number.isFinite(available) || available - reserved.bytes - bytes < this.minFreeBytes)
      throw new Error("Media storage disk reserve reached");
    this.reservations.set(userId, { bytes: own.bytes + bytes, files: own.files + files });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.reservations.get(userId);
      if (!current || current.files <= files) this.reservations.delete(userId);
      else this.reservations.set(userId, { bytes: current.bytes - bytes, files: current.files - files });
    };
  }
}
