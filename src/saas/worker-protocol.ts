import { z } from "zod";
import type { UserPolicy } from "./types.js";

const id = z.string().min(1).max(128);
const base = { generation: id, id };
const args = z.record(z.string(), z.unknown());
export const workerInitSchema = z.object({
  kind: z.literal("init"),
  generation: id,
  userId: z.uuid(),
  apiId: z.number().int().positive(),
  apiHash: z.string().min(1).max(128),
  fileRoot: z.string().min(1).max(4096),
  policy: z.object({
    profile: z.enum(["read", "full"]),
    chatIds: z.array(z.string().regex(/^-?[1-9]\d{0,19}$/)).max(100),
    version: z.number().int().positive(),
  }),
  session: z.string().max(16384).optional(),
});
export const parentMessageSchema = z.discriminatedUnion("kind", [
  workerInitSchema,
  z.object({ ...base, kind: z.literal("tool"), name: id, args, deadlineAt: z.number().finite().optional() }),
  z.object({ ...base, kind: z.literal("login-start"), attemptId: id }),
  z.object({ ...base, kind: z.literal("login-password"), attemptId: id, password: z.string().min(1).max(1024) }),
  z.object({ ...base, kind: z.literal("cancel") }),
  z.object({ ...base, kind: z.literal("shutdown") }),
  z.object({ ...base, kind: z.literal("ack"), ok: z.boolean() }),
]);
export const loginEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("qr"),
    dataUrl: z.string().startsWith("data:image/png;base64,").max(200000),
    expiresAt: z.number(),
  }),
  z.object({ type: z.literal("needs-password") }),
  z.object({
    type: z.literal("success"),
    account: z.object({ id: z.string().max(40), username: z.string().max(64).optional() }),
  }),
  z.object({ type: z.literal("error"), code: z.enum(["cancelled", "login-failed", "worker-unavailable"]) }),
]);
export const childMessageSchema = z.discriminatedUnion("kind", [
  z.object({ generation: id, kind: z.literal("ready") }),
  z.object({
    ...base,
    kind: z.literal("result"),
    result: z.unknown().optional(),
    error: z.string().max(256).optional(),
    settling: z.boolean().optional(),
    timing: z.object({ connectionMs: z.number().finite().min(0).max(600000), connectionCold: z.boolean() }).optional(),
  }),
  z.object({ ...base, kind: z.literal("settled") }),
  z.object({ ...base, kind: z.literal("event"), attemptId: id, event: loginEventSchema }),
  z.object({ ...base, kind: z.literal("session-save"), session: z.string().min(1).max(16384) }),
  z.object({ ...base, kind: z.literal("session-clear") }),
]);
export type WorkerInit = Omit<z.infer<typeof workerInitSchema>, "kind" | "policy"> & { policy: UserPolicy };
export type ParentMessage = z.infer<typeof parentMessageSchema>;
export type ChildMessage = z.infer<typeof childMessageSchema>;
export type LoginEvent = z.infer<typeof loginEventSchema>;

export function parseFrame<T>(schema: z.ZodType<T>, value: unknown): T {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 4 * 1048576) throw new Error("Worker frame too large");
  return schema.parse(value);
}
