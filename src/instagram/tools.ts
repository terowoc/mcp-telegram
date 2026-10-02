import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { externalId } from "./types.js";

const selector = {
  instagramAccountId: z
    .uuid()
    .describe("Private connection UUID from instagram-list-accounts; always select explicitly."),
};
export const instagramTools = [
  {
    name: "instagram-list-accounts",
    description:
      "List your Instagram accounts and access. Use the returned account UUID explicitly for Instagram calls.",
    schema: z.strictObject({}),
    read: true,
  },
  {
    name: "instagram-status",
    description: "Read local Instagram connection status without contacting Instagram.",
    schema: z.strictObject(selector),
    read: true,
  },
  {
    name: "instagram-list-chats",
    description: "List allowed Instagram DM threads. Use thread IDs directly. Reading does not mark messages seen.",
    schema: z.strictObject({
      ...selector,
      limit: z.number().int().min(1).max(20).default(20),
      cursor: z.string().max(2048).optional(),
    }),
    read: true,
  },
  {
    name: "instagram-read-messages",
    description:
      "Read up to 50 recent messages from an allowed Instagram thread without marking it seen. Historical pagination and attachment downloading are unavailable.",
    schema: z.strictObject({ ...selector, threadId: externalId, limit: z.number().int().min(1).max(50).default(20) }),
    read: true,
  },
  {
    name: "instagram-send-message",
    description:
      "Send a text reply to an existing Instagram thread. Generate a unique UUID requestId for each intended send. Reuse that exact key and payload only to check an uncertain outcome; deduplication lasts 24 hours. On delivery-unknown, do not repeat automatically with a new key.",
    schema: z.strictObject({
      ...selector,
      threadId: externalId,
      text: z.string().refine((v) => [...v].length >= 1 && [...v].length <= 1000),
      requestId: z.uuid(),
    }),
    read: false,
  },
];
export function registerInstagramTools(server: McpServer, visible: (name: string, read: boolean) => boolean): void {
  for (const t of instagramTools)
    if (visible(t.name, t.read))
      server.registerTool(
        t.name,
        {
          description: t.description,
          inputSchema: t.schema,
          annotations: { readOnlyHint: t.read, destructiveHint: !t.read, idempotentHint: t.read, openWorldHint: true },
        },
        async () => {
          throw new Error("Hosted Instagram proxy is not configured");
        },
      );
}
export function parseInstagramTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const t = instagramTools.find((t) => t.name === name);
  if (!t) throw new Error("Instagram tool unavailable");
  return t.schema.parse(args);
}
