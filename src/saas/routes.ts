import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type Request, type Response, type Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { GlobalLock } from "../global-lock.js";
import { verifyPassword } from "../http/owner.js";
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
  auth: SaasAuth;
  store: SaasStore;
  supervisor: LoginSupervisor;
  publicUrl: string;
  revokeGrants: (ids: string[]) => Promise<void>;
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
  const invalidate = (userId: string) => {
    const ids = store.revokeUserGrants(userId);
    void cleanupGrants(ids);
  };
  const attempts = options.attempts ?? new LoginAttempts(supervisor, { onLinked: invalidate });
  router.close = () => attempts.close();
  const locks = new Map<string, GlobalLock>();
  const limit = (
    windowMs: number,
    count: number,
    keyGenerator?: NonNullable<Parameters<typeof rateLimit>[0]>["keyGenerator"],
  ) =>
    rateLimit({
      windowMs,
      limit: count,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator,
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
  router.use(limit(60000, 600, () => "all"));
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
      const stopping = supervisor.stopUser(user.id);
      await attempts.clearUser(user.id);
      await stopping;
      await cleanupGrants(ids);
    }
    clearCookie(res);
    res.json({ ok: true, recoveryCodes: recovered.recoveryCodes });
  });
  router.use((req, res, next) => {
    const session = auth.authenticate(saasCookie(req));
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
  const mutation =
    (work: (req: Request, res: Response, userId: string) => Promise<void>) => async (req: Request, res: Response) => {
      const userId = res.locals.saas.userId as string;
      let lock = locks.get(userId);
      if (!lock) {
        lock = new GlobalLock(0);
        locks.set(userId, lock);
      }
      let release: (() => void) | undefined;
      try {
        release = await lock.acquire();
        if (!auth.authenticate(saasCookie(req))) {
          res.status(401).json({ error: "authentication-required" });
          return;
        }
        await work(req, res, userId);
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
  router.get("/me", (_req, res) => {
    const session = res.locals.saas;
    const user = store.findUser(session.userId);
    if (!user || user.disabled) {
      res.sendStatus(401);
      return;
    }
    res.json({
      user: { id: user.id, login: user.login, hasPassword: !!user.passwordHash },
      csrfToken: session.csrfToken,
      policy: user.policy,
      telegram: supervisor.status(user.id),
      mcpUrl: `${origin}/mcp`,
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
      await attempts.clearUser(userId);
      clearCookie(res);
      res.sendStatus(204);
    }),
  );
  router.post(
    "/telegram/login",
    limit(600000, 3, (_req, res) => res.locals.saas.userId),
    mutation(async (_req, res, userId) => {
      res.status(202).json(await attempts.start(userId));
    }),
  );
  router.get("/telegram/login", (_req, res) => {
    res.json({ attempt: attempts.getCurrent(res.locals.saas.userId) });
  });
  router.get("/telegram/login/:attemptId", (req, res) => {
    const attempt = attempts.get(res.locals.saas.userId, String(req.params.attemptId));
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
  router.get("/clients", (_req, res) =>
    res.json({
      clients: store
        .listGrants(res.locals.saas.userId)
        .map((g) => ({ grantId: g.grantId, clientId: g.clientId, version: g.version })),
    }),
  );
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
      const ids = store.listGrants(userId).map((g) => g.grantId);
      const version = store.updatePolicy(userId, { ...parsed.data, version: 0 });
      await stopAccess(userId, ids);
      res.json({ policy: { ...parsed.data, version } });
    }),
  );
  router.post(
    "/telegram/disconnect",
    mutation(async (_req, res, userId) => {
      const ids = store.revokeUserGrants(userId);
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
      store.disableUser(userId);
      await stopAccess(userId, ids);
      await options.purgeUserFiles?.(userId);
      store.deleteUser(userId);
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
