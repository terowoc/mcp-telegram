import { randomBytes } from "node:crypto";

interface Continuation {
  interactionUid: string;
  clientId: string;
  contextHash: string;
  expiresAt: number;
  requireFreshAuthentication: boolean;
}
export class OAuthContinuations {
  private entries = new Map<string, Continuation>();
  private fresh = new Map<string, { since: number; expiresAt: number }>();
  create(input: Continuation): string {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(input.interactionUid)) throw new Error("Invalid interaction UID");
    this.prune();
    if (this.entries.size >= 1000) throw new Error("OAuth continuation capacity reached");
    const handle = randomBytes(32).toString("base64url");
    this.entries.set(handle, { ...input });
    return handle;
  }
  private prune() {
    for (const [key, entry] of this.entries) if (entry.expiresAt <= Date.now()) this.entries.delete(key);
    for (const [key, entry] of this.fresh) if (entry.expiresAt <= Date.now()) this.fresh.delete(key);
  }
  find(id: string, contextHash: string): Continuation | undefined {
    this.prune();
    const entry = this.entries.get(id);
    return entry?.contextHash === contextHash ? { ...entry } : undefined;
  }
  consume(id: string, contextHash: string): Continuation | undefined {
    const entry = this.find(id, contextHash);
    if (entry) this.entries.delete(id);
    return entry;
  }
  freshSince(uid: string, expiresAt: number): number {
    this.prune();
    let current = this.fresh.get(uid);
    if (!current) {
      if (this.fresh.size >= 1000) throw new Error("OAuth freshness capacity reached");
      current = { since: Date.now(), expiresAt };
      this.fresh.set(uid, current);
    }
    return current.since;
  }
  close(): void {
    this.entries.clear();
    this.fresh.clear();
  }
}
