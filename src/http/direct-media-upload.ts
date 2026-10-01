import { createHash, type Hash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { McpRegisteredTool } from "../ipc-protocol.js";
import { MEDIA_CHUNK_BYTES, validateMediaName } from "../media-upload.js";
import { WRITE } from "../tools/shared.js";
import type { GatewayIdentity } from "./identity.js";

export const DIRECT_UPLOAD_TOOL = "telegram-create-media-upload";
const TTL_MS = 5 * 60000;
export const DIRECT_UPLOAD_MAX_BYTES = 20 * 1048576;
const PATH_PREFIX = "/media/uploads/";
export const directUploadPath = (path: string) => /^\/media\/uploads\/[a-f0-9-]{36}$/.test(path);
export const directUploadSchema = z.object({
  telegramAccountId: z
    .string()
    .uuid()
    .optional()
    .describe("Connection ID from telegram-list-accounts; omit for primary"),
  fileName: z.string().min(1).max(200).describe("Original basename with extension"),
  sizeBytes: z
    .number()
    .int()
    .positive()
    .max(DIRECT_UPLOAD_MAX_BYTES)
    .describe("Exact byte size computed by code reading the file"),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .describe("SHA-256 of the actual file bytes, computed by code"),
});
export const directUploadDefinition = {
  description:
    "Create a private short-lived HTTPS upload link for a file accessible to client-side code execution. Prefer this for Claude-created files: use Python to compute filename, byte size and SHA-256, call this tool, then use Python to PUT the ORIGINAL BINARY BYTES to uploadUrl. No base64 must be copied through the model. The client needs network access to this server's domain. Parse the upload response and send its fileId with telegram-send-file. Do not pass sandbox paths to a server filePath parameter. Uploading never sends a Telegram message.",
  inputSchema: directUploadSchema.shape,
  outputSchema: {
    uploadUrl: z.string(),
    method: z.literal("PUT"),
    headers: z.object({ Authorization: z.string(), "Content-Type": z.literal("application/octet-stream") }),
    expiresAt: z.number(),
    maxBytes: z.number(),
    maxChunkBytes: z.number(),
    instructions: z.string(),
    pythonCode: z.string(),
  },
  annotations: WRITE,
};
type MediaResult = { fileId: string; fileName: string; receivedBytes: number; ready: boolean; expiresAt: number };
type Ticket = z.infer<typeof directUploadSchema> & {
  accountId: string;
  grantId: string;
  expiresAt: number;
  tokenHash: Buffer;
  hash: Hash;
  receivedBytes: number;
  lastChunk?: { offset: number; digest: string; result: MediaResult };
  state: "pending" | "uploading" | "complete" | "failed";
  result?: MediaResult;
};

/** Capability URLs transfer binary data without passing file contents through model output. */
export class DirectMediaUploads {
  private tickets = new Map<string, Ticket>();
  private active = new Map<string, AbortController>();
  private closed = false;
  private now: () => number;
  constructor(
    private options: {
      origin: string;
      identity: GatewayIdentity;
      now?: () => number;
      validateGrant?: (grantId: string) => Promise<boolean>;
    },
  ) {
    this.now = options.now ?? Date.now;
  }
  private prune() {
    for (const [token, ticket] of this.tickets)
      if (ticket.expiresAt <= this.now() && ticket.state !== "uploading") this.tickets.delete(token);
  }
  private async allowed(accountId: string, grantId: string, selected?: string) {
    const { identity } = this.options;
    if (
      this.closed ||
      !identity.isActive(accountId) ||
      !identity.isGrantValid(accountId, grantId) ||
      !identity
        .toolPolicy(accountId, selected ?? accountId)
        .visible(DIRECT_UPLOAD_TOOL, directUploadDefinition as unknown as McpRegisteredTool) ||
      (this.options.validateGrant && !(await this.options.validateGrant(grantId)))
    )
      throw new Error("Media upload access revoked or unavailable");
  }
  async create(accountId: string, grantId: string, input: unknown) {
    const args = directUploadSchema.parse(input);
    await this.allowed(accountId, grantId, args.telegramAccountId);
    validateMediaName(args.fileName);
    this.prune();
    if (
      this.tickets.size >= 100 ||
      [...this.tickets.values()].filter(
        (ticket) => ticket.accountId === accountId && (ticket.state === "pending" || ticket.state === "uploading"),
      ).length >= 5
    )
      throw new Error("Media upload link limit reached; wait for links to expire");
    const token = randomBytes(32).toString("base64url");
    const uploadId = randomUUID();
    const expiresAt = this.now() + TTL_MS;
    this.tickets.set(uploadId, {
      ...args,
      accountId,
      grantId,
      expiresAt,
      tokenHash: createHash("sha256").update(token).digest(),
      state: "pending",
      hash: createHash("sha256"),
      receivedBytes: 0,
    });
    return {
      uploadUrl: `${this.options.origin}${PATH_PREFIX}${uploadId}`,
      method: "PUT" as const,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" as const },
      expiresAt,
      maxBytes: DIRECT_UPLOAD_MAX_BYTES,
      maxChunkBytes: MEDIA_CHUNK_BYTES,
      pythonCode: uploadPythonCode(`${this.options.origin}${PATH_PREFIX}${uploadId}`, `Bearer ${token}`),
      instructions:
        "Use code execution to read the file and PUT original binary chunks of at most maxChunkBytes to uploadUrl with the returned headers and Upload-Offset equal to receivedBytes (first is zero). Parse each response before advancing. Only send the fileId after ready=true; the final chunk verifies the total size and SHA-256. Print only the JSON response, never base64. Use its completed fileId with the Telegram send tool and the SAME telegramAccountId used to create this link (omit only for primary). GET uploadUrl with the same Authorization header retrieves status if the PUT response is lost. Allow network access to this server's domain if needed. This upload authorization expires in five minutes and permits one upload.",
    };
  }
  mount(app: Express) {
    app.all(
      `${PATH_PREFIX}:token`,
      rateLimit({ windowMs: 60000, limit: 240, standardHeaders: "draft-8", legacyHeaders: false }),
      async (req, res) => {
        if (!directUploadPath(req.path)) {
          res.status(404).json({ error: "Invalid upload link" });
          return;
        }
        this.prune();
        const ticket = this.tickets.get(String(req.params.token));
        if (!ticket || ticket.expiresAt <= this.now()) {
          res.status(410).json({ error: "Upload link expired or unknown; create a new link" });
          return;
        }
        const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!bearer || !timingSafeEqual(createHash("sha256").update(bearer).digest(), ticket.tokenHash)) {
          res.status(401).json({ error: "Upload authorization required" });
          return;
        }
        try {
          await this.allowed(ticket.accountId, ticket.grantId, ticket.telegramAccountId);
        } catch {
          res.status(403).json({ error: "Media upload access revoked" });
          return;
        }
        if (req.method === "GET") {
          res.json({
            state: ticket.state,
            receivedBytes: ticket.receivedBytes,
            ...(ticket.result ? { result: ticket.result } : {}),
          });
          return;
        }
        if (req.method !== "PUT") {
          res.set("Allow", "PUT, GET").status(405).json({ error: "Use PUT to upload original binary file bytes" });
          return;
        }
        if (ticket.state === "uploading" || ticket.state === "failed") {
          res.status(409).json({ error: "Upload link already used; GET this URL for its status" });
          return;
        }
        if (this.active.size >= 4 || this.active.has(ticket.accountId)) {
          res.status(429).json({ error: "Another media upload is running; retry later" });
          return;
        }
        const length = req.headers["content-length"];
        if (
          length !== undefined &&
          (!Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > MEDIA_CHUNK_BYTES)
        ) {
          res.status(400).json({ error: "Invalid binary chunk size" });
          return;
        }
        if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity") {
          res.status(400).json({ error: "Upload original uncompressed binary bytes" });
          return;
        }
        await this.receive(ticket, req, res);
      },
    );
  }
  private async receive(ticket: Ticket, req: Request, res: Response) {
    const rawOffset = req.headers["upload-offset"] ?? "0";
    const offset = typeof rawOffset === "string" && /^(0|[1-9]\d*)$/.test(rawOffset) ? Number(rawOffset) : NaN;
    if (!Number.isSafeInteger(offset) || (offset !== ticket.receivedBytes && offset !== ticket.lastChunk?.offset)) {
      res.status(409).json({ error: "Upload-Offset must equal receivedBytes", receivedBytes: ticket.receivedBytes });
      return;
    }
    const priorState = ticket.state;
    const controller = new AbortController();
    this.active.set(ticket.accountId, controller);
    ticket.state = "uploading";
    const timeout = setTimeout(
      () => controller.abort(new Error("Media upload timed out")),
      Math.min(120000, ticket.expiresAt - this.now()),
    );
    timeout.unref();
    const abort = () => {
      if (!res.writableEnded) controller.abort(new Error("Media upload disconnected"));
    };
    const destroy = () => {
      req.destroy();
    };
    res.on("close", abort);
    controller.signal.addEventListener("abort", destroy, { once: true });
    let staging = false;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        controller.signal.throwIfAborted();
        size += chunk.length;
        if (size > MEDIA_CHUNK_BYTES || offset + size > ticket.sizeBytes)
          throw new Error("Binary chunk exceeds the allowed byte size");
        chunks.push(chunk);
      }
      if (!size) throw new Error("Binary chunk must not be empty");
      const bytes = Buffer.concat(chunks);
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (offset === ticket.lastChunk?.offset) {
        if (digest !== ticket.lastChunk.digest) throw new Error("Chunk retry conflicts with previously uploaded bytes");
        ticket.state = priorState;
        res.json(ticket.lastChunk.result);
        return;
      }
      if (priorState === "complete") throw new Error("Upload is already complete");
      const final = offset + size === ticket.sizeBytes;
      const nextHash = ticket.hash.copy().update(bytes);
      if (final && nextHash.copy().digest("hex") !== ticket.sha256) {
        ticket.state = "failed";
        throw new Error("File SHA-256 does not match upload metadata; no completed file was created");
      }
      controller.signal.throwIfAborted();
      if (ticket.expiresAt <= this.now()) throw new Error("Upload authorization expired");
      await this.allowed(ticket.accountId, ticket.grantId, ticket.telegramAccountId);
      staging = true;
      const response = (await this.options.identity.callTool(
        ticket.accountId,
        "telegram-upload-media",
        {
          ...(ticket.telegramAccountId ? { telegramAccountId: ticket.telegramAccountId } : {}),
          fileName: ticket.result ? undefined : ticket.fileName,
          fileId: ticket.result?.fileId,
          offset,
          data: bytes.toString("base64"),
          final,
        },
        { signal: controller.signal },
      )) as { isError?: boolean; structuredContent?: MediaResult };
      if (response.isError || !response.structuredContent)
        throw new Error("Media staging failed; create a new upload authorization");
      await this.allowed(ticket.accountId, ticket.grantId, ticket.telegramAccountId);
      ticket.hash = nextHash;
      ticket.receivedBytes = offset + size;
      ticket.result = response.structuredContent;
      ticket.lastChunk = { offset, digest, result: response.structuredContent };
      ticket.state = final ? "complete" : "pending";
      res.json(response.structuredContent);
    } catch (error) {
      if (staging) ticket.state = "failed";
      else if (ticket.state !== "failed") ticket.state = priorState;
      if (!res.headersSent && !res.destroyed)
        res.status(400).json({ error: error instanceof Error ? error.message : "Media upload failed" });
    } finally {
      clearTimeout(timeout);
      res.off("close", abort);
      controller.signal.removeEventListener("abort", destroy);
      this.active.delete(ticket.accountId);
    }
  }
  close() {
    this.closed = true;
    for (const controller of this.active.values()) controller.abort(new Error("Media upload service stopping"));
    this.tickets.clear();
  }
}

function uploadPythonCode(url: string, authorization: string): string {
  return `from pathlib import Path
import json, urllib.request

file_path = Path("/replace/with/the/actual/sandbox/file")
upload_url = ${JSON.stringify(url)}
headers = {"Authorization": ${JSON.stringify(authorization)}, "Content-Type": "application/octet-stream"}
offset = 0
result = None
with file_path.open("rb") as source:
    while True:
        chunk = source.read(${MEDIA_CHUNK_BYTES})
        if not chunk:
            break
        request = urllib.request.Request(upload_url, data=chunk, method="PUT", headers={**headers, "Upload-Offset": str(offset)})
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        offset = result["receivedBytes"]
        if result["ready"]:
            break
if not result or not result["ready"]:
    raise RuntimeError("The file did not complete; check its original size and upload status")
print(json.dumps(result))
`;
}
