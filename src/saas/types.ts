export interface UserPolicy {
  profile: "read" | "full";
  chatIds: string[];
  version: number;
}

export interface UserRecord {
  id: string;
  login: string;
  passwordHash: string;
  policy: UserPolicy;
  disabled: boolean;
}

export interface BrowserSession {
  userId: string;
  csrfHash: string;
  expiresAt: number;
}

export interface GrantBinding {
  userId: string;
  grantId: string;
  clientId: string;
  version: number;
}

/** Browser DTOs deliberately exclude persistence envelopes and authentication hashes. */
export interface SaasMe {
  user: { id: string; login: string };
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
