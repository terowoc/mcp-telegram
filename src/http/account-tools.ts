import { z } from "zod";
import { READ_ONLY } from "../tools/shared.js";
export const ACCOUNT_LIST_TOOL = "telegram-list-accounts";
export const accountSelector = {
  telegramAccountId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Connection ID from telegram-list-accounts. Omit for the primary account. Use the SAME ID for upload and send; cabinet selection never changes the default.",
    ),
};
export const accountListDefinition = {
  description:
    "List your connected Telegram accounts, connection IDs, labels and permissions. Use telegramAccountId to choose the sender explicitly on each tool call. Omitting it always uses the primary account.",
  inputSchema: {},
  annotations: READ_ONLY,
};
