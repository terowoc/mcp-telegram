import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { hashOpaqueToken } from "./auth.js";

const COOKIE = "__Host-mcp-bootstrap";
export const readCookie = (header: string | undefined, name: string): string =>
  header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
    ?.slice(name.length + 1) ?? "";
export class BootstrapContexts {
  private contexts = new Map<string, number>();
  private now: () => number;
  constructor(private options: { csrfKey: Buffer; now?: () => number }) {
    if (options.csrfKey.length < 32) throw new Error("Invalid bootstrap CSRF key");
    this.now = options.now ?? Date.now;
  }
  private csrf(token: string) {
    return createHmac("sha256", this.options.csrfKey).update(`bootstrap:${token}`).digest("base64url");
  }
  ensure(req: Request, res: Response): { contextHash: string; csrfToken: string } {
    let token = readCookie(req.headers.cookie, COOKIE);
    if (!this.verify(req, false)) {
      for (const [key, expiry] of this.contexts) if (expiry <= this.now()) this.contexts.delete(key);
      if (this.contexts.size >= 1000) throw new Error("Context capacity reached");
      token = randomBytes(32).toString("base64url");
      this.contexts.set(hashOpaqueToken(token), this.now() + 300000);
      res.cookie(COOKIE, token, { secure: true, httpOnly: true, sameSite: "lax", path: "/", maxAge: 300000 });
    }
    return { contextHash: hashOpaqueToken(token), csrfToken: this.csrf(token) };
  }
  verify(req: Request, mutation: boolean): { contextHash: string } | undefined {
    const token = readCookie(req.headers.cookie, COOKIE);
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined;
    const contextHash = hashOpaqueToken(token),
      expiry = this.contexts.get(contextHash);
    if (!expiry || expiry <= this.now()) return undefined;
    if (mutation) {
      const csrf = req.headers["x-csrf-token"],
        expected = this.csrf(token);
      if (
        typeof csrf !== "string" ||
        Buffer.byteLength(csrf) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(csrf), Buffer.from(expected))
      )
        return undefined;
    }
    return { contextHash };
  }
  extend(req: Request, res: Response): void {
    const context = this.verify(req, false);
    if (!context) return;
    this.contexts.set(context.contextHash, this.now() + 300000);
    res.cookie(COOKIE, readCookie(req.headers.cookie, COOKIE), {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 300000,
    });
  }
  clear(req: Request, res: Response): void {
    this.contexts.delete(hashOpaqueToken(readCookie(req.headers.cookie, COOKIE)));
    res.clearCookie(COOKIE, { secure: true, httpOnly: true, sameSite: "lax", path: "/" });
  }
  close(): void {
    this.contexts.clear();
  }
}
