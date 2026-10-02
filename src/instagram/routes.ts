import express, { type Request, type RequestHandler, type Response } from "express";
import { z } from "zod";
import type { SaasStore } from "../saas/store.js";
import type { InstagramSupervisor } from "./supervisor.js";
import { InstagramError, policySchema } from "./types.js";

export function instagramAccounts(store: SaasStore, supervisor: InstagramSupervisor, owner: string) {
  return store.instagram.list(owner, true).map((c) => ({
    id: c.id,
    label: c.label,
    policy: c.policy,
    removalPending: c.removalPending,
    instagram: c.removalPending
      ? { state: "stopped", busy: false, sessionPresent: false, account: c.account }
      : supervisor.status(owner, c.id),
  }));
}
export function createInstagramRoutes(options: {
  store: SaasStore;
  supervisor: InstagramSupervisor;
  revokeGrants: (ids: string[]) => Promise<void>;
  mutation: (work: (req: Request, res: Response, owner: string) => Promise<void>) => RequestHandler;
}) {
  const router = express.Router(),
    { store, supervisor } = options;
  router.get("/accounts", (_req, res) =>
    res.json({ accounts: instagramAccounts(store, supervisor, res.locals.saas.userId) }),
  );
  router.use("/accounts/:accountId", (req, res, next) => {
    const id = String(req.params.accountId);
    if (!z.uuid().safeParse(id).success || !store.instagram.get(res.locals.saas.userId, id, true)) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.locals.instagramAccountId = id;
    next();
  });
  const action = (work: (req: Request, res: Response, owner: string, id: string) => Promise<void> | void) =>
    options.mutation(async (req, res, owner) => {
      const grants = store.listGrants(owner).map((g) => g.grantId);
      try {
        await work(req, res, owner, res.locals.instagramAccountId);
      } catch (e) {
        if (e instanceof z.ZodError) {
          res.status(400).json({ error: "invalid-request" });
          return;
        }
        if (e instanceof InstagramError) {
          const status = e.code === "not-found" ? 404 : e.code === "capacity" || e.code === "rate-limited" ? 503 : 409;
          res.status(status).json({ error: e.code });
          return;
        }
        throw e;
      } finally {
        const revoked = grants.filter((id) => !store.findGrant(id));
        if (revoked.length) await options.revokeGrants(revoked).catch(() => {});
      }
    });
  const label = z.strictObject({ label: z.string().trim().min(1).max(80) });
  router.post(
    "/accounts",
    action((req, res, owner) => {
      const c = store.instagram.create(owner, label.parse(req.body).label);
      res.status(201).json({ account: instagramAccounts(store, supervisor, owner).find((a) => a.id === c.id) });
    }),
  );
  router.patch(
    "/accounts/:accountId",
    action((req, res, owner, id) => {
      store.instagram.rename(owner, id, label.parse(req.body).label);
      res.sendStatus(204);
    }),
  );
  router.put(
    "/accounts/:accountId/policy",
    action(async (req, res, owner, id) => {
      store.instagram.setPolicy(owner, id, policySchema.parse(req.body));
      await supervisor.stop(id);
      res.json({ policy: store.instagram.get(owner, id)?.policy });
    }),
  );
  const recent = (res: Response) => {
    if (res.locals.saas.authenticatedAt <= Date.now() - 300000) {
      res.status(403).json({ error: "reauthentication-required" });
      return false;
    }
    return true;
  };
  router.post(
    "/accounts/:accountId/login",
    action(async (req, res, owner, id) => {
      if (!recent(res)) return;
      const credentials = z
        .strictObject({
          username: z
            .string()
            .trim()
            .min(1)
            .max(64)
            .regex(/^[A-Za-z0-9_.]+$/),
          password: z.string().min(1).max(1024),
        })
        .parse(req.body);
      // Do not retain credentials on Express request objects after handing off.
      req.body = {};
      try {
        res.status(202).json(await supervisor.startLogin(owner, id, credentials));
      } finally {
        credentials.password = "";
      }
    }),
  );
  router.get("/accounts/:accountId/login/:attemptId", (req, res) => {
    const attempt = supervisor.attempt(
      res.locals.saas.userId,
      res.locals.instagramAccountId,
      String(req.params.attemptId),
    );
    if (!attempt) res.status(404).json({ error: "not-found" });
    else res.json(attempt);
  });
  router.post(
    "/accounts/:accountId/login/:attemptId/code",
    action((req, res, owner, id) => {
      if (!recent(res)) return;
      const parsed = z.strictObject({ code: z.string().trim().min(1).max(32) }).parse(req.body);
      req.body = {};
      try {
        supervisor.submitCode(owner, id, String(req.params.attemptId), parsed.code);
        res.status(202).json({ accepted: true });
      } finally {
        parsed.code = "";
      }
    }),
  );
  router.delete(
    "/accounts/:accountId/login/:attemptId",
    action(async (req, res, owner, id) => {
      await supervisor.cancelLogin(owner, id, String(req.params.attemptId));
      res.sendStatus(204);
    }),
  );
  router.post(
    "/accounts/:accountId/disconnect",
    action(async (_req, res, owner, id) => {
      store.instagram.disconnect(owner, id);
      await supervisor.stop(id);
      // Stopping the process clears any transient login credentials as well.
      res.sendStatus(204);
    }),
  );
  router.delete(
    "/accounts/:accountId",
    action(async (_req, res, owner, id) => {
      store.instagram.remove(owner, id);
      await supervisor.purge(id);
      res.sendStatus(204);
    }),
  );
  return router;
}
