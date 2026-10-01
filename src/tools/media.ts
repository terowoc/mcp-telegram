import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MEDIA_CHUNK_BYTES, MEDIA_ID_PATTERN, mediaUploadStore } from "../media-upload.js";
import { importMediaUrl } from "../media-url.js";
import type { TelegramService } from "../telegram-client.js";
import { mediaSourceSchema, resolveMediaSource } from "./media-source.js";
import { fail, ok, READ_ONLY, requireConnection, sanitize, WRITE } from "./shared.js";

export function registerMediaTools(server: McpServer, telegram: TelegramService) {
  server.registerTool(
    "telegram-upload-media",
    {
      description:
        "Transfer an AI-created photo, video, document or audio file to this MCP server. Provide fileUrl for a direct public HTTPS download, or base64 data (at most 512 KiB of decoded bytes per call). " +
        "For chunked uploads: first call includes fileName, data and final=false; continue with returned fileId, offset=receivedBytes and data; last call uses final=true. " +
        "Only send a fileId when ready=true. Handles are private to this account and expire after one hour. Do not pass AI sandbox paths as filePath and do not invent file bytes.",
      inputSchema: {
        fileName: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Original basename with extension; required for the first byte chunk"),
        data: z
          .string()
          .max(Math.ceil(MEDIA_CHUNK_BYTES / 3) * 4)
          .optional()
          .describe("Standard base64 encoding of actual file bytes; max 512 KiB decoded per call"),
        fileUrl: mediaSourceSchema.fileUrl,
        fileId: z
          .string()
          .regex(MEDIA_ID_PATTERN)
          .optional()
          .describe("Handle from the first chunk; omit when starting an upload"),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Byte offset for this chunk; use receivedBytes from the previous response, first chunk is zero"),
        final: z
          .boolean()
          .default(true)
          .describe("false while more chunks remain; true for a complete file or final chunk"),
      },
      outputSchema: {
        fileId: z.string(),
        fileName: z.string(),
        receivedBytes: z.number(),
        ready: z.boolean(),
        expiresAt: z.number(),
      },
      annotations: WRITE,
    },
    async ({ fileName, data, fileUrl, fileId, offset, final }) => {
      try {
        if ((data !== undefined) === (fileUrl !== undefined))
          throw new Error("Provide exactly one of base64 data or fileUrl");
        if (fileUrl && (fileId !== undefined || offset !== undefined || !final))
          throw new Error("URL uploads cannot include chunk fileId, offset or final=false");
        const store = mediaUploadStore();
        const result = fileUrl
          ? await importMediaUrl(fileUrl, fileName, store)
          : await store.upload({ fileName, data: data as string, fileId, offset, final });
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], structuredContent: result };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "telegram-send-file",
    {
      description:
        "Send a photo, video, document or audio file to Telegram. Provide a completed fileId from telegram-upload-media, a downloadable HTTPS fileUrl, or a filePath that exists on the MCP server. mediaType=auto detects photos/videos from their extension; document preserves the attachment bytes.",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        ...mediaSourceSchema,
        mediaType: z
          .enum(["auto", "document"])
          .optional()
          .describe("auto detects photo/video/audio by filename; document sends the original file as an attachment"),
        caption: z.string().optional().describe("File caption"),
        replyTo: z.number().int().positive().optional().describe("Message ID to reply to"),
        topicId: z.number().int().positive().optional().describe("Forum topic ID"),
        parseMode: z.enum(["md", "html"]).optional().describe("Caption format"),
      },
      annotations: WRITE,
    },
    async ({ chatId, filePath, fileId, fileUrl, fileName, mediaType, caption, replyTo, topicId, parseMode }) => {
      const err = await requireConnection(telegram);
      if (err) return fail(new Error(err));

      try {
        const path = await resolveMediaSource({ filePath, fileId, fileUrl, fileName });
        await telegram.sendFile(chatId, path, caption, {
          fileName: filePath ? fileName : undefined,
          mediaType,
          replyTo,
          topicId,
          parseMode,
        });
        return ok(`File sent to ${chatId}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "telegram-download-media",
    {
      description: "Download media from a Telegram message to a local file",
      inputSchema: {
        chatId: z.string().describe("Chat ID or username"),
        messageId: z.number().describe("Message ID containing media"),
        downloadPath: z.string().describe("Absolute path to save file"),
      },
      annotations: WRITE,
    },
    async ({ chatId, messageId, downloadPath }) => {
      const err = await requireConnection(telegram);
      if (err) return fail(new Error(err));

      try {
        const path = await telegram.downloadMedia(chatId, messageId, downloadPath);
        return ok(`Media downloaded to ${path}`);
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "telegram-get-profile-photo",
    {
      description:
        "Download profile photo of a Telegram user, group, or channel. Returns inline image or saves to file",
      inputSchema: {
        entityId: z.string().describe("User/Chat/Channel ID or username"),
        savePath: z.string().optional().describe("Absolute path to save file. If omitted, returns inline base64 image"),
        size: z
          .enum(["small", "big"])
          .optional()
          .describe("Photo size: 'small' (160x160) or 'big' (640x640). Default: big"),
      },
      annotations: WRITE,
    },
    async ({ entityId, savePath, size }) => {
      const err = await requireConnection(telegram);
      if (err) return fail(new Error(err));

      try {
        const result = await telegram.downloadProfilePhoto(entityId, {
          isBig: size !== "small",
          savePath,
        });

        if (!result) {
          return ok("No profile photo found");
        }

        if ("filePath" in result) {
          return ok(`Downloaded to: ${result.filePath}`);
        }

        return {
          content: [
            { type: "image" as const, data: result.buffer.toString("base64"), mimeType: result.mimeType },
            {
              type: "text" as const,
              text: `Profile photo (${(result.buffer.length / 1024).toFixed(0)} KB, ${result.mimeType})`,
            },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    },
  );

  server.registerTool(
    "telegram-get-web-preview",
    {
      description: "Fetch Telegram's web-page preview metadata (type, title, description, site name) for a URL",
      inputSchema: {
        url: z
          .string()
          .url()
          .refine((u) => {
            try {
              const p = new URL(u);
              if (p.protocol !== "http:" && p.protocol !== "https:") return false;
              const host = p.hostname
                .toLowerCase()
                .replace(/^\[|\]$/g, "")
                .replace(/\.$/, "");
              if (
                host === "localhost" ||
                // Trailing-dot and subdomain forms of localhost (e.g. "localhost.", "foo.localhost")
                host.endsWith(".localhost") ||
                // Unspecified: 0.0.0.0/8
                /^0\./.test(host) ||
                // IPv4 loopback
                /^127\./.test(host) ||
                // IPv6 loopback and unspecified address
                host === "::1" ||
                host === "::" ||
                // Link-local (AWS metadata, etc.)
                /^169\.254\./.test(host) ||
                // RFC1918 private ranges
                /^10\./.test(host) ||
                /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
                /^192\.168\./.test(host) ||
                // IETF Protocol Assignments: 192.0.0.0/24
                /^192\.0\.0\./.test(host) ||
                // Documentation ranges (TEST-NET-1/2/3, RFC 5737): 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24
                /^192\.0\.2\./.test(host) ||
                /^198\.51\.100\./.test(host) ||
                /^203\.0\.113\./.test(host) ||
                // CGNAT (RFC 6598): 100.64.0.0/10
                /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host) ||
                // Benchmark testing (RFC 2544): 198.18.0.0/15
                /^198\.1[89]\./.test(host) ||
                // IPv4 multicast: 224.0.0.0/4
                /^2(2[4-9]|3\d)\./.test(host) ||
                // Reserved (future use): 240.0.0.0/4 and broadcast
                /^(24[0-9]|25[0-5])\./.test(host)
              ) {
                return false;
              }
              // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1 or Node-normalized ::ffff:7f00:1)
              if (/^::ffff:/i.test(host)) {
                let v4 = host.replace(/^::ffff:/i, "");
                // Node.js normalizes ::ffff:a.b.c.d to ::ffff:XXYY:ZZWW (hex pairs).
                // Convert hex-pair form back to dotted decimal before range checks.
                const hexPair = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(v4);
                if (hexPair) {
                  const hi = hexPair[1].padStart(4, "0");
                  const lo = hexPair[2].padStart(4, "0");
                  v4 = [
                    parseInt(hi.slice(0, 2), 16),
                    parseInt(hi.slice(2, 4), 16),
                    parseInt(lo.slice(0, 2), 16),
                    parseInt(lo.slice(2, 4), 16),
                  ].join(".");
                }
                if (
                  /^0\./.test(v4) ||
                  /^127\./.test(v4) ||
                  /^10\./.test(v4) ||
                  /^172\.(1[6-9]|2\d|3[01])\./.test(v4) ||
                  /^192\.168\./.test(v4) ||
                  /^192\.0\.0\./.test(v4) ||
                  /^192\.0\.2\./.test(v4) ||
                  /^198\.51\.100\./.test(v4) ||
                  /^203\.0\.113\./.test(v4) ||
                  /^169\.254\./.test(v4) ||
                  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(v4) ||
                  /^198\.1[89]\./.test(v4) ||
                  /^2(2[4-9]|3\d)\./.test(v4) ||
                  /^(24[0-9]|25[0-5])\./.test(v4)
                ) {
                  return false;
                }
              }
              // Private IPv6: ULA fc00::/7, link-local fe80::/10, multicast ff00::/8, documentation 2001:db8::/32
              if (
                /^f[cd][0-9a-f]/i.test(host) ||
                /^fe[89ab][0-9a-f]/i.test(host) ||
                /^ff[0-9a-f]{2}/i.test(host) ||
                /^2001:0?db8:/i.test(host)
              ) {
                return false;
              }
              return true;
            } catch {
              return false;
            }
          }, "Only http:// and https:// URLs are allowed; literal loopback, private, link-local, and reserved IP addresses are blocked (DNS-backed hostnames that resolve to private ranges are not checked)")
          .describe("URL to preview (http:// or https://; literal private/loopback/reserved IPs rejected)"),
      },
      annotations: READ_ONLY,
    },
    async ({ url }) => {
      const err = await requireConnection(telegram);
      if (err) return fail(new Error(err));

      try {
        const preview = await telegram.getWebPreview(url);
        if (!preview) return ok("No preview available");
        const lines = [`type: ${preview.type}`];
        if (preview.url) lines.push(`url: ${preview.url}`);
        if (preview.siteName) lines.push(`site: ${sanitize(preview.siteName)}`);
        if (preview.title) lines.push(`title: ${sanitize(preview.title)}`);
        if (preview.description) lines.push(`description: ${sanitize(preview.description)}`);
        return ok(lines.join("\n"));
      } catch (e) {
        return fail(e);
      }
    },
  );
}
