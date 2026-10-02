import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import { sessionState } from "./types.js";

export class InstagramVault {
  readonly digestKey: Buffer;
  private key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error("Session key must be 32 bytes");
    this.key = createHmac("sha256", key).update("instagram/session/v1").digest();
    this.digestKey = createHmac("sha256", key).update("instagram/send/v1").digest();
  }
  encrypt(owner: string, id: string, state: unknown): string {
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify([owner, id])));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(sessionState(state)), "utf8"), cipher.final()]);
    return JSON.stringify({
      version: 1,
      iv: iv.toString("base64url"),
      tag: cipher.getAuthTag().toString("base64url"),
      data: bytes.toString("base64url"),
    });
  }
  decrypt(owner: string, id: string, envelope: string): Record<string, unknown> {
    if (Buffer.byteLength(envelope) > 98304) throw new Error("Invalid session envelope");
    const e = JSON.parse(envelope);
    if (e.version !== 1 || [e.iv, e.tag, e.data].some((v) => typeof v !== "string" || !/^[A-Za-z0-9_-]+$/.test(v)))
      throw new Error("Invalid session envelope");
    const iv = Buffer.from(e.iv, "base64url"),
      tag = Buffer.from(e.tag, "base64url");
    if (iv.length !== 12 || tag.length !== 16) throw new Error("Invalid session envelope");
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAAD(Buffer.from(JSON.stringify([owner, id])));
    decipher.setAuthTag(tag);
    return sessionState(
      JSON.parse(Buffer.concat([decipher.update(Buffer.from(e.data, "base64url")), decipher.final()]).toString("utf8")),
    );
  }
}
