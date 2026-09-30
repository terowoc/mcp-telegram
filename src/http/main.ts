import "dotenv/config";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { IpcClient } from "../client.js";
import { tryAcquireLock } from "../lock.js";
import { type OwnerHandle, startOwner } from "../master.js";
import { TelegramService } from "../telegram-client.js";
import { createHttpGateway } from "./gateway.js";

console.log = (...args: unknown[]) => console.error(...args);

async function main() {
  const apiId = Number(process.env.TELEGRAM_API_ID);
  const apiHash = process.env.TELEGRAM_API_HASH;
  const publicUrl = process.env.MCP_PUBLIC_URL;
  const storageDir = process.env.MCP_AUTH_DIR;
  const passwordFile = process.env.MCP_OWNER_PASSWORD_HASH_FILE;
  if (!Number.isSafeInteger(apiId) || apiId <= 0 || !apiHash || !publicUrl || !storageDir || !passwordFile)
    throw new Error(
      "HTTP mode requires Telegram credentials, MCP_PUBLIC_URL, MCP_AUTH_DIR and MCP_OWNER_PASSWORD_HASH_FILE",
    );
  const ownerPasswordHash = (await readFile(passwordFile, "utf8")).trim();
  if (!/^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(ownerPasswordHash))
    throw new Error("Invalid owner password hash file");
  const { version } = createRequire(import.meta.url)("../../package.json") as { version: string };
  const ipc = new IpcClient();
  let owner: OwnerHandle | undefined;
  // Validate and open auth storage before starting Telegram. Startup failure must not
  // strand a Telegram owner without a gateway.
  const gateway = await createHttpGateway({
    publicUrl,
    storageDir,
    ownerPasswordHash,
    version,
    allowedOrigins: (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    trustProxy: 1,
    isHealthy: () => ipc.isConnected() && owner?.executor.isSettling() === false,
    callTool: (name, args, callOptions) => ipc.call(name, args, callOptions),
  });
  if (!tryAcquireLock()) {
    await gateway.close();
    throw new Error("Another Telegram owner already holds the lock");
  }
  const telegram = new TelegramService(apiId, apiHash);
  owner = await startOwner(telegram, version, { label: "http" });
  if (!(await ipc.connect())) throw new Error("Unable to connect HTTP gateway to Telegram owner");
  ipc.setOnDisconnect(() => {
    console.error("[http] Owner disconnected");
    process.exit(1);
  });
  const port = Number(process.env.MCP_HTTP_PORT ?? "3000");
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("Invalid MCP_HTTP_PORT");
  const listener = gateway.app.listen(port, "0.0.0.0");
  listener.on("error", (error) => {
    console.error("[http] Listen failed:", error.message);
    process.exit(1);
  });
  owner.beforeShutdown = async () => {
    listener.close();
    ipc.destroy();
    await gateway.close();
  };
  console.error(`[http] Gateway listening on port ${port}`);
}

main().catch((error) => {
  console.error("[http] Startup failed:", error instanceof Error ? error.message : "unknown error");
  process.exit(1);
});
