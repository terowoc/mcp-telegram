import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Adapter, errors } from "oidc-provider";

type Payload = Record<string, unknown>;
type Row = { id: string; data: string; expires: number | null };
const MAX_OAUTH_RECORDS = 10_000;

/** Persistent adapter shared by all oidc-provider models in this process. */
export function createAdapter(
  path: string,
  options: {
    authenticationBinding?: (accountId: string) => string | undefined;
    persistentAuthorization?: { isGrantValid: (accountId: string, grantId: string) => boolean };
  } = {},
): { new (model: string): Adapter; close(): void } {
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
    CREATE INDEX IF NOT EXISTS oauth_expiry ON oauth(expires) WHERE expires IS NOT NULL;
    CREATE INDEX IF NOT EXISTS oauth_uid ON oauth(model, uid);
    CREATE INDEX IF NOT EXISTS oauth_user_code ON oauth(model, user_code);`);
  const persistentPayload = (model: string, payload: Payload): Payload => {
    if (!options.persistentAuthorization || (model !== "Grant" && (model !== "RefreshToken" || payload.consumed)))
      return payload;
    // Keep consent and the current refresh token until explicit revocation.
    // oidc-provider requires finite issuance TTLs; its opaque payloads allow no exp.
    const stored = { ...payload };
    delete stored.exp;
    if (model === "RefreshToken") stored.expiresWithSession = false;
    return stored;
  };
  if (options.persistentAuthorization) {
    // Promote only still-live approvals. Never recreate an expired or revoked grant.
    // Run before session pruning so a legacy token can outlive its browser session.
    const now = Math.floor(Date.now() / 1000);
    db.exec("BEGIN IMMEDIATE");
    try {
      const approved = new Map<string, string>();
      const rows = db
        .prepare(
          "SELECT model,id,data,expires FROM oauth WHERE model IN ('Grant','RefreshToken','AccessToken') AND (expires IS NULL OR expires>?) ORDER BY CASE model WHEN 'Grant' THEN 0 ELSE 1 END",
        )
        .all(now) as (Row & { model: string })[];
      const update = db.prepare("UPDATE oauth SET data=?,expires=? WHERE model=? AND id=?");
      for (const row of rows) {
        const payload = JSON.parse(row.data) as Payload;
        if (typeof payload.accountId !== "string" || (typeof payload.exp === "number" && payload.exp <= now)) continue;
        if (row.model === "Grant") {
          if (!options.persistentAuthorization.isGrantValid(payload.accountId, row.id)) continue;
          approved.set(row.id, payload.accountId);
        } else if (payload.consumed || approved.get(String(payload.grantId)) !== payload.accountId) continue;
        const stored = persistentPayload(row.model, payload);
        if (row.model === "AccessToken") stored.expiresWithSession = false;
        update.run(JSON.stringify(stored), row.model === "AccessToken" ? row.expires : null, row.model, row.id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      db.close();
      throw error;
    }
  }
  const pruneExpired = () =>
    db.prepare("DELETE FROM oauth WHERE expires IS NOT NULL AND expires <= ?").run(Math.floor(Date.now() / 1000));
  const pruneRevoked = (startup = false) => {
    if (!options.persistentAuthorization) return;
    const now = Math.floor(Date.now() / 1000);
    const grants = db.prepare("SELECT id,data FROM oauth WHERE model='Grant'").all() as Row[];
    for (const row of grants) {
      const payload = JSON.parse(row.data) as Payload;
      // A newly saved consent is bound by the gateway immediately after save().
      // Give that in-flight operation time to finish before background cleanup.
      if (!startup && typeof payload.iat === "number" && payload.iat > now - 60) continue;
      if (
        typeof payload.accountId === "string" &&
        options.persistentAuthorization.isGrantValid(payload.accountId, row.id)
      )
        continue;
      db.prepare("DELETE FROM oauth WHERE (model='Grant' AND id=?) OR grant_id=?").run(row.id, row.id);
    }
    db.prepare(
      "DELETE FROM oauth WHERE model='RefreshToken' AND expires IS NULL AND NOT EXISTS (SELECT 1 FROM oauth g WHERE g.model='Grant' AND g.id=oauth.grant_id)",
    ).run();
  };
  pruneExpired();
  pruneRevoked(true);
  const maintenance = setInterval(() => {
    pruneExpired();
    pruneRevoked();
  }, 60000);
  maintenance.unref();

  return class SqliteAdapter {
    constructor(private model: string) {}

    private isAuthenticationCurrent(payload: Payload): boolean {
      // OIDC auth context survives persisted sessions, interactions and token issuance.
      // A credential reset changes its opaque binding, including across gateway restarts.
      if (
        !options.authenticationBinding ||
        !["Session", "Interaction", "AuthorizationCode", "RefreshToken"].includes(this.model)
      )
        return true;
      const session = payload.session as Payload | undefined;
      const login = (payload.result as { login?: Payload } | undefined)?.login;
      const binding = this.model === "Interaction" ? (login ?? session) : payload;
      if (!binding || typeof binding.accountId !== "string") return true;
      const current = options.authenticationBinding(binding.accountId);
      return !!current && binding.acr === current;
    }

    static close(): void {
      clearInterval(maintenance);
      db.close();
    }

    async upsert(id: string, payload: Payload, expiresIn?: number): Promise<void> {
      if (!this.isAuthenticationCurrent(payload)) throw new Error("Authentication session expired");
      pruneExpired();
      const count = db.prepare("SELECT count(*) AS n FROM oauth").get() as { n: number };
      if (count.n >= MAX_OAUTH_RECORDS && !(await this.find(id))) throw new Error("OAuth storage limit reached");
      const stored = persistentPayload(this.model, payload);
      const expires = stored !== payload || expiresIn === undefined ? null : Math.floor(Date.now() / 1000) + expiresIn;
      db.prepare(`INSERT INTO oauth (model,id,data,expires,grant_id,uid,user_code)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
        data=excluded.data,expires=excluded.expires,grant_id=excluded.grant_id,
        uid=excluded.uid,user_code=excluded.user_code`).run(
        this.model,
        id,
        JSON.stringify(stored),
        expires,
        typeof payload.grantId === "string" ? payload.grantId : null,
        typeof payload.uid === "string" ? payload.uid : null,
        typeof payload.userCode === "string" ? payload.userCode : null,
      );
    }

    private read(column: "id" | "uid" | "user_code", value: string): Payload | undefined {
      const row = db
        .prepare(`SELECT id, data, expires FROM oauth WHERE model=? AND ${column}=?`)
        .get(this.model, value) as Row | undefined;
      if (!row) return undefined;
      if (row.expires !== null && row.expires <= Math.floor(Date.now() / 1000)) {
        db.prepare("DELETE FROM oauth WHERE model=? AND id=?").run(this.model, row.id);
        return undefined;
      }
      const payload = JSON.parse(row.data) as Payload;
      if (!this.isAuthenticationCurrent(payload)) {
        db.prepare("DELETE FROM oauth WHERE model=? AND id=?").run(this.model, row.id);
        return undefined;
      }
      return payload;
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
      const now = Math.floor(Date.now() / 1000);
      if (this.model === "RefreshToken" && options.persistentAuthorization) {
        // A rotation needs both a replacement refresh token and an access token.
        // Refuse before consuming the current token if those records cannot fit.
        pruneExpired();
        pruneRevoked();
        const count = db.prepare("SELECT count(*) AS n FROM oauth").get() as { n: number };
        if (count.n > MAX_OAUTH_RECORDS - 2)
          throw Object.assign(new errors.TemporarilyUnavailable("OAuth storage is full; retry later"), {
            status: 503,
            statusCode: 503,
          });
        // Retain spent tokens briefly for replay detection, then reclaim storage.
        // The current, unconsumed token remains valid indefinitely.
        const expires = now + 86400;
        db.prepare(
          "UPDATE oauth SET data=json_set(data,'$.consumed',?,'$.exp',?),expires=? WHERE model=? AND id=?",
        ).run(now, expires, expires, this.model, id);
        return;
      }
      db.prepare("UPDATE oauth SET data=json_set(data, '$.consumed', ?) WHERE model=? AND id=?").run(
        now,
        this.model,
        id,
      );
    }
    async revokeByGrantId(grantId: string): Promise<void> {
      db.prepare("DELETE FROM oauth WHERE grant_id=?").run(grantId);
    }
  };
}
