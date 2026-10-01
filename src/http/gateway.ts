import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import express, { type ErrorRequestHandler, type Request } from "express";
import { rateLimit } from "express-rate-limit";
import Provider, { type Configuration, errors, interactionPolicy } from "oidc-provider";
import type { BootstrapContexts } from "../saas/bootstrap-contexts.js";
import type { OAuthContinuations } from "../saas/oauth-continuations.js";
import { DirectMediaUploads } from "./direct-media-upload.js";
import { type GatewayIdentity, ownerIdentity } from "./identity.js";
import { createMcpHandler } from "./mcp-handler.js";
import { loadOrCreateSecrets } from "./owner.js";
import { connectionUi } from "./pages.js";
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
  cabinetLogin?: { contexts: BootstrapContexts; continuations: OAuthContinuations };
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
  const origin = url.origin;
  const resource = `${origin}/mcp`;
  const issuer = `${origin}/oauth`;
  const secrets = await loadOrCreateSecrets(options.storageDir);
  const Adapter = createAdapter(join(options.storageDir, "oauth.sqlite"), {
    authenticationBinding: identity.authenticationBinding,
  });
  const policy = interactionPolicy.base();
  if (options.cabinetLogin) {
    policy.get("login")?.checks.add(
      new interactionPolicy.Check(
        "cabinet_session",
        "Current cabinet authentication is required",
        "login_required",
        (ctx) => {
          const browser = identity.browserAuthentication?.(ctx.headers.cookie ?? "");
          const accountId = ctx.oidc.result?.login?.accountId ?? ctx.oidc.session?.accountId;
          return !browser || browser.accountId !== accountId || browser.binding !== ctx.oidc.acr;
        },
      ),
    );
  }
  const config: Configuration = {
    adapter: Adapter,
    renderError: async (ctx) => {
      ctx.type = "html";
      ctx.body = connectionUi(ctx.headers.cookie).error(
        "Не удалось подключить клиент",
        "Запрос подключения отклонён или ссылка устарела. Вернитесь в кабинет и начните подключение заново.",
      );
    },
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
    interactions: { policy, url: (_ctx, interaction) => `${origin}/interaction/${interaction.uid}` },
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
  const uploads = new DirectMediaUploads({
    origin,
    identity,
    validateGrant: async (id) => !!(await provider.Grant.find(id)),
  });
  const mcpHandler = createMcpHandler(identity, options.version, uploads);
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
    app.get("/", (req, res) =>
      res
        .type("html")
        .send(
          connectionUi(req.headers.cookie).page(
            "Подключить Telegram MCP",
            "Добавьте адрес сервера в настройках MCP своего AI-клиента и подтвердите доступ.",
            `<div class="access"><span class="accessLabel">MCP endpoint</span><strong>${escapeHtml(resource)}</strong></div><p class="help">Авторизация через OAuth. Каждый клиент подключается с разрешения владельца.</p>`,
          ),
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
  const csrfFor = (uid: string, prompt: string, accountId?: string) =>
    createHmac("sha256", secrets.cookieKeys[0])
      .update(`${uid}:${prompt}:${prompt === "consent" ? (identity.consentBinding?.(accountId) ?? "") : ""}`)
      .digest("hex");
  const browserFor = (req: Request, interaction: Awaited<ReturnType<typeof provider.interactionDetails>>) => {
    const browser = identity.browserAuthentication?.(req.headers.cookie ?? "");
    const maxAge = interaction.params.max_age === undefined ? undefined : Number(interaction.params.max_age);
    const forced =
      String(interaction.params.prompt ?? "")
        .split(" ")
        .includes("login") || maxAge === 0;
    const freshSince =
      forced && interaction.prompt.name === "login" && options.cabinetLogin
        ? options.cabinetLogin.continuations.freshSince(interaction.uid, interaction.exp * 1000)
        : undefined;
    if (!browser) return undefined;
    if (freshSince !== undefined && browser.authenticatedAt <= freshSince) return undefined;
    if (
      !forced &&
      maxAge !== undefined &&
      (!Number.isFinite(maxAge) || browser.authenticatedAt < Date.now() - maxAge * 1000)
    )
      return undefined;
    return browser;
  };
  const sessionCsrf = (uid: string, browser: NonNullable<ReturnType<typeof browserFor>>) =>
    createHmac("sha256", secrets.cookieKeys[0])
      .update(`session:${uid}:${browser.accountId}:${browser.binding}:${browser.authenticatedAt}`)
      .digest("hex");
  app.get("/interaction/:uid", async (req, res) => {
    const interaction = await provider.interactionDetails(req, res);
    if (req.params.uid !== interaction.uid) {
      res
        .status(403)
        .type("html")
        .send(
          connectionUi(req.headers.cookie).error("Подключение недоступно", "Начните подключение заново из AI-клиента."),
        );
      return;
    }
    const client = await provider.Client.find(String(interaction.params.client_id));
    const prompt = interaction.prompt.name;
    const browser = browserFor(req, interaction);
    const useSession = !!browser && (prompt === "login" || interaction.session?.accountId !== browser.accountId);
    const needsCabinet = !!options.cabinetLogin && (!browser || useSession || prompt === "login");
    let loginEntry = "";
    if (needsCabinet && !useSession && options.cabinetLogin) {
      const context = options.cabinetLogin.contexts.ensure(req, res);
      const handle = options.cabinetLogin.continuations.create({
        interactionUid: interaction.uid,
        clientId: String(interaction.params.client_id),
        contextHash: context.contextHash,
        expiresAt: Math.min(interaction.exp * 1000, Date.now() + 300000),
        requireFreshAuthentication:
          String(interaction.params.prompt ?? "")
            .split(" ")
            .includes("login") || interaction.params.max_age !== undefined,
      });
      const entry = `/?mcp_login=${encodeURIComponent(handle)}&reauth=1`;
      loginEntry = `<div class="actions"><a class="button" href="${entry}">Войти или зарегистрироваться в Telegram MCP</a></div><p class="help">После входа вы вернётесь к подтверждению доступа. Telegram повторно подключать не нужно.</p>`;
    }
    const legacyFields =
      prompt === "login" && !useSession && !options.cabinetLogin
        ? `${identity.kind === "saas" ? '<label>Логин Telegram MCP<input name="login" autocomplete="username" required maxlength="32"></label>' : ""}<label>${identity.kind === "saas" ? "Пароль Telegram MCP" : "Пароль владельца"}<input type="password" name="password" autocomplete="current-password" required maxlength="1024"></label>`
        : "";
    const formCsrf =
      useSession && browser
        ? sessionCsrf(interaction.uid, browser)
        : csrfFor(interaction.uid, prompt, interaction.session?.accountId);
    const isConsent = prompt === "consent" && !useSession && (!options.cabinetLogin || !!browser);
    const form = `<form method="post" action="/interaction/${escapeHtml(interaction.uid)}"><input type="hidden" name="csrf" value="${formCsrf}">${useSession ? '<input type="hidden" name="use_session" value="yes">' : ""}${legacyFields}${useSession || isConsent || legacyFields ? `<button name="approve" value="yes">${isConsent ? "Разрешить доступ" : useSession ? "Продолжить с текущим аккаунтом" : "Войти"}</button>` : ""} <button name="approve" value="no">Отказать</button></form>`;
    const callback = new URL(String(interaction.params.redirect_uri ?? client?.redirectUris?.[0] ?? origin));
    const callbackSource = callback.origin === "null" ? callback.protocol : callback.origin;
    res
      .set("Referrer-Policy", "same-origin")
      .set(
        "Content-Security-Policy",
        `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callbackSource}; frame-ancestors 'none'; base-uri 'none'`,
      )
      .type("html")
      .send(
        connectionUi(req.headers.cookie).page(
          isConsent ? "Разрешить доступ к Telegram?" : useSession ? "Продолжить подключение" : "Подключить AI-клиент",
          isConsent
            ? "Проверьте, какой клиент получает доступ и какие действия ему разрешены."
            : "Используйте свой аккаунт Telegram MCP, чтобы подключить клиент.",
          `<div class="access"><span class="accessLabel">Клиент</span><strong class="clientName">${escapeHtml(client?.clientName ?? client?.clientId)}</strong><p class="permission"><span class="accessLabel">Разрешение</span>${escapeHtml(identity.describeAccess(browser?.accountId ?? interaction.session?.accountId))}</p></div>${loginEntry}${form}<p class="hint">Доступ можно отозвать в разделе «Подключённые клиенты» кабинета.</p>`,
        ),
      );
  });
  app.post(
    "/interaction/:uid",
    rateLimit({ windowMs: 900000, limit: 20, standardHeaders: "draft-8", legacyHeaders: false }),
    express.urlencoded({ extended: false, limit: "8kb" }),
    async (req, res) => {
      if (req.headers.origin !== origin) {
        res
          .status(403)
          .type("html")
          .send(
            connectionUi(req.headers.cookie).error(
              "Обновите подключение",
              "Откройте ссылку подключения из AI-клиента заново.",
            ),
          );
        return;
      }
      const interaction = await provider.interactionDetails(req, res);
      const browser = browserFor(req, interaction);
      const useSession = req.body.use_session === "yes";
      const expectedCsrf =
        useSession && browser
          ? sessionCsrf(interaction.uid, browser)
          : csrfFor(interaction.uid, interaction.prompt.name, interaction.session?.accountId);
      if (
        req.params.uid !== interaction.uid ||
        typeof req.body.csrf !== "string" ||
        (useSession && !browser) ||
        !equal(req.body.csrf, expectedCsrf)
      ) {
        res
          .status(403)
          .type("html")
          .send(
            connectionUi(req.headers.cookie).error(
              "Обновите подтверждение",
              "Подтверждение устарело. Проверьте актуальные права перед подключением клиента.",
              `/interaction/${interaction.uid}`,
              "Вернуться к подтверждению",
            ),
          );
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
      if (useSession && browser) {
        await provider.interactionFinished(
          req,
          res,
          {
            login: {
              accountId: browser.accountId,
              remember: true,
              acr: browser.binding,
              ts: Math.floor(browser.authenticatedAt / 1000),
            },
          },
          { mergeWithLastSubmission: false },
        );
        return;
      }
      if (interaction.prompt.name === "login") {
        if (options.cabinetLogin) {
          res
            .status(401)
            .type("html")
            .send(
              connectionUi(req.headers.cookie).error(
                "Войдите в Telegram MCP",
                "Войдите в кабинет и начните подключение клиента заново.",
              ),
            );
          return;
        }
        const accountId =
          typeof req.body.password === "string"
            ? await identity.authenticate({
                login: typeof req.body.login === "string" ? req.body.login : undefined,
                password: req.body.password,
              })
            : undefined;
        if (!accountId) {
          res
            .status(401)
            .type("html")
            .send(
              connectionUi(req.headers.cookie).error(
                "Неверные данные для входа",
                "Проверьте логин и пароль и попробуйте ещё раз.",
                `/interaction/${interaction.uid}`,
                "Вернуться ко входу",
              ),
            );
          return;
        }
        await provider.interactionFinished(
          req,
          res,
          { login: { accountId, remember: true, acr: identity.authenticationBinding?.(accountId) } },
          { mergeWithLastSubmission: false },
        );
      } else if (interaction.prompt.name === "consent") {
        const accountId = interaction.session?.accountId;
        if (!accountId || !identity.isActive(accountId) || (options.cabinetLogin && browser?.accountId !== accountId)) {
          res
            .status(403)
            .type("html")
            .send(
              connectionUi(req.headers.cookie).error(
                "Войдите в свой аккаунт",
                "Аккаунт изменился или вход истёк. Начните подключение клиента заново.",
              ),
            );
          return;
        }
        const grant =
          interaction.grantId && identity.isGrantValid(accountId, interaction.grantId)
            ? await provider.Grant.find(interaction.grantId)
            : new provider.Grant({ accountId, clientId: String(interaction.params.client_id) });
        if (!grant) {
          res
            .status(400)
            .type("html")
            .send(
              connectionUi(req.headers.cookie).error(
                "Не удалось подтвердить доступ",
                "Начните подключение клиента заново и проверьте разрешения.",
              ),
            );
          return;
        }
        const details = interaction.prompt.details;
        if (details.missingOIDCScope) grant.addOIDCScope(details.missingOIDCScope as string[]);
        if (details.missingOIDCClaims) grant.addOIDCClaims(details.missingOIDCClaims as string[]);
        for (const [target, scopes] of Object.entries(
          (details.missingResourceScopes ?? {}) as Record<string, string[]>,
        )) {
          if (target !== resource) {
            res
              .status(400)
              .type("html")
              .send(
                connectionUi(req.headers.cookie).error(
                  "Не удалось подтвердить доступ",
                  "Начните подключение клиента заново и проверьте разрешения.",
                ),
              );
            return;
          }
          grant.addResourceScope(target, scopes);
        }
        const grantId = await grant.save();
        identity.bindGrant(accountId, grantId, String(interaction.params.client_id));
        await provider.interactionFinished(req, res, { consent: { grantId } }, { mergeWithLastSubmission: true });
      } else {
        res
          .status(400)
          .type("html")
          .send(
            connectionUi(req.headers.cookie).error(
              "Не удалось подтвердить доступ",
              "Начните подключение клиента заново и проверьте разрешения.",
            ),
          );
      }
    },
  );
  app.use("/oauth", provider.callback());
  uploads.mount(app);
  const challenge = `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`;
  const anonymousMcpLimit = rateLimit({
    windowMs: 60000,
    limit: 120,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  });
  app.all(
    "/mcp",
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
        anonymousMcpLimit(req, res, () => {
          res.set("WWW-Authenticate", challenge).status(401).json({ error: "invalid_token" });
        });
        return;
      }
      res.locals.mcpIdentity = { accountId: token.accountId, grantId: token.grantId };
      next();
    },
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: "draft-8",
      legacyHeaders: false,
      keyGenerator: (_req, res) => res.locals.mcpIdentity.accountId,
    }),
    express.json({ limit: "1mb" }),
    async (req, res) => {
      await mcpHandler(req, res);
    },
  );
  const onError: ErrorRequestHandler = (error, req, res, _next) => {
    if (res.headersSent) {
      res.end();
      return;
    }
    const status = error?.type === "entity.too.large" ? 413 : 400;
    if (req.path.startsWith("/interaction/")) {
      res
        .status(status)
        .type("html")
        .send(
          connectionUi(req.headers.cookie).error(
            "Ссылка подключения устарела",
            "Вернитесь в AI-клиент и начните подключение заново. Ваш аккаунт и Telegram-сессия сохранены.",
          ),
        );
      return;
    }
    res.status(status).json({ error: "Request rejected" });
  };
  app.use(onError);
  return {
    app,
    stopUploads: () => uploads.close(),
    clientName: async (id: string) => (await provider.Client.find(id))?.clientName,
    revokeGrants: async (ids: string[]) => {
      for (const id of ids) {
        const grant = await provider.Grant.find(id);
        if (grant) await grant.destroy();
        await new Adapter("AccessToken").revokeByGrantId(id);
      }
    },
    close: async () => {
      uploads.close();
      Adapter.close();
    },
  };
}
