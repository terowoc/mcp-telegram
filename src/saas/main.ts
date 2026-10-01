import type { fork } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import express from "express";
import { createHttpGateway } from "../http/gateway.js";
import { SaasAuth } from "./auth.js";
import { BootstrapContexts } from "./bootstrap-contexts.js";
import { createSaasIdentity } from "./identity.js";
import { OAuthContinuations } from "./oauth-continuations.js";
import { createSaasRoutes } from "./routes.js";
import { loadVaultKey, SessionVault } from "./session-vault.js";
import { mountSaasFrontend } from "./static.js";
import { createSaasStore } from "./store.js";
import { WorkerSupervisor } from "./supervisor.js";
import { TelegramAuthAttempts } from "./telegram-auth-attempts.js";
import { TelegramAuthWorker } from "./telegram-auth-protocol.js";
import { createTelegramAuthRoutes } from "./telegram-auth-routes.js";
import { WorkerBudget } from "./worker-budget.js";

export interface SaasConfig {
  publicUrl: string;
  authDir: string;
  sessionKeyFile: string;
  filesRoot: string;
  apiId: number;
  apiHash: string;
  version: string;
  maxUsers?: number;
  maxWorkers?: number;
  port?: number;
  webRoot?: string;
  allowedOrigins?: string[];
}
function validate(config: SaasConfig): SaasConfig {
  const url = new URL(config.publicUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
    throw new Error("MCP_PUBLIC_URL must be an HTTPS origin");
  for (const path of [config.authDir, config.sessionKeyFile, config.filesRoot])
    if (!isAbsolute(path)) throw new Error("SaaS storage paths must be absolute");
  if (config.webRoot && !isAbsolute(config.webRoot)) throw new Error("Frontend root must be absolute");
  if (!Number.isSafeInteger(config.apiId) || config.apiId < 1 || !/^[a-fA-F0-9]{32}$/.test(config.apiHash))
    throw new Error("Invalid Telegram server credentials");
  if (!Number.isSafeInteger(config.maxUsers ?? 100) || (config.maxUsers ?? 100) < 1 || (config.maxUsers ?? 100) > 10000)
    throw new Error("Invalid SaaS user capacity");
  if (!Number.isSafeInteger(config.maxWorkers ?? 4) || (config.maxWorkers ?? 4) < 1 || (config.maxWorkers ?? 4) > 32)
    throw new Error("Invalid SaaS worker capacity");
  if (!Number.isSafeInteger(config.port ?? 3000) || (config.port ?? 3000) < 1 || (config.port ?? 3000) > 65535)
    throw new Error("Invalid MCP_HTTP_PORT");
  for (const origin of config.allowedOrigins ?? []) {
    const allowed = new URL(origin);
    if (allowed.protocol !== "https:" || allowed.origin !== origin) throw new Error("Invalid MCP allowed origin");
  }
  return config;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SaasConfig {
  if (
    !env.MCP_PUBLIC_URL ||
    !env.MCP_AUTH_DIR ||
    !env.MCP_SESSION_KEY_FILE ||
    !env.MCP_TELEGRAM_FILE_ROOT ||
    !env.TELEGRAM_API_ID ||
    !env.TELEGRAM_API_HASH
  )
    throw new Error(
      "SaaS requires Telegram credentials, MCP_PUBLIC_URL, MCP_AUTH_DIR, MCP_SESSION_KEY_FILE and MCP_TELEGRAM_FILE_ROOT",
    );
  return validate({
    publicUrl: env.MCP_PUBLIC_URL,
    authDir: env.MCP_AUTH_DIR,
    sessionKeyFile: env.MCP_SESSION_KEY_FILE,
    filesRoot: env.MCP_TELEGRAM_FILE_ROOT,
    apiId: Number(env.TELEGRAM_API_ID),
    apiHash: env.TELEGRAM_API_HASH,
    maxUsers: Number(env.MCP_SAAS_MAX_USERS ?? 100),
    maxWorkers: Number(env.MCP_SAAS_MAX_WORKERS ?? 4),
    port: Number(env.MCP_HTTP_PORT ?? 3000),
    webRoot: env.MCP_WEB_ROOT,
    allowedOrigins: env.MCP_ALLOWED_ORIGINS?.split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    version: env.npm_package_version ?? "1.43.1",
  });
}
export async function startSaas(
  config: SaasConfig,
  options: { spawn?: typeof fork; bootstrapSpawn?: typeof fork } = {},
) {
  validate(config);
  const csp = config.webRoot
    ? (await readFile(join(config.webRoot, "index.html"), "utf8")).match(
        /<meta http-equiv="Content-Security-Policy" content="([^"\r\n]+)"/,
      )?.[1]
    : undefined;
  if (config.webRoot && !csp) throw new Error("Frontend build has no CSP metadata");
  const key = await loadVaultKey(config.sessionKeyFile); // fail before any DB or process is opened
  const vault = new SessionVault(key);
  await mkdir(config.filesRoot, { recursive: true, mode: 0o700 });
  const store = createSaasStore(join(config.authDir, "saas.sqlite"), { maxUsers: config.maxUsers });
  const auth = new SaasAuth(store, { csrfKey: createHmac("sha256", key).update("tg-bridge/saas/csrf/v1").digest() });
  const budget = new WorkerBudget(config.maxWorkers ?? 4);
  const supervisor = new WorkerSupervisor({
    budget,
    store,
    vault,
    apiId: config.apiId,
    apiHash: config.apiHash,
    filesRoot: config.filesRoot,
    maxWorkers: config.maxWorkers,
    spawn: options.spawn,
  });
  let closing = false;
  const contexts = new BootstrapContexts({
    csrfKey: createHmac("sha256", key).update("tg-bridge/bootstrap/csrf/v1").digest(),
  });
  const continuations = new OAuthContinuations();
  const loginAttempts = new TelegramAuthAttempts({
    auth,
    store,
    vault,
    createWorker: () =>
      new TelegramAuthWorker({ budget, apiId: config.apiId, apiHash: config.apiHash, spawn: options.bootstrapSpawn }),
  });
  let gateway: Awaited<ReturnType<typeof createHttpGateway>>;
  try {
    gateway = await createHttpGateway({
      publicUrl: config.publicUrl,
      storageDir: join(config.authDir, "oauth"),
      version: config.version,
      identity: createSaasIdentity(store, auth, supervisor),
      unifiedLogin: { contexts, continuations },
      isHealthy: () => !closing,
      trustProxy: 1,
      allowedOrigins: config.allowedOrigins,
    });
  } catch (error) {
    await supervisor.close();
    store.close();
    throw error;
  }
  const routes = createSaasRoutes({
    auth,
    store,
    supervisor,
    publicUrl: config.publicUrl,
    revokeGrants: gateway.revokeGrants,
    purgeUserFiles: (userId) => rm(join(config.filesRoot, userId), { recursive: true, force: true }),
  });
  const telegramAuthRoutes = createTelegramAuthRoutes({
    auth,
    store,
    vault,
    attempts: loginAttempts,
    contexts,
    continuations,
    publicUrl: config.publicUrl,
    revokeGrants: gateway.revokeGrants,
  });
  gateway.app.use("/api/saas/telegram-auth", telegramAuthRoutes);
  gateway.app.use("/api/saas", routes);
  const app = express();
  app.disable("x-powered-by");
  app.use((_req, res, next) => {
    if (closing) {
      res.set("Retry-After", "30").status(503).json({ error: "service-stopping" });
      return;
    }
    next();
  });
  app.use(gateway.app);
  if (config.webRoot && csp) mountSaasFrontend(app, { root: config.webRoot, origin: config.publicUrl, csp });
  let closePromise: Promise<void> | undefined;
  const close = () => {
    if (closePromise) return closePromise;
    closing = true;
    const workers = supervisor.close(); // forbid admission before draining browser attempts
    closePromise = (async () => {
      try {
        await telegramAuthRoutes.close();
        contexts.close();
        continuations.close();
        await routes.close();
      } finally {
        await workers;
        try {
          await gateway.close();
        } finally {
          store.close();
        }
      }
    })();
    return closePromise;
  };
  return { app, close };
}
export async function runSaas() {
  await import("dotenv/config");
  const config = configFromEnv();
  const service = await startSaas(config);
  const listener = service.app.listen(config.port ?? 3000, "0.0.0.0");
  listener.once("error", () => {
    void service.close().finally(() => {
      process.exitCode = 1;
    });
  });
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    const stopped = new Promise<void>((resolve) => listener.close(() => resolve()));
    listener.closeIdleConnections();
    try {
      await service.close();
      await stopped;
    } catch {
      process.exitCode = 1;
    }
  };
  process.once("SIGTERM", () => {
    void shutdown();
  });
  process.once("SIGINT", () => {
    void shutdown();
  });
  await new Promise<void>((resolve, reject) => {
    listener.once("listening", resolve);
    listener.once("error", reject);
  });
  console.error(`[saas] listening on port ${config.port ?? 3000}`);
}
