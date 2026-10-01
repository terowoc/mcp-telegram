import { stat } from "node:fs/promises";
import { z } from "zod";
import { mediaPolicy } from "../file-policy.js";
import { MEDIA_ID_PATTERN, mediaUploadStore } from "../media-upload.js";
import { importMediaUrl } from "../media-url.js";
import { ABSOLUTE_PATH_ERROR, isSafeAbsolutePath } from "./shared.js";

export const mediaSourceSchema = {
  filePath: z
    .string()
    .min(1)
    .refine(isSafeAbsolutePath, ABSOLUTE_PATH_ERROR)
    .optional()
    .describe(
      "Absolute path on the MCP server, not the AI sandbox. For AI-created files upload bytes with telegram-upload-media and use fileId, or provide fileUrl.",
    ),
  fileId: z
    .string()
    .regex(MEDIA_ID_PATTERN)
    .optional()
    .describe("Completed fileId returned by telegram-upload-media, valid for one hour in this account"),
  fileUrl: z
    .string()
    .url()
    .max(8192)
    .optional()
    .describe("Direct downloadable public HTTPS URL (including signed URLs); sandbox: and local paths are not URLs"),
  fileName: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Original filename with extension for URL downloads or local documents; uploaded fileId already preserves its filename",
    ),
};
export type MediaSource = { filePath?: string; fileId?: string; fileUrl?: string; fileName?: string };
export async function resolveMediaSource(source: MediaSource): Promise<string> {
  if ([source.filePath, source.fileId, source.fileUrl].filter((value) => value !== undefined).length !== 1)
    throw new Error(
      "Provide exactly one media source: filePath on the MCP server, fileId from telegram-upload-media, or a downloadable HTTPS fileUrl",
    );
  if (source.fileId) return mediaUploadStore().resolve(source.fileId);
  if (source.fileUrl) {
    const store = mediaUploadStore();
    const file = await importMediaUrl(source.fileUrl, source.fileName, store);
    return store.resolve(file.fileId);
  }
  try {
    const path = await mediaPolicy().upload(source.filePath as string);
    if (!(await stat(path)).isFile()) throw new Error("Media source must be a regular file");
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(
        "File does not exist on the MCP server. AI sandbox paths are not shared: use telegram-upload-media to transfer bytes, or provide a downloadable HTTPS fileUrl.",
      );
    throw error;
  }
}
