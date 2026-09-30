import "dotenv/config";
import { IpcClient } from "./client.js";

const ipc = new IpcClient({ callTimeoutMs: 3000 });
try {
  if (!(await ipc.connect())) throw new Error("Telegram owner is not reachable; start the daemon first");
  const result = (await ipc.call("telegram-doctor", {})) as { structuredContent?: unknown };
  process.stdout.write(`${JSON.stringify(result.structuredContent, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : "Doctor failed");
  process.exitCode = 1;
} finally {
  ipc.destroy();
}
