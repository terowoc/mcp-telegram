import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Request, Response } from "express";
import { wireIpcProxies } from "../client.js";
import { DIRECT_UPLOAD_TOOL, type DirectMediaUploads } from "./direct-media-upload.js";
import type { GatewayIdentity } from "./identity.js";
import { registerHostedTools } from "./tool-catalog.js";

export function createMcpHandler(identity: GatewayIdentity, version: string, uploads?: DirectMediaUploads) {
  return async (req: Request, res: Response) => {
    const { accountId, grantId } = res.locals.mcpIdentity as { accountId: string; grantId: string };
    if (Array.isArray(req.body)) {
      res
        .status(400)
        .json({ jsonrpc: "2.0", error: { code: -32600, message: "JSON-RPC batches are not supported" }, id: null });
      return;
    }
    if (typeof req.body?.id === "string" && Buffer.byteLength(req.body.id) > 128) {
      res
        .status(400)
        .json({ jsonrpc: "2.0", error: { code: -32600, message: "Request ID exceeds 128 bytes" }, id: null });
      return;
    }
    const started = performance.now();
    const server = new McpServer({ name: "mcp-telegram", version: version });
    registerHostedTools(server, identity.toolPolicy(accountId), !!uploads, identity.kind === "saas");
    const catalogMs = performance.now() - started;
    wireIpcProxies(server, {
      call: async (name, args, callOptions) => {
        if (!identity.isActive(accountId) || !identity.isGrantValid(accountId, grantId))
          throw new Error("MCP access revoked");
        const result =
          name === DIRECT_UPLOAD_TOOL && uploads
            ? await uploads.create(accountId, grantId, args).then((ticket) => ({
                content: [{ type: "text" as const, text: JSON.stringify(ticket) }],
                structuredContent: ticket,
              }))
            : await identity.callTool(accountId, name, args, callOptions);
        if (!identity.isActive(accountId) || !identity.isGrantValid(accountId, grantId))
          throw new Error("MCP access revoked");
        if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1048576 - 1024)
          throw new Error("Tool response exceeds hosted output limit; use pagination");
        return result;
      },
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const send = transport.send.bind(transport);
    transport.send = async (message, sendOptions) => {
      if (!res.headersSent)
        res.set(
          "Server-Timing",
          `mcp;dur=${(performance.now() - started).toFixed(1)}, catalog;dur=${catalogMs.toFixed(1)}`,
        );
      if (Buffer.byteLength(JSON.stringify(message)) > 2 * 1048576) {
        if ("id" in message) {
          await send(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32000,
                message: "Response exceeds hosted output limit; narrow the request or use pagination",
              },
            },
            sendOptions,
          );
        }
        return;
      }
      await send(message, sendOptions);
    };
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  };
}
