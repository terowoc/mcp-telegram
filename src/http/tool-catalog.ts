import { McpServer, type RegisteredTool } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getObjectShape, objectFromShape } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { registerInstagramTools } from "../instagram/tools.js";
import type { McpRegisteredTool } from "../ipc-protocol.js";
import type { TelegramService } from "../telegram-client.js";
import type { ToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";
import { ACCOUNT_LIST_TOOL, accountListDefinition, accountSelector } from "./account-tools.js";
import { DIRECT_UPLOAD_TOOL, directUploadDefinition } from "./direct-media-upload.js";

// Build immutable schemas once; SDK registries, callbacks and transports stay request-local.
const template = new McpServer({ name: "hosted-tool-catalog", version: "1" });
registerTools(template, {} as TelegramService);
const catalog = Object.entries(
  (template as unknown as { _registeredTools: Record<string, RegisteredTool> })._registeredTools,
).map(([name, tool]) => ({ name, tool }));
void template.close();

export function registerHostedTools(
  server: McpServer,
  policy: ToolPolicy,
  enableDirectUploads = false,
  enableAccounts = false,
  enableInstagram = false,
): void {
  for (const { name, tool } of catalog) {
    if (!policy.visible(name, tool as unknown as McpRegisteredTool)) continue;
    server.registerTool(
      name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema:
          enableAccounts && tool.inputSchema
            ? objectFromShape({ ...getObjectShape(tool.inputSchema), ...accountSelector })
            : tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations ? { ...tool.annotations } : undefined,
        _meta: tool._meta ? { ...tool._meta } : undefined,
      },
      async () => {
        throw new Error("Hosted tool proxy is not configured");
      },
    );
  }
  if (enableDirectUploads && policy.visible(DIRECT_UPLOAD_TOOL, directUploadDefinition as unknown as McpRegisteredTool))
    server.registerTool(
      DIRECT_UPLOAD_TOOL,
      {
        ...directUploadDefinition,
        inputSchema: { ...directUploadDefinition.inputSchema, ...(enableAccounts ? accountSelector : {}) },
      },
      async () => {
        throw new Error("Hosted upload link proxy is not configured");
      },
    );
  if (enableAccounts)
    server.registerTool(ACCOUNT_LIST_TOOL, accountListDefinition, async () => {
      throw new Error("Hosted account list proxy is not configured");
    });
  if (enableInstagram)
    registerInstagramTools(server, (name, read) =>
      policy.visible(name, { annotations: { readOnlyHint: read } } as McpRegisteredTool),
    );
}

export function hostedToolVisible(policy: ToolPolicy, name: string): boolean {
  const tool = name === DIRECT_UPLOAD_TOOL ? directUploadDefinition : catalog.find((item) => item.name === name)?.tool;
  return !!tool && policy.visible(name, tool as unknown as McpRegisteredTool);
}
