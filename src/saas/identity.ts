import { ACCOUNT_LIST_TOOL } from "../http/account-tools.js";
import type { GatewayIdentity } from "../http/identity.js";
import { hostedToolVisible } from "../http/tool-catalog.js";
import type { McpRegisteredTool } from "../ipc-protocol.js";
import { ToolPolicy } from "../tool-policy.js";
import { hashOpaqueToken, type SaasAuth } from "./auth.js";
import { readCookie } from "./bootstrap-contexts.js";
import { SAAS_COOKIE } from "./routes.js";
import type { SaasStore } from "./store.js";
import type { WorkerSupervisor } from "./supervisor.js";

class SaasToolPolicy extends ToolPolicy {
  constructor(private policies: ToolPolicy[]) {
    super({ profile: "full", chatIds: [] });
  }
  override visible(name: string, tool: McpRegisteredTool): boolean {
    if (name === "telegram-login" || name === "telegram-logout") return false;
    return (
      name === "telegram-status" ||
      name === ACCOUNT_LIST_TOOL ||
      this.policies.some((policy) => policy.visible(name, tool))
    );
  }
}
export function createSaasIdentity(
  store: SaasStore,
  auth: SaasAuth,
  supervisor: Pick<WorkerSupervisor, "call">,
): GatewayIdentity {
  const active = (id: string) => {
    const user = store.findUser(id);
    return user && !user.disabled ? user : undefined;
  };
  const valid = (id: string, grantId: string) => {
    const grant = store.findGrant(grantId);
    return !!active(id) && grant?.userId === id;
  };
  const binding = (id: string) => {
    const user = active(id);
    return user
      ? `urn:tg-bridge:credential:${hashOpaqueToken(user.credentialVersion === 0 && user.passwordHash ? user.passwordHash : `${user.id}:${user.credentialVersion}`)}`
      : undefined;
  };
  const consent = (id?: string) => {
    const user = id ? active(id) : undefined;
    return user
      ? JSON.stringify(
          store.listTelegramConnections(user.id).map((connection) => ({
            id: connection.id,
            label: connection.label,
            policy: connection.policy,
            account: store.getTelegramAccount(connection.id),
            connected: !!store.getEncryptedSession(connection.id),
          })),
        )
      : "inactive";
  };
  return {
    kind: "saas",
    isActive: (id) => !!active(id),
    isGrantValid: valid,
    findAccount: (id, grantId) =>
      active(id) && (!grantId || valid(id, grantId)) ? { accountId: id, claims: async () => ({ sub: id }) } : undefined,
    authenticate: async ({ login, password }) => {
      if (!login) return undefined;
      const session = await auth.login(login, password);
      if (!session) return undefined;
      auth.logout(session.sessionToken);
      return session.userId;
    },
    bindGrant: (id, grantId, clientId, expectedConsent) => {
      if (expectedConsent !== undefined && expectedConsent !== consent(id))
        throw new Error("Consent changed; reconnect the client");
      const user = active(id);
      if (!user) throw new Error("Inactive account");
      const existing = store.findGrant(grantId);
      if (existing) {
        if (existing.userId !== id || existing.clientId !== clientId || existing.version !== user.policy.version)
          throw new Error("Grant binding mismatch");
        return;
      }
      store.bindGrant(id, grantId, clientId, user.policy.version);
    },
    toolPolicy: (id, selected) => {
      if (!active(id)) throw new Error("Inactive account");
      if (selected !== undefined) {
        if (!store.ownsTelegramConnection(id, selected)) throw new Error("Telegram account unavailable");
        const user = active(selected);
        if (!user) throw new Error("Inactive account");
        return new SaasToolPolicy(store.getEncryptedSession(selected) ? [new ToolPolicy(user.policy)] : []);
      }
      return new SaasToolPolicy(
        store
          .listTelegramConnections(id)
          .filter((user) => store.getEncryptedSession(user.id))
          .map((user) => new ToolPolicy(user.policy)),
      );
    },
    callTool: async (id, name, args, options) => {
      if (!active(id)) throw new Error("Inactive account");
      if (name === ACCOUNT_LIST_TOOL) {
        const accounts = store.listTelegramConnections(id).map((user) => ({
          id: user.id,
          label: user.label,
          primary: user.primary,
          connected: !!store.getEncryptedSession(user.id),
          account: store.getTelegramAccount(user.id),
          policy: user.policy,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify({ accounts, defaultAccountId: id }) }],
          structuredContent: { accounts, defaultAccountId: id },
        };
      }
      const { telegramAccountId, ...workerArgs } = args;
      const selected = telegramAccountId === undefined ? id : telegramAccountId;
      if (typeof selected !== "string" || !store.ownsTelegramConnection(id, selected))
        throw new Error("Telegram account unavailable");
      if (name === "telegram-login" || name === "telegram-logout")
        throw new Error("Use the cabinet to connect Telegram accounts");
      if (!store.getEncryptedSession(selected)) {
        if (name !== "telegram-status") throw new Error("Telegram setup required for the selected account");
        return {
          content: [{ type: "text", text: "Not connected. Open your Telegram MCP cabinet to connect this account." }],
        };
      }
      const selectedUser = active(selected);
      if (!selectedUser) throw new Error("Inactive account");
      if (!hostedToolVisible(new ToolPolicy(selectedUser.policy), name))
        throw new Error("Tool unavailable under selected account policy");
      return supervisor.call(selected, name, workerArgs, options);
    },
    consentBinding: consent,
    authenticationBinding: binding,
    browserAuthentication: (cookieHeader) => {
      const session = auth.authenticate(readCookie(cookieHeader, SAAS_COOKIE));
      const current = session ? binding(session.userId) : undefined;
      return session && current
        ? { accountId: session.userId, authenticatedAt: session.authenticatedAt, binding: current }
        : undefined;
    },
    describeAccess: (id) => {
      const user = id ? active(id) : undefined;
      if (!user) return "Доступ к Telegram вашего аккаунта. Разрешения задаются в разделе MCP.";
      return store
        .listTelegramConnections(user.id)
        .map(
          (connection) =>
            `${connection.label}: ${connection.policy.profile === "read" ? "Только чтение" : "Чтение и изменение"} Telegram. ${connection.policy.chatIds.length ? `Разрешённые чаты: ${connection.policy.chatIds.join(", ")}` : "Все чаты аккаунта"}.`,
        )
        .join(" ");
    },
  };
}
