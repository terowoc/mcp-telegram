import express, { type ErrorRequestHandler, type Request, type Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import type { SaasAuth } from "./auth.js";
import type { BootstrapContexts } from "./bootstrap-contexts.js";
import type { OAuthContinuations } from "./oauth-continuations.js";
import { SAAS_COOKIE, type SaasRouter, saasCookie } from "./routes.js";
import type { SessionVault } from "./session-vault.js";
import type { SaasStore } from "./store.js";
import type { TelegramAuthAttempts } from "./telegram-auth-attempts.js";
import { CapacityError } from "./worker-budget.js";

export function setSaasSession(
  res: Response,
  store: SaasStore,
  value: { sessionToken: string; csrfToken: string; userId: string },
) {
  res.cookie(SAAS_COOKIE, value.sessionToken, {
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 86400000,
  });
  return {
    csrfToken: value.csrfToken,
    user: {
      id: value.userId,
      login: store.findUser(value.userId)?.login,
      hasPassword: !!store.findUser(value.userId)?.passwordHash,
    },
  };
}
export function createTelegramAuthRoutes(options: {
  auth: SaasAuth;
  store: SaasStore;
  vault: SessionVault;
  attempts: TelegramAuthAttempts;
  contexts: BootstrapContexts;
  continuations?: OAuthContinuations;
  publicUrl: string;
  revokeGrants: (ids: string[]) => Promise<void>;
}): SaasRouter {
  const { auth, store, attempts, contexts } = options;
  const origin = new URL(options.publicUrl).origin;
  const router = express.Router() as SaasRouter;
  const continuations = new Map<string, { handle: string; expiresAt: number }>();
  router.close = () => attempts.close();
  const byIp = rateLimit({
    windowMs: 900000,
    limit: 5,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate-limited" },
  });
  const aggregate = rateLimit({
    windowMs: 3600000,
    limit: 20,
    keyGenerator: () => "all",
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: { error: "rate-limited" },
  });
  const reads = rateLimit({
    windowMs: 60000,
    limit: 60,
    keyGenerator: (_req, res) => res.locals.bootstrap.contextHash,
    standardHeaders: "draft-8",
    legacyHeaders: false,
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
  router.use(express.json({ limit: "8kb" }));
  router.post(
    "/start",
    (req, res, next) => {
      if (req.headers["x-csrf-token"] === undefined || req.headers["x-csrf-token"] === "") {
        const context = contexts.ensure(req, res);
        res.json({ csrfToken: context.csrfToken });
        return;
      }
      const context = contexts.verify(req, true);
      if (!context) {
        res.status(403).json({ error: "csrf-denied" });
        return;
      }
      res.locals.bootstrap = context;
      next();
    },
    byIp,
    aggregate,
    async (req, res) => {
      const parsed = z
        .object({
          continuation: z
            .string()
            .regex(/^[A-Za-z0-9_-]{43}$/)
            .optional(),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "invalid-request" });
        return;
      }
      const continuation = parsed.data.continuation
        ? options.continuations?.find(parsed.data.continuation, res.locals.bootstrap.contextHash)
        : undefined;
      if (parsed.data.continuation && !continuation) {
        res.status(409).json({ error: "continuation-expired" });
        return;
      }
      for (const [id, entry] of continuations) if (entry.expiresAt <= Date.now()) continuations.delete(id);
      const view = await attempts.start(res.locals.bootstrap.contextHash);
      if (continuation && parsed.data.continuation)
        continuations.set(view.id, { handle: parsed.data.continuation, expiresAt: continuation.expiresAt });
      if (!contexts.verify(req, true)) {
        await attempts.cancel(res.locals.bootstrap.contextHash, view.id);
        continuations.delete(view.id);
        res.status(401).json({ error: "authentication-required" });
        return;
      }
      contexts.extend(req, res);
      res.status(201).json(view);
    },
  );
  router.use((req, res, next) => {
    const context = contexts.verify(req, !["GET", "HEAD", "OPTIONS"].includes(req.method));
    if (!context) {
      res.status(401).json({ error: "authentication-required" });
      return;
    }
    res.locals.bootstrap = context;
    next();
  });
  router.post("/revoke", async (req, res) => {
    const contextHash = res.locals.bootstrap.contextHash;
    contexts.clear(req, res);
    await attempts.clearContext(contextHash);
    res.sendStatus(204);
  });
  const owned = (req: Request, res: Response) => {
    const view = attempts.get(res.locals.bootstrap.contextHash, String(req.params.id));
    if (!view) res.status(404).json({ error: "attempt-not-found" });
    return view;
  };
  router.post("/resume", (req, res) => {
    const body = z.object({ continuation: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(req.body);
    if (!auth.authenticate(saasCookie(req))) {
      res.status(401).json({ error: "authentication-required" });
      return;
    }
    const continuation = body.success
      ? options.continuations?.consume(body.data.continuation, res.locals.bootstrap.contextHash)
      : undefined;
    if (!continuation) {
      res.status(409).json({ error: "continuation-expired" });
      return;
    }
    contexts.clear(req, res);
    res.json({ continueTo: `/interaction/${continuation.interactionUid}` });
  });
  router.get("/:id", reads, (req, res) => {
    const view = owned(req, res);
    if (view) res.json(view);
  });
  router.post("/:id/password", (req, res) => {
    if (!owned(req, res)) return;
    const body = z.object({ password: z.string().min(1).max(1024) }).safeParse(req.body);
    if (
      !body.success ||
      !attempts.password(res.locals.bootstrap.contextHash, String(req.params.id), body.data.password)
    ) {
      res.status(409).json({ error: "password-not-expected" });
      return;
    }
    res.sendStatus(204);
  });
  router.post("/:id/complete", async (req, res) => {
    if (!owned(req, res)) return;
    const body = z.object({ legacyPassword: z.string().max(1024).optional() }).safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "invalid-request" });
      return;
    }
    let legacyUserId: string | undefined;
    if (body.data.legacyPassword !== undefined) {
      const cabinet = auth.authenticate(saasCookie(req));
      if (
        !cabinet ||
        !(await auth.verifyLegacyPassword(cabinet.userId, body.data.legacyPassword)) ||
        !auth.authenticate(saasCookie(req))
      ) {
        res.status(403).json({ error: "invalid-credentials" });
        return;
      }
      legacyUserId = cabinet.userId;
    }
    const ids = legacyUserId ? store.listGrants(legacyUserId).map((grant) => grant.grantId) : [];
    const continuationHandle = continuations.get(String(req.params.id))?.handle;
    if (continuationHandle && !options.continuations?.find(continuationHandle, res.locals.bootstrap.contextHash)) {
      await attempts.cancel(res.locals.bootstrap.contextHash, String(req.params.id));
      continuations.delete(String(req.params.id));
      res.status(409).json({ error: "continuation-expired" });
      return;
    }
    const signed = await attempts.complete(res.locals.bootstrap.contextHash, String(req.params.id), {
      legacyUserId,
      authorize: () =>
        !!contexts.verify(req, true) && (!legacyUserId || auth.authenticate(saasCookie(req))?.userId === legacyUserId),
    });
    if (signed.linked && ids.length) await options.revokeGrants(ids).catch(() => {});
    // Grant cleanup yields after the browser session commit. Account switching must still fence this response.
    if (!contexts.verify(req, true)) {
      auth.logout(signed.sessionToken);
      continuations.delete(String(req.params.id));
      res.status(401).json({ error: "authentication-required" });
      return;
    }
    const continuation = continuationHandle
      ? options.continuations?.consume(continuationHandle, res.locals.bootstrap.contextHash)
      : undefined;
    continuations.delete(String(req.params.id));
    contexts.clear(req, res);
    res.json({
      ...setSaasSession(res, store, signed),
      ...(continuation ? { continueTo: `/interaction/${continuation.interactionUid}` } : {}),
    });
  });
  router.delete("/:id", async (req, res) => {
    if (!owned(req, res)) return;
    await attempts.cancel(res.locals.bootstrap.contextHash, String(req.params.id));
    continuations.delete(String(req.params.id));
    res.sendStatus(204);
  });
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    if (error instanceof CapacityError) {
      res.set("Retry-After", "30").status(503).json({ error: "capacity" });
      return;
    }
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "invalid-request" });
      return;
    }
    const legacy = error instanceof Error && error.message === "legacy-link-required";
    res.status(409).json({ error: legacy ? "legacy-link-required" : "login-unavailable" });
  };
  router.use(errors);
  return router;
}
