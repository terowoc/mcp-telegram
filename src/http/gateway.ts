import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import express, { type ErrorRequestHandler } from "express";
import { rateLimit } from "express-rate-limit";
import Provider, { type Configuration, errors } from "oidc-provider";
import { type GatewayIdentity, ownerIdentity } from "./identity.js";
import { createMcpHandler } from "./mcp-handler.js";
import { loadOrCreateSecrets } from "./owner.js";
import { createAdapter } from "./storage.js";

export interface GatewayOptions {
  publicUrl: string;
  storageDir: string;
  ownerPasswordHash?: string;
  identity?: GatewayIdentity;
  version: string;
  callTool?: (name: string, args: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
  isHealthy?: () => boolean;
  allowedOrigins?: string[];
  trustProxy?: string | number;
}

const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
const equal = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createHttpGateway(options: GatewayOptions) {
  const url = new URL(options.publicUrl);
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
    throw new Error("MCP_PUBLIC_URL must be an HTTPS origin");
  if (!options.identity && (!options.ownerPasswordHash || !options.callTool))
    throw new Error("Owner identity configuration required");
  const identity =
    options.identity ??
    ownerIdentity({
      ownerPasswordHash: options.ownerPasswordHash ?? "",
      callTool: options.callTool as NonNullable<GatewayOptions["callTool"]>,
    });
  const mcpHandler = createMcpHandler(identity, options.version);
  const origin = url.origin;
  const resource = `${origin}/mcp`;
  const issuer = `${origin}/oauth`;
  const secrets = await loadOrCreateSecrets(options.storageDir);
  const Adapter = createAdapter(join(options.storageDir, "oauth.sqlite"));
  const config: Configuration = {
    adapter: Adapter,
    jwks: secrets.jwks,
    cookies: {
      keys: secrets.cookieKeys,
      long: { secure: true, httpOnly: true, sameSite: "lax" },
      short: { secure: true, httpOnly: true, sameSite: "lax" },
    },
    clients: [],
    clientBasedCORS: (_ctx, requestOrigin, client) =>
      requestOrigin === origin || client.redirectUris?.some((uri) => new URL(uri).origin === requestOrigin) === true,
    clientAuthMethods: ["none", "client_secret_post", "client_secret_basic"],
    responseTypes: ["code"],
    scopes: ["openid", "offline_access", "mcp:tools"],
    pkce: { required: () => true },
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    rotateRefreshToken: true,
    ttl: {
      AccessToken: 3600,
      AuthorizationCode: 60,
      RefreshToken: 30 * 86400,
      Interaction: 600,
      Session: 86400,
      Grant: 30 * 86400,
    },
    interactions: { url: (_ctx, interaction) => `${origin}/interaction/${interaction.uid}` },
    findAccount: (_ctx, id, token) => identity.findAccount(id, token?.grantId),
    loadExistingGrant: async (ctx) => {
      const grantId =
        ctx.oidc.result?.consent?.grantId ||
        (ctx.oidc.client ? ctx.oidc.session?.grantIdFor(ctx.oidc.client.clientId) : undefined);
      const accountId = ctx.oidc.result?.login?.accountId || ctx.oidc.session?.accountId;
      if (!grantId || !accountId || !identity.isGrantValid(accountId, grantId)) return undefined;
      return ctx.oidc.provider.Grant.find(grantId);
    },
    features: {
      devInteractions: { enabled: false },
      registration: { enabled: true },
      revocation: { enabled: true, allowedPolicy: (_ctx, client, token) => token.clientId === client.clientId },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, target) => {
          if (target !== resource) throw new errors.InvalidTarget();
          return { scope: "mcp:tools", audience: resource, accessTokenTTL: 3600, accessTokenFormat: "opaque" };
        },
      },
    },
    subjectTypes: ["public"],
    extraClientMetadata: {
      properties: ["mcp_policy"],
      validator: (_ctx, _key, _value, metadata) => {
        for (const key of ["jwks_uri", "sector_identifier_uri", "request_uris"] as const) {
          if (metadata[key]) throw new errors.InvalidClientMetadata(`${key} is not supported`);
        }
      },
    },
    routes: { authorization: "/auth", token: "/token", registration: "/reg", revocation: "/token/revocation" },
  };
  const provider = new Provider(issuer, config);
  provider.proxy = true;
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy ?? "loopback");
  const origins = new Set([origin, ...(options.allowedOrigins ?? [])]);
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    });
    if (req.headers.host !== url.host || req.protocol !== "https") {
      res.status(400).json({ error: "Invalid host or protocol" });
      return;
    }
    if (req.path === "/mcp" && req.headers.origin) {
      if (!origins.has(req.headers.origin)) {
        res.status(403).json({ error: "Origin not allowed" });
        return;
      }
      res.set({
        "Access-Control-Allow-Origin": req.headers.origin,
        Vary: "Origin",
        "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Expose-Headers": "WWW-Authenticate",
      });
      if (req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
    }
    const length = Number(req.headers["content-length"] ?? 0);
    if (length > 1048576) {
      res.sendStatus(413);
      return;
    }
    next();
  });
  app.get("/healthz", (_req, res) =>
    res
      .status(options.isHealthy?.() === false ? 503 : 200)
      .json({ status: options.isHealthy?.() === false ? "unavailable" : "ok" }),
  );
  if (identity.kind === "owner")
    app.get("/", (_req, res) =>
      res
        .type("html")
        .send(
          "<!doctype html><title>Telegram MCP</title><h1>Telegram MCP</h1><p>Connect your MCP client to /mcp. Access requires owner approval.</p>",
        ),
    );
  app.get(["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"], (_req, res) =>
    res.json({
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    }),
  );
  app.get(
    ["/.well-known/oauth-authorization-server/oauth", "/oauth/.well-known/oauth-authorization-server"],
    (_req, res) =>
      res.json({
        issuer,
        authorization_endpoint: `${issuer}/auth`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/reg`,
        revocation_endpoint: `${issuer}/token/revocation`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        scopes_supported: ["mcp:tools", "openid", "offline_access"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      }),
  );
  app.use("/oauth/reg", rateLimit({ windowMs: 3600000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use("/oauth", rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
  const csrfFor = (uid: string, prompt: string) =>
    createHmac("sha256", secrets.cookieKeys[0]).update(`${uid}:${prompt}`).digest("hex");
  app.get("/interaction/:uid", async (req, res) => {
    const interaction = await provider.interactionDetails(req, res);
    if (req.params.uid !== interaction.uid) {
      res.sendStatus(403);
      return;
    }
    const client = await provider.Client.find(String(interaction.params.client_id));
    const prompt = interaction.prompt.name;
    res
      .type("html")
      .send(
        `<!doctype html><html lang="ru"><meta name="viewport" content="width=device-width"><title>Telegram MCP — доступ</title><style>body{font:18px system-ui;max-width:36rem;margin:10vh auto;padding:1rem}input,button{font:inherit;padding:.6rem;margin:.5rem 0}input{width:90%}</style><h1>Доступ к Telegram MCP</h1><p>Клиент: <strong>${escapeHtml(client?.clientName ?? client?.clientId)}</strong></p><p>Разрешение: ${escapeHtml(identity.describeAccess(interaction.session?.accountId))}</p><form method="post" action="/interaction/${escapeHtml(interaction.uid)}"><input type="hidden" name="csrf" value="${csrfFor(interaction.uid, prompt)}">${prompt === "login" ? `${identity.kind === "saas" ? '<label>Логин TG Bridge<input name="login" autocomplete="username" required maxlength="32"></label>' : ""}<label>${identity.kind === "saas" ? "Пароль TG Bridge" : "Пароль владельца"}<input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label>` : ""}<button name="approve" value="yes">${prompt === "login" ? "Войти" : "Разрешить доступ"}</button> <button name="approve" value="no">Отказать</button></form></html>`,
      );
  });
  app.post(
    "/interaction/:uid",
    rateLimit({ windowMs: 900000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req, res) => {
      if (req.headers.origin !== origin) {
        res.sendStatus(403);
        return;
      }
      const interaction = await provider.interactionDetails(req, res);
      if (
        req.params.uid !== interaction.uid ||
        typeof req.body.csrf !== "string" ||
        !equal(req.body.csrf, csrfFor(interaction.uid, interaction.prompt.name))
      ) {
        res.sendStatus(403);
        return;
      }
      if (req.body.approve !== "yes") {
        await provider.interactionFinished(
          req,
          res,
          { error: "access_denied", error_description: "Owner denied access" },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      if (interaction.prompt.name === "login") {
        const accountId =
          typeof req.body.password === "string"
            ? await identity.authenticate({
                login: typeof req.body.login === "string" ? req.body.login : undefined,
                password: req.body.password,
              })
            : undefined;
        if (!accountId) {
          res.status(401).send("Неверные данные для входа");
          return;
        }
        await provider.interactionFinished(
          req,
          res,
          { login: { accountId, remember: true } },
          { mergeWithLastSubmission: false },
        );
      } else if (interaction.prompt.name === "consent") {
        const accountId = interaction.session?.accountId;
        if (!accountId || !identity.isActive(accountId)) {
          res.sendStatus(403);
          return;
        }
        const grant =
          interaction.grantId && identity.isGrantValid(accountId, interaction.grantId)
            ? await provider.Grant.find(interaction.grantId)
            : new provider.Grant({ accountId, clientId: String(interaction.params.client_id) });
        if (!grant) {
          res.sendStatus(400);
          return;
        }
        const details = interaction.prompt.details;
        if (details.missingOIDCScope) grant.addOIDCScope(details.missingOIDCScope as string[]);
        if (details.missingOIDCClaims) grant.addOIDCClaims(details.missingOIDCClaims as string[]);
        for (const [target, scopes] of Object.entries(
          (details.missingResourceScopes ?? {}) as Record<string, string[]>,
        )) {
          if (target !== resource) {
            res.sendStatus(400);
            return;
          }
          grant.addResourceScope(target, scopes);
        }
        const grantId = await grant.save();
        identity.bindGrant(accountId, grantId, String(interaction.params.client_id));
        await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
      } else {
        res.sendStatus(400);
      }
    },
  );
  app.use("/oauth", provider.callback());
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`;
  app.all(
    "/mcp",
    rateLimit({ windowMs: 60000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }),
    async (req, res, next) => {
      const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? "");
      const token = match ? await provider.AccessToken.find(match[1]) : undefined;
      if (
        !token?.accountId ||
        !identity.isActive(token.accountId) ||
        token.aud !== resource ||
        !token.scope?.split(" ").includes("mcp:tools") ||
        !token.grantId ||
        !identity.isGrantValid(token.accountId, token.grantId) ||
        !(await provider.Grant.find(token.grantId))
      ) {
        res.set("WWW-Authenticate", challenge).status(401).json({ error: "invalid_token" });
        return;
      }
      res.locals.mcpIdentity = { accountId: token.accountId, grantId: token.grantId };
      next();
    },
    express.json({ limit: "1mb" }),
    async (req, res) => {
      await mcpHandler(req, res);
    },
  );
  const onError: ErrorRequestHandler = (error, _req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(error?.type === "entity.too.large" ? 413 : 400).json({ error: "Request rejected" });
  };
  app.use(onError);
  return {
    app,
    revokeGrants: async (ids: string[]) => {
      for (const id of ids) {
        const grant = await provider.Grant.find(id);
        if (grant) await grant.destroy();
        await new Adapter("AccessToken").revokeByGrantId(id);
      }
    },
    close: async () => {
      Adapter.close();
    },
  };
}
