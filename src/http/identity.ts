import type { ToolPolicy } from "../tool-policy.js";
import { ToolPolicy as Policy } from "../tool-policy.js";
import { verifyPassword } from "./owner.js";

export interface GatewayIdentity {
  readonly kind: "owner" | "saas";
  findAccount(id: string, grantId?: string): { accountId: string; claims: () => Promise<{ sub: string }> } | undefined;
  authenticate(credentials: { login?: string; password: string }): Promise<string | undefined>;
  isActive(id: string): boolean;
  bindGrant(accountId: string, grantId: string, clientId: string): void;
  isGrantValid(accountId: string, grantId: string): boolean;
  toolPolicy(accountId: string): ToolPolicy;
  callTool(
    accountId: string,
    name: string,
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
  describeAccess(accountId?: string): string;
  consentBinding?(accountId?: string): string;
}
export function ownerIdentity(options: {
  ownerPasswordHash: string;
  callTool: GatewayIdentity["callTool"] extends (id: string, ...args: infer A) => Promise<unknown>
    ? (...args: A) => Promise<unknown>
    : never;
}): GatewayIdentity {
  return {
    kind: "owner",
    findAccount: (id) => (id === "owner" ? { accountId: id, claims: async () => ({ sub: id }) } : undefined),
    authenticate: async ({ password }) =>
      (await verifyPassword(password, options.ownerPasswordHash)) ? "owner" : undefined,
    isActive: (id) => id === "owner",
    bindGrant: () => {},
    isGrantValid: (id) => id === "owner",
    toolPolicy: () => new Policy(),
    callTool: async (id, ...args) => {
      if (id !== "owner") throw new Error("Inactive account");
      return options.callTool(...args);
    },
    describeAccess: () => "Чтение и изменение Telegram от имени владельца.",
  };
}
