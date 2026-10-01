import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  BrowserSession,
  GrantBinding,
  TelegramAccount,
  TelegramLoginPlan,
  UserPolicy,
  UserRecord,
} from "./types.js";

export function normalizeLogin(value: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_]{3,32}$/.test(value)) throw new Error("Invalid login");
  return value.toLowerCase();
}

type UserRow = {
  id: string;
  login: string;
  password_hash: string | null;
  credential_version: number;
  policy: string;
  disabled: number;
};

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
      if (version.user_version > 3) throw new Error("Unsupported SaaS database version");
      this.db.exec("PRAGMA foreign_keys=OFF");
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY, login TEXT NOT NULL UNIQUE, password_hash TEXT,
          credential_version INTEGER NOT NULL DEFAULT 0,
          policy TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS recovery (
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, code_hash TEXT NOT NULL,
          PRIMARY KEY(user_id,code_hash));
        CREATE TABLE IF NOT EXISTS browser_sessions (
          id_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS browser_session_user ON browser_sessions(user_id);
        CREATE TABLE IF NOT EXISTS telegram_sessions (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, envelope TEXT NOT NULL, account_json TEXT);
        CREATE TABLE IF NOT EXISTS grant_bindings (
          grant_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_id TEXT NOT NULL, policy_version INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS grant_user ON grant_bindings(user_id);
      `);
      const columns = this.db.prepare("PRAGMA table_info(telegram_sessions)").all() as { name: string }[];
      if (!columns.some((column) => column.name === "account_json"))
        this.db.exec("ALTER TABLE telegram_sessions ADD COLUMN account_json TEXT");
      const userColumns = this.db.prepare("PRAGMA table_info(users)").all() as { name: string; notnull: number }[];
      if (!userColumns.some((c) => c.name === "credential_version")) {
        this.db.exec(`
          CREATE TABLE users_v3 (
            id TEXT PRIMARY KEY,login TEXT NOT NULL UNIQUE,password_hash TEXT,
            credential_version INTEGER NOT NULL DEFAULT 0,policy TEXT NOT NULL,disabled INTEGER NOT NULL DEFAULT 0);
          INSERT INTO users_v3(id,login,password_hash,policy,disabled) SELECT id,login,password_hash,policy,disabled FROM users;
          DROP TABLE users;
          ALTER TABLE users_v3 RENAME TO users;`);
      }
      const browserColumns = this.db.prepare("PRAGMA table_info(browser_sessions)").all() as { name: string }[];
      if (!browserColumns.some((c) => c.name === "authenticated_at"))
        this.db.exec("ALTER TABLE browser_sessions ADD COLUMN authenticated_at INTEGER NOT NULL DEFAULT 0");
      this.db.exec(`CREATE TABLE IF NOT EXISTS telegram_identities (
        telegram_id TEXT PRIMARY KEY,user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE);`);
      if (this.db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("Invalid SaaS foreign keys");
      this.db.exec("PRAGMA user_version=3; COMMIT; PRAGMA foreign_keys=ON;");
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
          passwordHash: row.password_hash ?? undefined,
          credentialVersion: row.credential_version,
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
      return { id, login: normalized, passwordHash, credentialVersion: 0, policy, disabled: false };
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

  consumeRecovery(login: string, codeHash: string, newPasswordHash: string, replacements: string[] = []): boolean {
    return this.transaction(() => {
      const user = this.findByLogin(login);
      if (
        !user ||
        user.disabled ||
        !this.db.prepare("SELECT 1 FROM recovery WHERE user_id=? AND code_hash=?").get(user.id, codeHash)
      )
        return false;
      this.db
        .prepare("UPDATE users SET password_hash=?,credential_version=credential_version+1 WHERE id=?")
        .run(newPasswordHash, user.id);
      this.db.prepare("DELETE FROM recovery WHERE user_id=?").run(user.id);
      for (const hash of replacements)
        this.db.prepare("INSERT INTO recovery(user_id,code_hash) VALUES(?,?)").run(user.id, hash);
      this.revokeUserSessions(user.id);
      this.revokeUserGrants(user.id);
      return true;
    });
  }

  putBrowserSession(
    idHash: string,
    userId: string,
    csrfHash: string,
    expiresAt: number,
    authenticatedAt = Date.now(),
  ): void {
    this.active(userId);
    this.db.prepare("DELETE FROM browser_sessions WHERE expires_at<=?").run(Date.now());
    this.db
      .prepare("INSERT INTO browser_sessions(id_hash,user_id,csrf_hash,expires_at,authenticated_at) VALUES(?,?,?,?,?)")
      .run(idHash, userId, csrfHash, expiresAt, authenticatedAt);
  }

  findBrowserSession(idHash: string): BrowserSession | undefined {
    return this.db
      .prepare(`SELECT s.user_id AS userId,s.csrf_hash AS csrfHash,s.expires_at AS expiresAt,s.authenticated_at AS authenticatedAt
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
        "INSERT INTO telegram_sessions(user_id,envelope) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET envelope=excluded.envelope, account_json=NULL",
      )
      .run(userId, envelope);
  }

  deleteEncryptedSession(userId: string): void {
    this.db.prepare("DELETE FROM telegram_sessions WHERE user_id=?").run(userId);
  }

  getTelegramAccount(userId: string): { id: string; username?: string } | undefined {
    const row = this.db.prepare("SELECT account_json FROM telegram_sessions WHERE user_id=?").get(userId) as
      | { account_json: string | null }
      | undefined;
    return row?.account_json ? JSON.parse(row.account_json) : undefined;
  }

  putTelegramAccount(userId: string, account: { id: string; username?: string }): void {
    this.active(userId);
    const bound = this.db.prepare("SELECT telegram_id FROM telegram_identities WHERE user_id=?").get(userId) as
      | { telegram_id: string }
      | undefined;
    if (bound && bound.telegram_id !== account.id) throw new Error("Telegram identity mismatch");
    if (
      !this.db
        .prepare("UPDATE telegram_sessions SET account_json=? WHERE user_id=?")
        .run(JSON.stringify(account), userId).changes
    )
      throw new Error("Telegram session required before saving identity");
  }

  putVerifiedTelegramSession(userId: string, envelope: string, account: { id: string; username?: string }): void {
    this.transaction(() => {
      this.active(userId);
      const bound = this.db.prepare("SELECT telegram_id FROM telegram_identities WHERE user_id=?").get(userId) as
        | { telegram_id: string }
        | undefined;
      if (bound && bound.telegram_id !== account.id) throw new Error("Telegram identity mismatch");
      this.db
        .prepare(
          "INSERT INTO telegram_sessions(user_id,envelope,account_json) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET envelope=excluded.envelope,account_json=excluded.account_json",
        )
        .run(userId, envelope, JSON.stringify(account));
    });
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

  listGrants(userId: string): GrantBinding[] {
    return this.db
      .prepare(`SELECT user_id AS userId, grant_id AS grantId, client_id AS clientId,
      policy_version AS version FROM grant_bindings WHERE user_id=?`)
      .all(userId) as unknown as GrantBinding[];
  }

  revokeGrant(userId: string, grantId: string): void {
    this.db.prepare("DELETE FROM grant_bindings WHERE user_id=? AND grant_id=?").run(userId, grantId);
  }

  deleteUser(userId: string): void {
    const user = this.findUser(userId);
    if (user && !user.disabled) throw new Error("Disable user before deleting");
    this.db.prepare("DELETE FROM users WHERE id=?").run(userId);
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

  findByTelegramId(id: string): UserRecord | undefined {
    return this.user(
      this.db
        .prepare("SELECT u.* FROM users u JOIN telegram_identities t ON u.id=t.user_id WHERE t.telegram_id=?")
        .get(id) as UserRow | undefined,
    );
  }

  planTelegramLogin(account: TelegramAccount, legacyUserId?: string): TelegramLoginPlan {
    if (!/^[1-9]\d{0,19}$/.test(account.id)) throw new Error("Invalid Telegram identity");
    const bound = this.findByTelegramId(account.id);
    if (bound) {
      this.active(bound.id);
      if (legacyUserId && legacyUserId !== bound.id) throw new Error("Telegram identity conflict");
      return {
        userId: bound.id,
        telegramId: account.id,
        action: "reuse",
        persistSession: !this.getEncryptedSession(bound.id),
        credentialVersion: bound.credentialVersion,
      };
    }
    if (legacyUserId) {
      const user = this.active(legacyUserId);
      const identity = this.db.prepare("SELECT telegram_id FROM telegram_identities WHERE user_id=?").get(user.id);
      const oldAccount = this.getTelegramAccount(user.id);
      if (identity || (oldAccount && oldAccount.id !== account.id)) throw new Error("Telegram identity conflict");
      return {
        userId: user.id,
        telegramId: account.id,
        action: "link",
        persistSession: !this.getEncryptedSession(user.id),
        credentialVersion: user.credentialVersion,
      };
    }
    const candidates = this.db
      .prepare(
        "SELECT 1 FROM telegram_sessions s JOIN users u ON u.id=s.user_id WHERE json_extract(s.account_json,'$.id')=?",
      )
      .get(account.id);
    if (candidates) throw new Error("legacy-link-required");
    return {
      userId: randomUUID(),
      telegramId: account.id,
      action: "create",
      persistSession: true,
      credentialVersion: 1,
    };
  }

  commitTelegramLogin(
    plan: TelegramLoginPlan,
    input: {
      account: TelegramAccount;
      envelope?: string;
      browserSession: { idHash: string; csrfHash: string; expiresAt: number; authenticatedAt: number };
    },
  ): UserRecord {
    return this.transaction(() => {
      const current = this.planTelegramLogin(input.account, plan.action === "link" ? plan.userId : undefined);
      if (
        current.action !== plan.action ||
        current.telegramId !== plan.telegramId ||
        current.credentialVersion !== plan.credentialVersion ||
        current.persistSession !== plan.persistSession ||
        (plan.action !== "create" && current.userId !== plan.userId)
      )
        throw new Error("Telegram login plan changed");
      if (plan.persistSession && !input.envelope) throw new Error("Encrypted Telegram session required");
      if (plan.action === "create") {
        const count = this.db.prepare("SELECT count(*) AS n FROM users").get() as { n: number };
        if (count.n >= this.maxUsers) throw new Error("Account capacity reached");
        const login = `tg_${plan.userId.replaceAll("-", "").slice(0, 29)}`;
        this.db
          .prepare("INSERT INTO users(id,login,password_hash,credential_version,policy) VALUES(?,?,NULL,1,?)")
          .run(plan.userId, login, JSON.stringify({ profile: "read", chatIds: [], version: 1 }));
      } else if (plan.action === "link") {
        this.db.prepare("UPDATE users SET credential_version=credential_version+1 WHERE id=?").run(plan.userId);
        this.revokeUserSessions(plan.userId);
        this.revokeUserGrants(plan.userId);
      }
      if (plan.action !== "reuse")
        this.db
          .prepare("INSERT INTO telegram_identities(telegram_id,user_id) VALUES(?,?)")
          .run(plan.telegramId, plan.userId);
      if (plan.persistSession) {
        this.putEncryptedSession(plan.userId, input.envelope!);
        this.putTelegramAccount(plan.userId, input.account);
      }
      const browser = input.browserSession;
      this.putBrowserSession(browser.idHash, plan.userId, browser.csrfHash, browser.expiresAt, browser.authenticatedAt);
      return this.active(plan.userId);
    });
  }
}

export function createSaasStore(path: string, options?: { maxUsers?: number }): SaasStore {
  return new SaasStore(path, options);
}
