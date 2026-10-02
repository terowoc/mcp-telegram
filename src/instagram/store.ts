import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { externalId, type InstagramAccess, type InstagramConnection, InstagramError, policySchema } from "./types.js";

export const instagramSchema = `
CREATE TABLE IF NOT EXISTS instagram_connections (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 label TEXT NOT NULL, generation TEXT NOT NULL, account_json TEXT, envelope TEXT,
 policy TEXT NOT NULL, policy_version INTEGER NOT NULL DEFAULT 1,
 removal_pending INTEGER NOT NULL DEFAULT 0, cooldown_until INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS instagram_owner ON instagram_connections(owner_id);
CREATE TABLE IF NOT EXISTS instagram_send_requests (
 connection_id TEXT NOT NULL REFERENCES instagram_connections(id) ON DELETE CASCADE,
 generation TEXT NOT NULL, request_id TEXT NOT NULL, digest TEXT NOT NULL,
 state TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, result_json TEXT,
 PRIMARY KEY(connection_id,generation,request_id));`;

export type SendRecord = {
  state: "new" | "pending" | "unknown" | "confirmed";
  result?: { id: string; timestamp: string };
};
export class InstagramStore {
  constructor(
    private db: DatabaseSync,
    private activeOwner: (id: string) => boolean,
    private invalidate: (owner: string) => void,
  ) {}
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private row(value: unknown): InstagramConnection | undefined {
    if (!value) return undefined;
    const r = value as Record<string, string | number | null>;
    return {
      id: String(r.id),
      ownerId: String(r.owner_id),
      label: String(r.label),
      generation: String(r.generation),
      account: r.account_json ? JSON.parse(String(r.account_json)) : undefined,
      envelope: r.envelope ? String(r.envelope) : undefined,
      policy: JSON.parse(String(r.policy)),
      policyVersion: Number(r.policy_version),
      removalPending: !!r.removal_pending,
      cooldownUntil: Number(r.cooldown_until),
    };
  }
  list(owner: string, includePending = false): InstagramConnection[] {
    if (!this.activeOwner(owner)) return [];
    return this.db
      .prepare("SELECT * FROM instagram_connections WHERE owner_id=? AND (?=1 OR removal_pending=0) ORDER BY rowid")
      .all(owner, Number(includePending))
      .map((r) => this.row(r)!);
  }
  get(owner: string, id: string, includePending = false): InstagramConnection | undefined {
    if (!this.activeOwner(owner)) return undefined;
    return this.row(
      this.db
        .prepare("SELECT * FROM instagram_connections WHERE owner_id=? AND id=? AND (?=1 OR removal_pending=0)")
        .get(owner, id, Number(includePending)),
    );
  }
  private owned(owner: string, id: string): InstagramConnection {
    const c = this.get(owner, id);
    if (!c) throw new InstagramError("not-found");
    return c;
  }
  create(owner: string, label: string): InstagramConnection {
    if (!this.activeOwner(owner)) throw new InstagramError("not-found");
    label = label.trim();
    if (!label || label.length > 80) throw new InstagramError("invalid-label");
    return this.transaction(() => {
      if (this.list(owner, true).length >= 5) throw new InstagramError("account-capacity");
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO instagram_connections(id,owner_id,label,generation,policy) VALUES(?,?,?,?,?)")
        .run(id, owner, label, randomUUID(), JSON.stringify({ profile: "read", threadIds: [] }));
      this.invalidate(owner);
      return this.owned(owner, id);
    });
  }
  rename(owner: string, id: string, label: string): void {
    this.owned(owner, id);
    label = label.trim();
    if (!label || label.length > 80) throw new InstagramError("invalid-label");
    this.transaction(() => {
      this.db.prepare("UPDATE instagram_connections SET label=? WHERE id=?").run(label, id);
      this.invalidate(owner);
    });
  }
  setPolicy(owner: string, id: string, policy: InstagramAccess): void {
    this.owned(owner, id);
    const parsed = policySchema.parse(policy);
    this.transaction(() => {
      this.db
        .prepare("UPDATE instagram_connections SET policy=?,policy_version=policy_version+1,generation=? WHERE id=?")
        .run(JSON.stringify(parsed), randomUUID(), id);
      this.invalidate(owner);
    });
  }
  save(
    owner: string,
    id: string,
    generation: string,
    envelope: string,
    account: { id: string; username?: string },
  ): boolean {
    const c = this.get(owner, id);
    if (!c || c.generation !== generation) return false;
    externalId.parse(account.id);
    if (c.account && c.account.id !== account.id) throw new InstagramError("identity-mismatch");
    if (this.list(owner).some((other) => other.id !== id && other.account?.id === account.id))
      throw new InstagramError("account-already-added");
    return this.transaction(() => {
      this.db
        .prepare(
          "UPDATE instagram_connections SET envelope=?,account_json=? WHERE id=? AND generation=? AND removal_pending=0",
        )
        .run(envelope, JSON.stringify(account), id, generation);
      if (!c.envelope) this.invalidate(owner);
      return true;
    });
  }
  disconnect(owner: string, id: string): void {
    this.owned(owner, id);
    this.transaction(() => {
      this.db.prepare("UPDATE instagram_connections SET envelope=NULL,generation=? WHERE id=?").run(randomUUID(), id);
      this.invalidate(owner);
    });
  }
  remove(owner: string, id: string): void {
    if (!this.get(owner, id, true)) throw new InstagramError("not-found");
    this.transaction(() => {
      this.db
        .prepare("UPDATE instagram_connections SET removal_pending=1,envelope=NULL,generation=? WHERE id=?")
        .run(randomUUID(), id);
      this.invalidate(owner);
    });
  }
  finishRemoval(id: string): void {
    this.db.prepare("DELETE FROM instagram_connections WHERE id=? AND removal_pending=1").run(id);
  }
  pendingRemovals(): string[] {
    return (
      this.db.prepare("SELECT id FROM instagram_connections WHERE removal_pending=1").all() as { id: string }[]
    ).map((r) => r.id);
  }
  ownedIds(owner: string): string[] {
    return (
      this.db.prepare("SELECT id FROM instagram_connections WHERE owner_id=?").all(owner) as { id: string }[]
    ).map((r) => r.id);
  }
  cooldown(id: string, until: number): void {
    this.db.prepare("UPDATE instagram_connections SET cooldown_until=MAX(cooldown_until,?) WHERE id=?").run(until, id);
  }
  recoverSends(): void {
    this.db.prepare("UPDATE instagram_send_requests SET state='unknown' WHERE state='pending'").run();
  }
  beginSend(id: string, generation: string, requestId: string, digest: string): SendRecord {
    return this.transaction(() => {
      const now = Date.now();
      this.db.prepare("DELETE FROM instagram_send_requests WHERE expires_at<=?").run(now);
      const old = this.db
        .prepare(
          "SELECT state,digest,result_json FROM instagram_send_requests WHERE connection_id=? AND generation=? AND request_id=?",
        )
        .get(id, generation, requestId) as
        | { state: SendRecord["state"]; digest: string; result_json?: string }
        | undefined;
      if (old) {
        if (old.digest !== digest) throw new InstagramError("request-conflict");
        return { state: old.state, result: old.result_json ? JSON.parse(old.result_json) : undefined };
      }
      const count = this.db
        .prepare("SELECT COUNT(*) AS n FROM instagram_send_requests WHERE connection_id=?")
        .get(id) as { n: number };
      if (count.n >= 2000) throw new InstagramError("capacity");
      this.db
        .prepare(
          "INSERT INTO instagram_send_requests(connection_id,generation,request_id,digest,state,created_at,expires_at) VALUES(?,?,?,?,'pending',?,?)",
        )
        .run(id, generation, requestId, digest, now, now + 86400000);
      return { state: "new" };
    });
  }
  finishSend(id: string, generation: string, requestId: string, result?: { id: string; timestamp: string }): void {
    this.db
      .prepare(
        "UPDATE instagram_send_requests SET state=?,result_json=? WHERE connection_id=? AND generation=? AND request_id=? AND state='pending'",
      )
      .run(result ? "confirmed" : "unknown", result ? JSON.stringify(result) : null, id, generation, requestId);
  }
}
