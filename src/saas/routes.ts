import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { GlobalLock } from "../global-lock.js";
import { verifyPassword } from "../http/owner.js";
import { createInstagramRoutes, instagramAccounts } from "../instagram/routes.js";
import type { InstagramSupervisor } from "../instagram/supervisor.js";
import { hashOpaqueToken, type SaasAuth } from "./auth.js";
import type { BootstrapContexts } from "./bootstrap-contexts.js";
import { LoginAttempts, type LoginSupervisor } from "./login-attempts.js";
import type { OAuthContinuations } from "./oauth-continuations.js";
import type { SaasStore } from "./store.js";
import { CapacityError } from "./supervisor.js";

export const SAAS_COOKIE = "__Host-mcp-saas";
export function saasCookie(req: Pick<Request, "headers">): string {
  return (
    req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${SAAS_COOKIE}=`))
      ?.slice(SAAS_COOKIE.length + 1) ?? ""
  );
}
const credentials = z.object({
  login: z.string().regex(/^[a-zA-Z0-9_]{3,32}$/),
  password: z.string().min(16).max(1024),
});
const policySchema = z.object({
  profile: z.enum(["read", "full"]),
  chatIds: z.array(z.string().regex(/^-?[1-9]\d{0,19}$/)).max(100),
});
interface Options {
  instagram?: InstagramSupervisor;
  auth: SaasAuth;
  store: SaasStore;
  supervisor: LoginSupervisor;
  publicUrl: string;
  revokeGrants: (ids: string[]) => Promise<void>;
  clientName?: (id: string) => Promise<string | undefined>;
  attempts?: LoginAttempts;
  oauth?: { contexts: BootstrapContexts; continuations: OAuthContinuations };
  purgeUserFiles?: (userId: string) => Promise<void>;
}
export type SaasRouter = Router & { close: () => Promise<void> };

export function createSaasRoutes(options: Options): SaasRouter {
  const { auth, store, supervisor } = options;
  const origin = new URL(options.publicUrl).origin;
  const router = express.Router() as SaasRouter;
  const cleanupGrants = async (ids: string[]) => {
    try {
      await options.revokeGrants(ids);
    } catch {
      /* DB markers already revoked; provider cleanup is best effort */
    }
  };
  const invalidate = (accountId: string) => {
    const ownerId = store.connectionOwner(accountId);
    const user = store.findUser(ownerId);
    if (!user || user.disabled) return;
    const ids = store.revokeUserGrants(ownerId);
    void cleanupGrants(ids);
  };
  const attempts = options.attempts ?? new LoginAttempts(supervisor, { onLinked: invalidate });
  router.close = () => attempts.close();
  const locks = new Map<string, GlobalLock>();
  const limit = (
    windowMs: number,
    count: number,
    keyGenerator?: NonNullable<Parameters<typeof rateLimit>[0]>["keyGenerator"],
    skip?: NonNullable<Parameters<typeof rateLimit>[0]>["skip"],
  ) =>
    rateLimit({
      windowMs,
      limit: count,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator,
      skip,
      message: { error: "rate-limited" },
    });
  router.use((_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    next();
  });
  router.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && req.headers.origin !== origin) {
      res.status(403).json({ error: "origin-denied" });
      return;
    }
    next();
  });
  router.use((req, res, next) => {
    res.locals.saas = auth.authenticate(saasCookie(req));
    next();
  });
  router.use(
    limit(
      60000,
      600,
      () => "all",
      (_req, res) => !!res.locals.saas,
    ),
  );
  const loginLimit = limit(900000, 10),
    registrationLimit = limit(3600000, 5),
    aggregateRegistration = limit(3600000, 20, () => "all");
  const setSession = (res: Response, value: { sessionToken: string; csrfToken: string; userId: string }) => {
    res.cookie(SAAS_COOKIE, value.sessionToken, {
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 86400000,
    });
    return { csrfToken: value.csrfToken, user: { id: value.userId, login: store.findUser(value.userId)?.login } };
  };
  const clearCookie = (res: Response) =>
    res.clearCookie(SAAS_COOKIE, { secure: true, httpOnly: true, sameSite: "lax", path: "/" });
  const json = express.json({ limit: "8kb" });
  router.post("/register", registrationLimit, aggregateRegistration, json, async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "registration-failed" });
      return;
    }
    try {
      const account = await auth.register(parsed.data.login, parsed.data.password);
      res.status(201).json({ ...setSession(res, account), recoveryCodes: account.recoveryCodes });
    } catch (error) {
      if (error instanceof Error && error.message === "Account capacity reached") {
        res.set("Retry-After", "3600").status(503).json({ error: "capacity" });
        return;
      }
      res.status(400).json({ error: "registration-failed" });
    }
  });
  router.post("/login", loginLimit, json, async (req, res) => {
    const parsed = credentials.safeParse(req.body);
    const account = parsed.success ? await auth.login(parsed.data.login, parsed.data.password) : undefined;
    if (!account) {
      res.status(401).json({ error: "invalid-credentials" });
      return;
    }
    res.json(setSession(res, account));
  });
  router.post("/recover", loginLimit, json, async (req, res) => {
    const parsed = z
      .object({
        login: credentials.shape.login,
        recoveryCode: z.string().max(128),
        newPassword: credentials.shape.password,
      })
      .safeParse(req.body);
    const user = parsed.success ? store.findByLogin(parsed.data.login) : undefined;
    const ids = user ? store.listGrants(user.id).map((g) => g.grantId) : [];
    const recovered = parsed.success
      ? await auth.recover(parsed.data.login, parsed.data.recoveryCode, parsed.data.newPassword)
      : undefined;
    if (!recovered) {
      res.status(400).json({ error: "recovery-failed" });
      return;
    }
    if (user) {
      await options.instagram?.clearOwner(user.id, true);
      for (const connection of store.listTelegramConnections(user.id)) {
        const stopping = supervisor.stopUser(connection.id);
        await attempts.clearUser(connection.id);
        await stopping;
      }
      await cleanupGrants(ids);
    }
    clearCookie(res);
    res.json({ ok: true, recoveryCodes: recovered.recoveryCodes });
  });
  router.use((req, res, next) => {
    const session = res.locals.saas;
    if (!session) {
      res.status(401).json({ error: "authentication-required" });
      return;
    }
    res.locals.saas = session;
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const csrf = req.headers["x-csrf-token"];
      if (
        typeof csrf !== "string" ||
        csrf.length > 128 ||
        !timingSafeEqual(Buffer.from(hashOpaqueToken(csrf)), Buffer.from(session.csrfHash))
      ) {
        res.status(403).json({ error: "csrf-denied" });
        return;
      }
    }
    next();
  });
  router.use(limit(60000, 120, (_req, res) => res.locals.saas.userId));
  router.use(json);
  router.use((req, res, next) => {
    const owner = res.locals.saas.userId as string;
    const selected = req.query.telegramAccountId ?? owner;
    if (typeof selected !== "string" || !store.ownsTelegramConnection(owner, selected)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.locals.telegramAccountId = selected;
    next();
  });
  const mutation =
    (work: (req: Request, res: Response, userId: string) => Promise<void>, queue = false) =>
    async (req: Request, res: Response) => {
      const userId = res.locals.saas.userId as string;
      let lock = locks.get(userId);
      if (!lock) {
        lock = new GlobalLock(4);
        locks.set(userId, lock);
      }
      let release: (() => void) | undefined;
      try {
        if (!queue && lock.isLocked()) throw new Error("Account operation already active");
        release = await lock.acquire();
        if (!auth.authenticate(saasCookie(req))) {
          res.status(401).json({ error: "authentication-required" });
          return;
        }
        const selected = res.locals.telegramAccountId as string;
        if (!store.ownsTelegramConnection(userId, selected)) {
          res.status(404).json({ error: "not-found" });
          return;
        }
        await work(
          req,
          res,
          (req.path.startsWith("/telegram/") && !req.path.startsWith("/telegram/accounts")) || req.path === "/policy"
            ? selected
            : userId,
        );
      } catch (error) {
        if (error instanceof CapacityError) {
          res.set("Retry-After", String(error.retryAfter)).status(503).json({ error: "capacity" });
        } else res.status(409).json({ error: "operation-unavailable" });
      } finally {
        release?.();
        if (!lock.isLocked()) locks.delete(userId);
      }
    };
  const stopAccess = async (userId: string, ids: string[]) => {
    const stopping = supervisor.stopUser(userId);
    await attempts.clearUser(userId);
    await stopping;
    await cleanupGrants(ids);
  };
  if (options.instagram)
    router.use(
      "/instagram",
      createInstagramRoutes({ store, supervisor: options.instagram, revokeGrants: options.revokeGrants, mutation }),
    );
  router.get("/me", (_req, res) => {
    const session = res.locals.saas;
    const user = store.findUser(session.userId);
    if (!user || user.disabled) {
      res.sendStatus(401);
      return;
    }
    const selectedUser = store.findUser(res.locals.telegramAccountId);
    if (!selectedUser || selectedUser.disabled) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.json({
      user: { id: user.id, login: user.login, hasPassword: !!user.passwordHash },
      csrfToken: session.csrfToken,
      telegramAccountId: res.locals.telegramAccountId,
      accounts: store.listTelegramConnections(user.id, true).map((connection) => ({
        removalPending: connection.disabled,
        id: connection.id,
        label: connection.label,
        primary: connection.primary,
        policy: connection.policy,
        telegram: supervisor.status(connection.id),
      })),
      policy: selectedUser.policy,
      telegram: supervisor.status(res.locals.telegramAccountId),
      mcpUrl: `${origin}/mcp`,
      ...(options.instagram
        ? { instagram: { enabled: true, accounts: instagramAccounts(store, options.instagram, session.userId) } }
        : {}),
    });
  });
  router.post("/oauth/resume", (req, res) => {
    const parsed = z.object({ continuation: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(req.body);
    const context = options.oauth?.contexts.verify(req, false);
    const continuation =
      parsed.success && context
        ? options.oauth?.continuations.consume(parsed.data.continuation, context.contextHash)
        : undefined;
    if (!continuation) {
      res.status(409).json({ error: "continuation-expired" });
      return;
    }
    options.oauth?.contexts.clear(req, res);
    res.json({ continueTo: `/interaction/${continuation.interactionUid}` });
  });
  router.post(
    "/logout",
    mutation(async (_req, res, userId) => {
      auth.logout(saasCookie(_req));
      await options.instagram?.clearOwner(userId);
      for (const connection of store.listTelegramConnections(userId)) await attempts.clearUser(connection.id);
      clearCookie(res);
      res.sendStatus(204);
    }),
  );
  const labelSchema = z.object({ label: z.string().trim().min(1).max(80) });
  const connections = (ownerId: string) =>
    store.listTelegramConnections(ownerId, true).map((connection) => ({
      removalPending: connection.disabled,
      id: connection.id,
      label: connection.label,
      primary: connection.primary,
      policy: connection.policy,
      telegram: supervisor.status(connection.id),
    }));
  router.get("/telegram/accounts", (_req, res) => res.json({ accounts: connections(res.locals.saas.userId) }));
  router.post(
    "/telegram/accounts",
    mutation(async (req, res, ownerId) => {
      const parsed = labelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-account-label" });
        return;
      }
      try {
        const account = store.createTelegramConnection(ownerId, parsed.data.label);
        invalidate(ownerId);
        res.status(201).json({ account: connections(ownerId).find((connection) => connection.id === account.id) });
      } catch (error) {
        if (error instanceof Error && /capacity/i.test(error.message)) {
          res.status(409).json({ error: "account-capacity" });
          return;
        }
        throw error;
      }
    }),
  );
  router.patch(
    "/telegram/accounts/:accountId",
    mutation(async (req, res, ownerId) => {
      const id = String(req.params.accountId);
      if (!store.ownsTelegramConnection(ownerId, id)) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const parsed = labelSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-account-label" });
        return;
      }
      store.renameTelegramConnection(ownerId, id, parsed.data.label);
      res.json({ account: connections(ownerId).find((connection) => connection.id === id) });
    }),
  );
  router.delete(
    "/telegram/accounts/:accountId",
    mutation(async (req, res, ownerId) => {
      const id = String(req.params.accountId);
      if (!store.ownsTelegramConnection(ownerId, id, true)) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      if (id === ownerId) {
        res.status(409).json({ error: "primary-account-required" });
        return;
      }
      invalidate(ownerId);
      store.requestConnectionDeletion(id); // blocks new requests and late worker saves before draining
      await stopAccess(id, []);
      await options.purgeUserFiles?.(id);
      store.deleteUser(id);
      res.sendStatus(204);
    }),
  );
  const newLoginLimit = limit(600000, 3, (_req, res) => res.locals.saas.userId);
  router.post(
    "/telegram/login",
    mutation(async (req, res, userId) => {
      if (supervisor.status(userId).sessionPresent) {
        res.status(409).json({ error: "telegram-already-connected" });
        return;
      }
      const current = attempts.getCurrent(userId);
      if (current) {
        res.status(202).json(current);
        return;
      }
      // Only the request actually starting a QR spends quota. Cold-start retries
      // wait on the account lock, then return its newly established attempt.
      const admitted = await new Promise<boolean>((resolve, reject) => {
        const cleanup = () => {
          res.off("finish", finished);
          res.off("close", finished);
        };
        const finished = () => {
          cleanup();
          resolve(false);
        };
        res.once("finish", finished);
        res.once("close", finished);
        Promise.resolve(
          newLoginLimit(req, res, (error?: unknown) => {
            cleanup();
            if (error) reject(error);
            else resolve(true);
          }),
        ).catch((error) => {
          cleanup();
          reject(error);
        });
      });
      if (!admitted) return;
      if (!auth.authenticate(saasCookie(req))) {
        res.status(401).json({ error: "authentication-required" });
        return;
      }
      res.status(202).json(await attempts.start(userId));
    }, true),
  );
  router.get("/telegram/login", (_req, res) => {
    res.json({ attempt: attempts.getCurrent(res.locals.telegramAccountId) });
  });
  router.get("/telegram/login/:attemptId", (req, res) => {
    const attempt = attempts.get(res.locals.telegramAccountId, String(req.params.attemptId));
    if (!attempt) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.json(attempt);
  });
  router.post(
    "/telegram/login/:attemptId/password",
    mutation(async (req, res, userId) => {
      const id = String(req.params.attemptId);
      if (!attempts.get(userId, id)) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-password" });
        return;
      }
      if (!attempts.password(userId, id, parsed.data.password)) {
        res.status(409).json({ error: "attempt-not-waiting" });
        return;
      }
      res.status(202).json({ ok: true });
    }),
  );
  router.delete(
    "/telegram/login/:attemptId",
    mutation(async (req, res, userId) => {
      if (!(await attempts.cancel(userId, String(req.params.attemptId)))) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      res.sendStatus(204);
    }),
  );
  router.get("/clients", async (_req, res) => {
    const userId = res.locals.saas.userId as string;
    const clients = await Promise.all(
      store.listGrants(userId).map(async (g) => {
        const name = await options.clientName?.(g.clientId).catch(() => undefined);
        return {
          grantId: g.grantId,
          clientId: g.clientId,
          version: g.version,
          ...(name ? { name: name.slice(0, 160) } : {}),
        };
      }),
    );
    // A revocation during optional metadata lookup must not return an obsolete connection.
    const active = new Set(store.listGrants(userId).map((g) => g.grantId));
    res.json({ clients: clients.filter((client) => active.has(client.grantId)) });
  });
  router.delete(
    "/clients/:grantId",
    mutation(async (req, res, userId) => {
      const id = String(req.params.grantId);
      if (store.findGrant(id)?.userId !== userId) {
        res.status(404).json({ error: "not-found" });
        return;
      }
      store.revokeGrant(userId, id);
      await cleanupGrants([id]);
      res.sendStatus(204);
    }),
  );
  router.put(
    "/policy",
    mutation(async (req, res, userId) => {
      const parsed = policySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-policy" });
        return;
      }
      const ownerId = res.locals.saas.userId as string;
      const ids = store.listGrants(ownerId).map((g) => g.grantId);
      const version = store.updatePolicy(userId, { ...parsed.data, version: 0 });
      if (userId !== ownerId) invalidate(ownerId);
      await stopAccess(userId, ids);
      res.json({ policy: { ...parsed.data, version } });
    }),
  );
  router.post(
    "/telegram/disconnect",
    mutation(async (_req, res, userId) => {
      const ownerId = res.locals.saas.userId as string;
      const ids = store.listGrants(ownerId).map((g) => g.grantId);
      invalidate(ownerId);
      store.deleteEncryptedSession(userId);
      await stopAccess(userId, ids);
      res.sendStatus(204);
    }),
  );
  router.delete(
    "/account",
    mutation(async (req, res, userId) => {
      const parsed = z.object({ password: z.string().min(1).max(1024) }).safeParse(req.body);
      const user = store.findUser(userId);
      const session = auth.authenticate(saasCookie(req));
      const passwordless =
        !!user &&
        !user.passwordHash &&
        req.body?.confirm === true &&
        !!session &&
        session.authenticatedAt > Date.now() - 300000;
      if (
        !passwordless &&
        (!parsed.success || !user?.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash)))
      ) {
        res
          .status(403)
          .json({ error: user && !user.passwordHash ? "reauthentication-required" : "invalid-credentials" });
        return;
      }
      if (!user) {
        res.sendStatus(403);
        return;
      }
      const current = store.findUser(userId);
      if (!current || current.passwordHash !== user.passwordHash || !auth.authenticate(saasCookie(req))) {
        res.status(403).json({ error: "invalid-credentials" });
        return;
      }
      const ids = store.listGrants(userId).map((g) => g.grantId);
      if (options.instagram) for (const id of store.instagram.ownedIds(userId)) store.instagram.remove(userId, id);
      const owned = store.requestCabinetDeletion(userId);
      await options.instagram?.clearOwner(userId, true);
      if (options.instagram) for (const id of store.instagram.ownedIds(userId)) await options.instagram.purge(id);
      for (const id of [...owned].reverse()) {
        await stopAccess(id, id === userId ? ids : []);
        await options.purgeUserFiles?.(id);
        store.deleteUser(id);
      }
      clearCookie(res);
      res.sendStatus(204);
    }),
  );
  router.use((_req, res) => res.status(404).json({ error: "not-found" }));
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error?.type === "entity.too.large" ? 413 : 400).json({ error: "invalid-request" });
  };
  router.use(errors);
  return router;
}
