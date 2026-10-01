import type { GatewayIdentity } from "../http/identity.js";
import type { McpRegisteredTool } from "../ipc-protocol.js";
import { ToolPolicy } from "../tool-policy.js";
import { hashOpaqueToken, type SaasAuth } from "./auth.js";
import { readCookie } from "./bootstrap-contexts.js";
import { SAAS_COOKIE } from "./routes.js";
import type { SaasStore } from "./store.js";
import type { WorkerSupervisor } from "./supervisor.js";

class SaasToolPolicy extends ToolPolicy {
  constructor(
    private connected: boolean,
    options: ConstructorParameters<typeof ToolPolicy>[0],
  ) {
    super(options);
  }
  override visible(name: string, tool: McpRegisteredTool): boolean {
    if (name === "telegram-login" || name === "telegram-logout") return false;
    if (!this.connected) return name === "telegram-status";
    return super.visible(name, tool);
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
    bindGrant: (id, grantId, clientId) => {
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
    toolPolicy: (id) => {
      const user = active(id);
      if (!user) throw new Error("Inactive account");
      return new SaasToolPolicy(!!store.getEncryptedSession(id), user.policy);
    },
    callTool: async (id, name, args, options) => {
      if (!active(id)) throw new Error("Inactive account");
      if (!store.getEncryptedSession(id)) {
        if (name !== "telegram-status") throw new Error("Telegram setup required");
        return {
          content: [{ type: "text", text: "Not connected. Open your Telegram MCP cabinet to connect Telegram." }],
        };
      }
      return supervisor.call(id, name, args, options);
    },
    consentBinding: (id) => {
      const user = id ? active(id) : undefined;
      return user ? `${user.id}:${user.policy.version}` : "inactive";
    },
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
      return `${user.policy.profile === "read" ? "Только чтение" : "Чтение и изменение"} Telegram. ${user.policy.chatIds.length ? `Разрешённые чаты: ${user.policy.chatIds.join(", ")}` : "Все чаты аккаунта"}.`;
    },
  };
}
