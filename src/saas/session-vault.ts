import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export class SessionVault {
  private readonly key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Session key must be 32 bytes");
    this.key = Buffer.from(key);
  }

  encrypt(userId: string, session: string): string {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(userId));
    const ciphertext = Buffer.concat([cipher.update(session, "utf8"), cipher.final()]);
    return JSON.stringify({
      version: 1,
      nonce: nonce.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      ciphertext: ciphertext.toString("base64url"),
    });
  }

  decrypt(userId: string, envelope: string): string {
    if (Buffer.byteLength(envelope) > 16384) throw new Error("Invalid encrypted session");
    const value = JSON.parse(envelope);
    if (
      value.version !== 1 ||
      [value.nonce, value.tag, value.ciphertext].some(
        (part) => typeof part !== "string" || !/^[A-Za-z0-9_-]+$/.test(part),
      )
    )
      throw new Error("Invalid encrypted session");
    const nonce = Buffer.from(value.nonce, "base64url");
    const tag = Buffer.from(value.tag, "base64url");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid encrypted session");
    const decipher = createDecipheriv("aes-256-gcm", this.key, nonce);
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(value.ciphertext, "base64url")), decipher.final()]).toString(
      "utf8",
    );
  }
}

export async function loadVaultKey(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077) !== 0))
      throw new Error("Session key permissions must be private");
    if (info.size !== 32) throw new Error("Session key must be 32 bytes");
    const key = await file.readFile();
    if (key.length !== 32) throw new Error("Session key must be 32 bytes");
    return key;
  } finally {
    await file.close();
  }
}
