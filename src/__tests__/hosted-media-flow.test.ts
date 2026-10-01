import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerInternal } from "../ipc-protocol.js";
import type { TelegramService } from "../telegram-client.js";
import { ToolExecutor } from "../tool-executor.js";
import { applyToolProfile, ToolPolicy } from "../tool-policy.js";
import { registerTools } from "../tools/index.js";

test("AI bytes upload through MCP and send as photo, document, voice, video note and album", async () => {
  const root = await mkdtemp(join(tmpdir(), "tg-mcp-media-"));
  const previous = process.env.MCP_TELEGRAM_FILE_ROOT;
  process.env.MCP_TELEGRAM_FILE_ROOT = root;
  const sent: Array<{ method: string; path: string; options?: unknown }> = [];
  const telegram = {
    ensureConnected: async () => true,
    sendFile: async (_chat: string, path: string, _caption: string, options: unknown) => {
      sent.push({ method: "file", path, options });
    },
    sendVoice: async (_chat: string, path: string) => {
      sent.push({ method: "voice", path });
      return { id: 1 };
    },
    sendVideoNote: async (_chat: string, path: string) => {
      sent.push({ method: "video", path });
      return { id: 2 };
    },
    sendAlbum: async (_chat: string, items: Array<{ filePath: string }>) => {
      for (const item of items) sent.push({ method: "album", path: item.filePath });
      return { ids: [3, 4] };
    },
    setProfilePhoto: async (opts: { filePath: string }) => {
      sent.push({ method: "avatar", path: opts.filePath });
      return { id: "1" };
    },
    sendStory: async (_chat: string, path: string) => {
      sent.push({ method: "story", path });
      return { id: 1, period: 86400 };
    },
    editStory: async (_chat: string, _id: number, opts: { filePath: string }) => {
      sent.push({ method: "edit-story", path: opts.filePath });
      return { changed: ["media"] };
    },
    editGroup: async (_chat: string, opts: { photoPath: string }) => {
      sent.push({ method: "group", path: opts.photoPath });
    },
  } as unknown as TelegramService;
  const server = new McpServer({ name: "media-flow", version: "1" });
  try {
    registerTools(server, telegram);
    const internal = server as unknown as McpServerInternal;
    const policy = new ToolPolicy({ profile: "full", chatIds: ["42"] });
    applyToolProfile(internal, policy);
    const executor = new ToolExecutor({
      tools: internal._registeredTools,
      authorize: (name, args) => policy.authorize(name, args, async (id) => id),
    });
    const result = (await executor.call("telegram-upload-media", {
      fileName: "generated.png",
      data: Buffer.from("AI bytes").toString("base64"),
    })) as { structuredContent: { fileId: string; ready: boolean } };
    assert.equal(result.structuredContent.ready, true);
    const fileId = result.structuredContent.fileId;
    await executor.call("telegram-send-file", { chatId: "42", fileId });
    await executor.call("telegram-send-file", { chatId: "42", fileId, mediaType: "document" });
    await executor.call("telegram-send-voice", { chatId: "42", fileId });
    await executor.call("telegram-send-video-note", { chatId: "42", fileId });
    await executor.call("telegram-send-album", { chatId: "42", items: [{ fileId }, { fileId }] });
    assert.equal(sent.length, 6);
    for (const item of sent) assert.equal(await readFile(item.path, "utf8"), "AI bytes");
    assert.equal(sent[0].path.endsWith("/generated.png"), true);
    assert.equal((sent[1].options as { mediaType: string }).mediaType, "document");
    await assert.rejects(executor.call("telegram-send-file", { chatId: "43", fileId }), /not allowed/);
    const ambiguous = (await executor.call("telegram-send-file", {
      chatId: "42",
      fileId,
      filePath: "/tmp/other.png",
    })) as { isError: boolean };
    assert.equal(ambiguous.isError, true);
    const missing = (await executor.call("telegram-send-file", { chatId: "42", filePath: "/mnt/data/ai.png" })) as {
      isError: boolean;
      content: Array<{ text: string }>;
    };
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /upload-media|fileUrl/);
    applyToolProfile(internal, new ToolPolicy({ profile: "full" }));
    const unrestricted = new ToolExecutor({ tools: internal._registeredTools });
    for (const [name, args] of [
      ["telegram-set-profile-photo", { fileId }],
      ["telegram-send-story", { chatId: "me", fileId }],
      ["telegram-edit-story", { chatId: "me", storyId: 1, fileId }],
      ["telegram-edit-group", { chatId: "42", fileId }],
    ] as const) {
      const response = (await unrestricted.call(name, args)) as { isError?: boolean };
      assert.notEqual(response.isError, true, name);
    }
    assert.equal(sent.length, 10);
    for (const item of sent.slice(6)) assert.equal(await readFile(item.path, "utf8"), "AI bytes");
    applyToolProfile(internal, new ToolPolicy({ profile: "read" }));
    await assert.rejects(executor.call("telegram-upload-media", { fileName: "x", data: "eA==" }), /Unknown/);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.MCP_TELEGRAM_FILE_ROOT;
    else process.env.MCP_TELEGRAM_FILE_ROOT = previous;
    await rm(root, { recursive: true, force: true });
  }
});
