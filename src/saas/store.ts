import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BrowserSession, GrantBinding, UserPolicy, UserRecord } from "./types.js";

export function normalizeLogin(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_]{3,32}$/.test(value)) throw new Error("Invalid login");
  return value.toLowerCase();
}

type UserRow = { id: string; login: string; password_hash: string; policy: string; disabled: number };

export class SaasStore {
  private readonly db: DatabaseSync;
  private readonly maxUsers: number;

  constructor(path: string, options: { maxUsers?: number } = {}) {
    this.maxUsers = options.maxUsers ?? 100;
    if (!Number.isSafeInteger(this.maxUsers) || this.maxUsers < 1) throw new Error("Invalid account capacity");
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 1) throw new Error("Unsupported SaaS database version");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
          policy TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS recovery (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL,
          PRIMARY KEY(user_id,code_hash));
        CREATE TABLE IF NOT EXISTS browser_sessions (
          id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS browser_session_user ON browser_sessions(user_id);
        CREATE TABLE IF NOT EXISTS telegram_sessions (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, envelope TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS grant_bindings (
          grant_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_id TEXT NOT NULL, policy_version INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS grant_user ON grant_bindings(user_id);
        PRAGMA user_version=1;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private user(row?: UserRow): UserRecord | undefined {
    return row
      ? {
          id: row.id,
          login: row.login,
          passwordHash: row.password_hash,
          policy: JSON.parse(row.policy),
          disabled: !!row.disabled,
        }
      : undefined;
  }

  private active(userId: string): UserRecord {
    const user = this.findUser(userId);
    if (!user || user.disabled) throw new Error("User is inactive");
    return user;
  }

  register(login: string, passwordHash: string, recoveryHashes: string[]): UserRecord {
    const normalized = normalizeLogin(login);
    return this.transaction(() => {
      if (this.findByLogin(normalized)) throw new Error("Login unavailable");
      const count = this.db.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
      if (count.n >= this.maxUsers) throw new Error("Account capacity reached");
      const id = randomUUID();
      const policy: UserPolicy = { profile: "read", chatIds: [], version: 1 };
      this.db
        .prepare("INSERT INTO users(id,login,password_hash,policy) VALUES(?,?,?,?)")
        .run(id, normalized, passwordHash, JSON.stringify(policy));
      for (const hash of recoveryHashes)
        this.db.prepare("INSERT INTO recovery(user_id,code_hash) VALUES(?,?)").run(id, hash);
      return { id, login: normalized, passwordHash, policy, disabled: false };
    });
  }

  findUser(id: string): UserRecord | undefined {
    return this.user(this.db.prepare("SELECT * FROM users WHERE id=?").get(id) as UserRow | undefined);
  }

  findByLogin(login: string): UserRecord | undefined {
    return this.user(
      this.db.prepare("SELECT * FROM users WHERE login=?").get(normalizeLogin(login)) as UserRow | undefined,
    );
  }

  consumeRecovery(login: string, codeHash: string, newPasswordHash: string): boolean {
    return this.transaction(() => {
      const user = this.findByLogin(login);
      if (
        !user ||
        user.disabled ||
        !this.db.prepare("SELECT 1 FROM recovery WHERE user_id=? AND code_hash=?").get(user.id, codeHash)
      )
        return false;
      this.db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(newPasswordHash, user.id);
      this.db.prepare("DELETE FROM recovery WHERE user_id=?").run(user.id);
      this.revokeUserSessions(user.id);
      this.revokeUserGrants(user.id);
      return true;
    });
  }

  putBrowserSession(idHash: string, userId: string, csrfHash: string, expiresAt: number): void {
    this.active(userId);
    this.db.prepare("DELETE FROM browser_sessions WHERE expires_at<=?").run(Date.now());
    this.db
      .prepare("INSERT INTO browser_sessions(id_hash,user_id,csrf_hash,expires_at) VALUES(?,?,?,?)")
      .run(idHash, userId, csrfHash, expiresAt);
  }

  findBrowserSession(idHash: string): BrowserSession | undefined {
    return this.db
      .prepare(`SELECT s.user_id AS userId,s.csrf_hash AS csrfHash,s.expires_at AS expiresAt
      FROM browser_sessions s JOIN users u ON u.id=s.user_id
      WHERE s.id_hash=? AND s.expires_at>? AND u.disabled=0`)
      .get(idHash, Date.now()) as BrowserSession | undefined;
  }

  revokeBrowserSession(idHash: string): void {
    this.db.prepare("DELETE FROM browser_sessions WHERE id_hash=?").run(idHash);
  }

  revokeUserSessions(userId: string): void {
    this.db.prepare("DELETE FROM browser_sessions WHERE user_id=?").run(userId);
  }

  getEncryptedSession(userId: string): string | undefined {
    return (
      this.db.prepare("SELECT envelope FROM telegram_sessions WHERE user_id=?").get(userId) as
        | { envelope: string }
        | undefined
    )?.envelope;
  }

  putEncryptedSession(userId: string, envelope: string): void {
    this.active(userId);
    this.db
      .prepare(
        "INSERT INTO telegram_sessions(user_id,envelope) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET envelope=excluded.envelope",
      )
      .run(userId, envelope);
  }

  deleteEncryptedSession(userId: string): void {
    this.db.prepare("DELETE FROM telegram_sessions WHERE user_id=?").run(userId);
  }

  updatePolicy(userId: string, policy: UserPolicy): number {
    if (
      !["read", "full"].includes(policy.profile) ||
      !Array.isArray(policy.chatIds) ||
      policy.chatIds.length > 100 ||
      policy.chatIds.some((id) => !/^-?[1-9]\d{0,19}$/.test(id))
    )
      throw new Error("Invalid policy");
    return this.transaction(() => {
      const user = this.active(userId);
      const version = user.policy.version + 1;
      this.db
        .prepare("UPDATE users SET policy=? WHERE id=?")
        .run(JSON.stringify({ profile: policy.profile, chatIds: [...new Set(policy.chatIds)], version }), userId);
      this.revokeUserGrants(userId);
      return version;
    });
  }

  bindGrant(userId: string, grantId: string, clientId: string, version: number): void {
    if (this.active(userId).policy.version !== version) throw new Error("Stale grant policy");
    this.db
      .prepare("INSERT INTO grant_bindings(grant_id,user_id,client_id,policy_version) VALUES(?,?,?,?)")
      .run(grantId, userId, clientId, version);
  }

  findGrant(grantId: string): GrantBinding | undefined {
    return this.db
      .prepare(`SELECT g.user_id AS userId,g.grant_id AS grantId,g.client_id AS clientId,g.policy_version AS version
      FROM grant_bindings g JOIN users u ON g.user_id=u.id
      WHERE g.grant_id=? AND u.disabled=0 AND g.policy_version=json_extract(u.policy,'$.version')`)
      .get(grantId) as GrantBinding | undefined;
  }

  revokeUserGrants(userId: string): string[] {
    const rows = this.db.prepare("SELECT grant_id FROM grant_bindings WHERE user_id=?").all(userId) as {
      grant_id: string;
    }[];
    this.db.prepare("DELETE FROM grant_bindings WHERE user_id=?").run(userId);
    return rows.map((row) => row.grant_id);
  }

  disableUser(userId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE users SET disabled=1 WHERE id=?").run(userId);
      this.revokeUserSessions(userId);
      this.revokeUserGrants(userId);
    });
  }

  close(): void {
    this.db.close();
  }
}

export function createSaasStore(path: string, options?: { maxUsers?: number }): SaasStore {
  return new SaasStore(path, options);
}
