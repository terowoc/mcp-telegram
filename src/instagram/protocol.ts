import { z } from "zod";
import { externalId } from "./types.js";

const base = { generation: z.uuid() };
const account = z.strictObject({ id: externalId, username: z.string().max(64).optional() });
const loginDiagnostic = z.strictObject({
  phase: z.enum(["authentication", "account-validation"]),
  reason: z.enum(["please-wait", "throttled", "action-blocked", "credentials", "two-factor", "other"]),
  step: z.enum(["device", "authentication", "feed", "account", "other"]),
  httpStatus: z.number().int().min(100).max(599).optional(),
});
export const childFrame = z.discriminatedUnion("kind", [
  z.strictObject({ ...base, kind: z.literal("ready"), error: z.string().max(64).optional() }),
  z.strictObject({
    ...base,
    kind: z.literal("result"),
    id: z.uuid(),
    result: z.unknown().optional(),
    error: z.string().max(64).optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("session"),
    account,
    session: z.record(z.string(), z.unknown()),
    attemptId: z.uuid().optional(),
  }),
  z.strictObject({
    ...base,
    kind: z.literal("event"),
    attemptId: z.uuid(),
    state: z.enum(["needs-code", "needs-verification", "connected", "failed"]),
    error: z.string().max(64).optional(),
    diagnostic: loginDiagnostic.optional(),
  }),
]);
export type ChildFrame = z.infer<typeof childFrame>;
export const safeCodes = new Set([
  "needs-login",
  "needs-verification",
  "needs-code",
  "invalid-code",
  "login-failed",
  "identity-mismatch",
  "rate-limited",
  "capacity",
  "not-found",
  "permission-denied",
  "worker-unavailable",
  "invalid-request",
  "invalid-cursor",
  "output-too-large",
  "account-already-added",
]);
export function safeCode(value?: string): string {
  return value && safeCodes.has(value) ? value : "worker-unavailable";
}
