import { StringDecoder } from "node:string_decoder";

export const MAX_IPC_FRAME_BYTES = 4 * 1048576;

/** Keeps partial UTF-8 code points across socket chunks and bounds each frame. */
export class IpcDecoder {
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  constructor(private maxBytes = MAX_IPC_FRAME_BYTES) {}
  push(chunk: Buffer | string): IpcMessage[] {
    this.buffer += this.decoder.write(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    for (const line of this.buffer.split("\n")) {
      if (Buffer.byteLength(line) > this.maxBytes) throw new Error("IPC frame exceeds size limit");
    }
    const { messages, remaining } = parseMessages(this.buffer);
    this.buffer = remaining;
    return messages;
  }
}

/** MCP SDK internal tool registry — field name "handler" confirmed in SDK v1.29.0 */
export type McpRegisteredTool = {
  handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;
  inputSchema?: { safeParseAsync: (args: unknown) => Promise<{ success: boolean; data?: unknown }> };
  enabled?: boolean;
};
export interface McpServerInternal {
  _registeredTools: Record<string, McpRegisteredTool>;
}

/** Client → Master: invoke MCP tool */
export interface IpcToolRequest {
  type: "tool";
  id: string;
  tool: string;
  args: Record<string, unknown>;
  deadlineAt?: number;
}

/** Client → Master: cancel an active or queued request. */
export interface IpcCancel {
  type: "cancel";
  id: string;
}

/** Master → Client: tool result */
export interface IpcToolResponse {
  type: "tool_response";
  id: string;
  result?: unknown;
  error?: string;
}

/** Client → Master: begin QR login flow */
export interface IpcLoginStart {
  type: "login_start";
  id: string;
}

/** Master → Client: QR code URL to display (may fire multiple times as URL refreshes) */
export interface IpcLoginQr {
  type: "login_qr";
  id: string;
  url: string;
}

/** Master → Client: QR login finished */
export interface IpcLoginDone {
  type: "login_done";
  id: string;
  success: boolean;
  username?: string;
  error?: string;
}

export type IpcMessage = IpcToolRequest | IpcToolResponse | IpcLoginStart | IpcLoginQr | IpcLoginDone | IpcCancel;

/** Encode a message as newline-delimited JSON */
export function encodeMessage(msg: IpcMessage): string {
  const encoded = JSON.stringify(msg);
  if (Buffer.byteLength(encoded) > MAX_IPC_FRAME_BYTES) throw new Error("IPC frame exceeds size limit");
  return `${encoded}\n`;
}

/** Parse newline-delimited JSON messages from a buffer, returns parsed messages + leftover */
export function parseMessages(buf: string): { messages: IpcMessage[]; remaining: string } {
  const lines = buf.split("\n");
  const remaining = lines.pop() ?? "";
  const messages: IpcMessage[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<IpcMessage>;
      if (isIpcMessage(parsed)) messages.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }
  return { messages, remaining };
}

function isIpcMessage(m: Partial<IpcMessage>): m is IpcMessage {
  if (!m || typeof m !== "object" || typeof m.type !== "string" || typeof m.id !== "string") return false;
  if (Buffer.byteLength(m.id) > 128) return false;
  if (m.type === "tool") {
    return (
      typeof m.tool === "string" &&
      Buffer.byteLength(m.tool) <= 128 &&
      !!m.args &&
      typeof m.args === "object" &&
      !Array.isArray(m.args) &&
      (m.deadlineAt === undefined || (typeof m.deadlineAt === "number" && Number.isFinite(m.deadlineAt)))
    );
  }
  return (
    m.type === "cancel" ||
    m.type === "tool_response" ||
    m.type === "login_start" ||
    m.type === "login_qr" ||
    m.type === "login_done"
  );
}
