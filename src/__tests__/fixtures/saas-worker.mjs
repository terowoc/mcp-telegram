// Use the real source worker with local telegram-status only: no Telegram network or secrets.
const { tsImport } = await import("tsx/esm/api");
await tsImport("../../../src/saas/worker.ts", import.meta.url);
