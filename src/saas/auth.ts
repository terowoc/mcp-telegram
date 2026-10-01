import { createHash, createHmac, randomBytes } from "node:crypto";
import { hashPassword, verifyPassword } from "../http/owner.js";
import type { SessionVault } from "./session-vault.js";
import { normalizeLogin, type SaasStore } from "./store.js";
import type { UserRecord, VerifiedTelegramLogin } from "./types.js";

export const hashOpaqueToken = (token: string): string => createHash("sha256").update(token).digest("hex");
const opaqueToken = (): string => randomBytes(32).toString("base64url");

export class SaasAuth {
  private readonly csrfKey: Buffer;
  constructor(
    private readonly store: SaasStore,
    options: { csrfKey: Buffer },
  ) {
    if (options.csrfKey.length < 32) throw new Error("Invalid CSRF key");
    this.csrfKey = Buffer.from(options.csrfKey);
  }

  private csrf(token: string): string {
    return createHmac("sha256", this.csrfKey).update(token).digest("base64url");
  }

  private session(userId: string) {
    const sessionToken = opaqueToken();
    const csrfToken = this.csrf(sessionToken);
    this.store.putBrowserSession(
      hashOpaqueToken(sessionToken),
      userId,
      hashOpaqueToken(csrfToken),
      Date.now() + 86400000,
    );
    return { userId, sessionToken, csrfToken };
  }

  async register(login: string, password: string) {
    normalizeLogin(login);
    const passwordHash = await hashPassword(password);
    const recoveryCodes = Array.from({ length: 8 }, opaqueToken);
    const user = this.store.register(login, passwordHash, recoveryCodes.map(hashOpaqueToken));
    return { ...this.session(user.id), recoveryCodes };
  }

  async login(login: string, password: string) {
    let user: UserRecord | undefined;
    try {
      user = this.store.findByLogin(login);
    } catch {
      return undefined;
    }
    if (!user || user.disabled || !user.passwordHash || !(await verifyPassword(password, user.passwordHash)))
      return undefined;
    // Password hashing yields: a reset/disable may have occurred while it was running.
    const current = this.store.findUser(user.id);
    if (!current || current.disabled || current.passwordHash !== user.passwordHash) return undefined;
    return this.session(user.id);
  }

  authenticate(sessionToken: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return undefined;
    const session = this.store.findBrowserSession(hashOpaqueToken(sessionToken));
    if (!session) return undefined;
    return { ...session, csrfToken: this.csrf(sessionToken) };
  }

  async recover(login: string, code: string, newPassword: string): Promise<{ recoveryCodes: string[] } | undefined> {
    try {
      normalizeLogin(login);
      if (!/^[A-Za-z0-9_-]{43}$/.test(code)) return undefined;
      const passwordHash = await hashPassword(newPassword);
      const recoveryCodes = Array.from({ length: 8 }, opaqueToken);
      return this.store.consumeRecovery(login, hashOpaqueToken(code), passwordHash, recoveryCodes.map(hashOpaqueToken))
        ? { recoveryCodes }
        : undefined;
    } catch {
      return undefined;
    }
  }

  logout(sessionToken: string): void {
    this.store.revokeBrowserSession(hashOpaqueToken(sessionToken));
  }

  async verifyLegacyPassword(userId: string, password: string): Promise<boolean> {
    const user = this.store.findUser(userId);
    if (!user || user.disabled || !user.passwordHash || !(await verifyPassword(password, user.passwordHash)))
      return false;
    const current = this.store.findUser(userId);
    return (
      !!current &&
      !current.disabled &&
      current.passwordHash === user.passwordHash &&
      current.credentialVersion === user.credentialVersion
    );
  }

  completeTelegramLogin(proof: VerifiedTelegramLogin, options: { vault: SessionVault; legacyUserId?: string }) {
    if (
      !proof.session ||
      proof.session.length > 16384 ||
      !Number.isSafeInteger(proof.authenticatedAt) ||
      proof.authenticatedAt > Date.now() + 1000 ||
      proof.authenticatedAt < Date.now() - 300000
    )
      throw new Error("Invalid Telegram proof");
    const plan = this.store.planTelegramLogin(proof.account, options.legacyUserId);
    const sessionToken = opaqueToken(),
      csrfToken = this.csrf(sessionToken);
    const user = this.store.commitTelegramLogin(plan, {
      account: proof.account,
      envelope: plan.persistSession ? options.vault.encrypt(plan.userId, proof.session) : undefined,
      browserSession: {
        idHash: hashOpaqueToken(sessionToken),
        csrfHash: hashOpaqueToken(csrfToken),
        expiresAt: Date.now() + 86400000,
        authenticatedAt: proof.authenticatedAt,
      },
    });
    return { userId: user.id, sessionToken, csrfToken };
  }
}
