import type { McpRegisteredTool, McpServerInternal } from "./ipc-protocol.js";

const ADMIN = new Set(["telegram-status", "telegram-login", "telegram-logout", "telegram-doctor"]);
const ENUMERATION = new Set(["telegram-list-chats", "telegram-get-unread", "telegram-inbox"]);
// Explicit scope contracts: new tools stay unavailable under a chat allowlist until reviewed.
const SCOPED = new Set([
  "telegram-read-messages",
  "telegram-search-messages",
  "telegram-get-chat-info",
  "telegram-get-chat-members",
  "telegram-send-message",
  "telegram-edit-message",
  "telegram-forward-message",
  "telegram-download-media",
  "telegram-send-file",
  "telegram-send-voice",
  "telegram-send-video-note",
  "telegram-send-contact",
  "telegram-send-location",
  "telegram-send-venue",
  "telegram-send-album",
  "telegram-send-dice",
  "telegram-pin-message",
  "telegram-unpin-message",
  "telegram-mark-as-read",
  "telegram-get-message-link",
  "telegram-get-message-buttons",
  "telegram-prepare-message",
]);
const CURATED = new Set([
  ...ADMIN,
  ...ENUMERATION,
  "telegram-get-chat-info",
  "telegram-read-messages",
  "telegram-search-messages",
  "telegram-send-message",
  "telegram-prepare-message",
]);

export class ToolPolicy {
  readonly profile: "full" | "read" | "curated";
  private chats: Set<string>;
  constructor(options: { profile?: string; chatIds?: string[] } = {}) {
    const profile = options.profile ?? process.env.MCP_TOOL_PROFILE ?? "full";
    if (!["full", "read", "curated"].includes(profile)) throw new Error("Invalid MCP tool profile");
    this.profile = profile as typeof this.profile;
    const chatIds =
      options.chatIds ??
      (process.env.MCP_ALLOWED_CHAT_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
    if (chatIds.some((id) => !/^-?[1-9]\d{0,19}$/.test(id)))
      throw new Error("Chat allowlist requires canonical numeric peer IDs");
    this.chats = new Set(chatIds);
  }
  hasChatRestriction(): boolean {
    return this.chats.size > 0;
  }
  allowsChat(id: string): boolean {
    return !this.hasChatRestriction() || this.chats.has(id);
  }
  visible(name: string, tool: McpRegisteredTool): boolean {
    if (this.profile === "read" && tool.annotations?.readOnlyHint !== true) return false;
    if (this.profile === "curated" && !CURATED.has(name)) return false;
    return !this.hasChatRestriction() || ADMIN.has(name) || ENUMERATION.has(name) || SCOPED.has(name);
  }
  async authorize(
    name: string,
    args: Record<string, unknown>,
    resolve: (id: string) => Promise<string>,
  ): Promise<Record<string, unknown>> {
    if (!this.hasChatRestriction() || ADMIN.has(name) || ENUMERATION.has(name)) return args;
    if (!SCOPED.has(name)) throw new Error("Tool is unavailable under the chat scope policy");
    const fields = name === "telegram-forward-message" ? ["fromChatId", "toChatId"] : ["chatId"];
    const canonical = { ...args };
    for (const field of fields) {
      if (typeof args[field] !== "string") throw new Error("Tool requires an explicit chat scope");
      let id: string;
      try {
        id = await resolve(args[field]);
      } catch {
        throw new Error("Unable to resolve an allowed chat");
      }
      if (!this.chats.has(id)) throw new Error("Chat is not allowed by server policy");
      canonical[field] = id;
    }
    return canonical;
  }
}

export function applyToolProfile(server: McpServerInternal, policy = new ToolPolicy()): void {
  for (const [name, tool] of Object.entries(server._registeredTools)) tool.enabled = policy.visible(name, tool);
}
