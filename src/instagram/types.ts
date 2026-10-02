import { z } from "zod";

export const externalId = z.string().regex(/^[1-9]\d{0,63}$/);
export const policySchema = z.strictObject({
  profile: z.enum(["read", "full"]),
  threadIds: z.array(externalId).max(100),
});
export type InstagramAccess = z.infer<typeof policySchema>;
export interface InstagramConnection {
  id: string;
  ownerId: string;
  label: string;
  generation: string;
  account?: { id: string; username?: string };
  envelope?: string;
  policy: InstagramAccess;
  policyVersion: number;
  removalPending: boolean;
  cooldownUntil: number;
}
export class InstagramError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export const TOOL_NAMES = [
  "instagram-list-accounts",
  "instagram-status",
  "instagram-list-chats",
  "instagram-read-messages",
  "instagram-send-message",
] as const;
export const SESSION_KEYS = new Set([
  "uuids",
  "mid",
  "ig_u_rur",
  "ig_www_claim",
  "authorization_data",
  "cookies",
  "last_login",
  "device_settings",
  "user_agent",
  "country",
  "country_code",
  "locale",
  "timezone_offset",
  "timezone_name",
  "push_disabled",
  "usdid",
]);
export function sessionState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InstagramError("invalid-session");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((k) => !SESSION_KEYS.has(k)) || Buffer.byteLength(JSON.stringify(result)) > 65536)
    throw new InstagramError("invalid-session");
  if (!result.authorization_data || !result.uuids) throw new InstagramError("invalid-session");
  return result;
}
