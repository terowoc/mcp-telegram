export interface UserPolicy {
  profile: "read" | "full";
  chatIds: string[];
  version: number;
}

export interface UserRecord {
  id: string;
  login: string;
  passwordHash?: string;
  credentialVersion: number;
  policy: UserPolicy;
  disabled: boolean;
}

export interface BrowserSession {
  userId: string;
  csrfHash: string;
  expiresAt: number;
  authenticatedAt: number;
}

export interface TelegramAccount {
  id: string;
  username?: string;
}
/** Internal proof emitted only by the server Telegram worker, never a browser DTO. */
export interface VerifiedTelegramLogin {
  attemptId: string;
  account: TelegramAccount;
  session: string;
  authenticatedAt: number;
}
export interface TelegramLoginPlan {
  userId: string;
  telegramId: string;
  action: "create" | "reuse" | "link";
  persistSession: boolean;
  credentialVersion: number;
}

export interface GrantBinding {
  userId: string;
  grantId: string;
  clientId: string;
  version: number;
}

/** Browser DTOs deliberately exclude persistence envelopes and authentication hashes. */
export interface SaasMe {
  user: { id: string; login: string; hasPassword: boolean };
  csrfToken: string;
  policy: UserPolicy;
  telegram: {
    state: "stopped" | "starting" | "ready" | "stopping";
    busy: boolean;
    sessionPresent: boolean;
    account?: { id: string; username?: string };
  };
  mcpUrl: string;
}
export interface SaasClient {
  grantId: string;
  clientId: string;
  version: number;
}
