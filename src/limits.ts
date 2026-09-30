import { z } from "zod";

export const MAX_TOOL_RESULT_BYTES = 2 * 1048576 - 1024;

/** Consistent, bounded page size for history, search, dialogs and members. */
export function pageLimit(defaultValue: number, maximum = 100) {
  return z.number().int().min(1).max(maximum).default(defaultValue);
}
