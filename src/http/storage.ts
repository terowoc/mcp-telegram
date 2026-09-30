import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Adapter } from "oidc-provider";

type Payload = Record<string, unknown>;
type Row = { data: string; expires: number | null };

/** Persistent adapter shared by all oidc-provider models in this process. */
export function createAdapter(path: string): { new (model: string): Adapter; close(): void } {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS oauth (
      model TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL,
      expires INTEGER, grant_id TEXT, uid TEXT, user_code TEXT,
      PRIMARY KEY (model, id)
    );
    CREATE INDEX IF NOT EXISTS oauth_grant ON oauth(grant_id);
    CREATE INDEX IF NOT EXISTS oauth_uid ON oauth(model, uid);
    CREATE INDEX IF NOT EXISTS oauth_user_code ON oauth(model, user_code);`);

  return class SqliteAdapter {
    constructor(private model: string) {}

    static close(): void {
      db.close();
    }

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      db.prepare("DELETE FROM oauth WHERE expires IS NOT NULL AND expires <= ?").run(Math.floor(Date.now() / 1000));
      const count = db.prepare("SELECT count(*) AS n FROM oauth").get() as { n: number };
      if (count.n >= 10_000 && !(await this.find(id))) throw new Error("OAuth storage limit reached");
      const expires = expiresIn === undefined ? null : Math.floor(Date.now() / 1000) + expiresIn;
      db.prepare(`INSERT INTO oauth (model,id,data,expires,grant_id,uid,user_code)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
        data=excluded.data,expires=excluded.expires,grant_id=excluded.grant_id,
        uid=excluded.uid,user_code=excluded.user_code`).run(
        this.model,
        id,
        JSON.stringify(payload),
        expires,
        typeof payload.grantId === "string" ? payload.grantId : null,
        typeof payload.uid === "string" ? payload.uid : null,
        typeof payload.userCode === "string" ? payload.userCode : null,
      );
    }

    private read(column: "id" | "uid" | "user_code", value: string): Payload | undefined {
      const row = db.prepare(`SELECT data, expires FROM oauth WHERE model=? AND ${column}=?`).get(this.model, value) as
        | Row
        | undefined;
      if (!row || (row.expires !== null && row.expires <= Math.floor(Date.now() / 1000))) return undefined;
      return JSON.parse(row.data) as Payload;
    }

    async find(id: string): Promise<Payload | undefined> {
      return this.read("id", id);
    }
    async findByUid(uid: string): Promise<Payload | undefined> {
      return this.read("uid", uid);
    }
    async findByUserCode(code: string): Promise<Payload | undefined> {
      return this.read("user_code", code);
    }
    async destroy(id: string): Promise<void> {
      db.prepare("DELETE FROM oauth WHERE model=? AND id=?").run(this.model, id);
    }
    async consume(id: string): Promise<void> {
      db.prepare("UPDATE oauth SET data=json_set(data, '$.consumed', ?) WHERE model=? AND id=?").run(
        Math.floor(Date.now() / 1000),
        this.model,
        id,
      );
    }
    async revokeByGrantId(grantId: string): Promise<void> {
      db.prepare("DELETE FROM oauth WHERE grant_id=?").run(grantId);
    }
  };
}
