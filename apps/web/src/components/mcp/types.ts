export type McpPolicy = { profile: 'read' | 'full'; chatIds: string[]; version: number };
export type TelegramAccount = { id: string; username?: string };
export type SaasMe = {
  user: { id: string; login: string };
  csrfToken: string;
  policy: McpPolicy;
  telegram: {
    state: 'stopped' | 'starting' | 'ready' | 'stopping';
    busy: boolean;
    sessionPresent: boolean;
    account?: TelegramAccount;
  };
  mcpUrl: string;
};
export type McpClient = { grantId: string; clientId: string; version: number };
export type LoginAttempt = {
  id: string;
  state: 'connecting' | 'qr' | 'needs-password' | 'success' | 'error' | 'cancelled' | 'expired';
  expiresAt: number;
  dataUrl?: string;
  account?: TelegramAccount;
  code?: string;
};
export type PanelError = { status: number; code: string; retryAfter?: number };
export type McpPanelState = {
  me?: SaasMe;
  attempt?: LoginAttempt;
  clients: McpClient[];
  recoveryCodes?: string[];
  error?: PanelError;
  isBusy: boolean;
  isSignedOut: boolean;
  hasMismatch: boolean;
  isRecovered?: boolean;
};
