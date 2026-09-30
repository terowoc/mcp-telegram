import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { createHttpGateway } from "../http/gateway.js";
import { hashPassword } from "../http/owner.js";

describe("authenticated HTTPS gateway contract", () => {
  const publicUrl = "https://mcp.example.test";
  const password = "a long private owner test password";
  let dir: string;
  let server: Server;
  let gateway: Awaited<ReturnType<typeof createHttpGateway>>;
  let base: string;
  const cookies = new Map<string, string>();

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("host", "mcp.example.test");
    headers.set("x-forwarded-proto", "https");
    if (!headers.has("cookie")) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    const response = await new Promise<Response>((resolve, reject) => {
      const req = httpRequest(
        base + path,
        { method: init.method ?? "GET", headers: Object.fromEntries(headers) },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) => chunks.push(chunk));
          incoming.on("end", () => {
            const resultHeaders = new Headers();
            for (let i = 0; i < incoming.rawHeaders.length; i += 2)
              resultHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
            resolve(new Response(Buffer.concat(chunks), { status: incoming.statusCode, headers: resultHeaders }));
          });
        },
      );
      req.on("error", reject);
      req.end(init.body?.toString());
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const eq = pair.indexOf("=");
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return response;
  }

  const json = (value: unknown): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  });
  const form = (value: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: publicUrl },
    body: new URLSearchParams(value),
  });

  async function start() {
    gateway = await createHttpGateway({
      publicUrl,
      storageDir: dir,
      ownerPasswordHash: await hashPassword(password),
      version: "test",
      callTool: async (name) => ({ content: [{ type: "text", text: `executed ${name}` }] }),
    });
    server = gateway.app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-http-gateway-"));
    await start();
  });
  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.close();
    await rm(dir, { recursive: true, force: true });
  });

  it("advertises canonical resource/issuer, rejects unauthenticated access and hostile origins", async () => {
    const metadata = await (await request("/.well-known/oauth-protected-resource/mcp")).json();
    assert.equal(metadata.resource, `${publicUrl}/mcp`);
    assert.deepEqual(metadata.authorization_servers, [`${publicUrl}/oauth`]);
    const unauthorized = await request("/mcp", json({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    assert.equal(unauthorized.status, 401);
    assert.match(unauthorized.headers.get("www-authenticate") ?? "", /oauth-protected-resource/);
    assert.equal((await request("/mcp", { headers: { origin: "https://attacker.invalid" } })).status, 403);
    const health = await (await request("/healthz")).json();
    assert.equal(health.status, "ok");
    assert.equal("username" in health, false);
  });

  async function authorize() {
    const registration = await request(
      "/oauth/reg",
      json({
        client_name: "Test <script>alert(1)</script>",
        redirect_uris: ["https://client.example/callback"],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
    assert.equal(registration.status, 201, await registration.clone().text());
    const client = await registration.json();
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const params = new URLSearchParams({
      client_id: client.client_id,
      redirect_uri: "https://client.example/callback",
      response_type: "code",
      scope: "mcp:tools",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: `${publicUrl}/mcp`,
      state: "state",
    });
    let response = await request(`/oauth/auth?${params}`);
    for (let step = 0; step < 12; step++) {
      const location = response.headers.get("location");
      if (location?.startsWith("https://client.example/callback")) {
        const target = new URL(location);
        assert.equal(target.searchParams.get("state"), "state");
        assert.ok(target.searchParams.get("code"), location);
        return { client, verifier, code: target.searchParams.get("code") as string };
      }
      assert.ok(location, await response.text());
      const path = new URL(location, publicUrl).pathname + new URL(location, publicUrl).search;
      response = await request(path);
      if (response.status === 200 && path.startsWith("/interaction/")) {
        const html = await response.text();
        assert.equal(html.includes("<script>alert(1)</script>"), false);
        const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
        assert.ok(csrf, html);
        const action = /action="([^"]+)"/.exec(html)?.[1];
        assert.ok(action);
        const badCsrf = await request(action, form({ csrf: "invalid", password }));
        assert.equal(badCsrf.status, 403);
        response = await request(action, form({ csrf, password, approve: "yes" }));
      }
    }
    throw new Error("OAuth flow did not finish");
  }

  it("requires PKCE, grants tools only after owner consent, rotates refresh and revokes access", async () => {
    const { client, verifier, code } = await authorize();
    const values = {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      code_verifier: verifier,
      redirect_uri: "https://client.example/callback",
      resource: `${publicUrl}/mcp`,
    };
    const wrong = await request("/oauth/token", form({ ...values, code_verifier: "z".repeat(43) }));
    assert.equal(wrong.status, 400);
    // Obtain a fresh code: failed redemption may invalidate the original code.
    const fresh = await authorize();
    const redeemed = await request(
      "/oauth/token",
      form({ ...values, client_id: fresh.client.client_id, code: fresh.code, code_verifier: fresh.verifier }),
    );
    assert.equal(redeemed.status, 200, await redeemed.clone().text());
    const tokens = await redeemed.json();
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    const mcpHeaders = {
      authorization: `Bearer ${tokens.access_token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    };
    const list = await request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    assert.equal(list.status, 200, await list.clone().text());
    const tools = await list.json();
    assert.ok(tools.result.tools.some((tool: { name: string }) => tool.name === "telegram-status"));
    const batch = await request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 20, method: "tools/call", params: { name: "telegram-status", arguments: {} } },
        { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "telegram-status", arguments: {} } },
      ]),
    });
    assert.equal(batch.status, 400);
    const longId = await request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "x".repeat(8192),
        method: "tools/call",
        params: { name: "telegram-status", arguments: {} },
      }),
    });
    assert.equal(longId.status, 400);
    const call = await request("/mcp", {
      method: "POST",
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "telegram-status", arguments: {} },
      }),
    });
    assert.match(JSON.stringify(await call.json()), /executed telegram-status/);
    const reused = await request(
      "/oauth/token",
      form({ ...values, client_id: fresh.client.client_id, code: fresh.code, code_verifier: fresh.verifier }),
    );
    assert.equal(reused.status, 400);
    // Code reuse can revoke the grant; get another grant for refresh/revocation checks.
    const third = await authorize();
    const thirdTokens = await (
      await request(
        "/oauth/token",
        form({ ...values, client_id: third.client.client_id, code: third.code, code_verifier: third.verifier }),
      )
    ).json();
    const refreshed = await request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: third.client.client_id,
        refresh_token: thirdTokens.refresh_token,
        resource: `${publicUrl}/mcp`,
      }),
    );
    assert.equal(refreshed.status, 200, await refreshed.clone().text());
    const next = await refreshed.json();
    assert.notEqual(next.refresh_token, thirdTokens.refresh_token);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await gateway.close();
    await start();
    const persisted = await request("/mcp", {
      method: "POST",
      headers: { ...mcpHeaders, authorization: `Bearer ${next.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
    });
    assert.equal(persisted.status, 200, await persisted.clone().text());
    const revoke = await request(
      "/oauth/token/revocation",
      form({ client_id: third.client.client_id, token: next.access_token, token_type_hint: "access_token" }),
    );
    assert.equal(revoke.status, 200);
    assert.equal((await request("/mcp", { headers: { authorization: `Bearer ${next.access_token}` } })).status, 401);
    const replay = await request(
      "/oauth/token",
      form({
        grant_type: "refresh_token",
        client_id: third.client.client_id,
        refresh_token: thirdTokens.refresh_token,
        resource: `${publicUrl}/mcp`,
      }),
    );
    assert.equal(replay.status, 400);
  });

  it("rejects resource/redirect mismatches, missing PKCE, and expired persisted tokens", async () => {
    const issued = await authorize();
    const values = {
      grant_type: "authorization_code",
      client_id: issued.client.client_id,
      code: issued.code,
      code_verifier: issued.verifier,
      redirect_uri: "https://client.example/callback",
      resource: `${publicUrl}/mcp`,
    };
    const wrongRedirect = await request(
      "/oauth/token",
      form({ ...values, redirect_uri: "https://attacker.invalid/callback" }),
    );
    assert.equal(wrongRedirect.status, 400);
    const params = new URLSearchParams({
      client_id: issued.client.client_id,
      redirect_uri: values.redirect_uri,
      response_type: "code",
      scope: "mcp:tools",
      resource: values.resource,
    });
    const missing = await request(`/oauth/auth?${params}`);
    assert.match(missing.headers.get("location") ?? (await missing.text()), /invalid_request/);
    params.set("code_challenge", createHash("sha256").update(issued.verifier).digest("base64url"));
    params.set("code_challenge_method", "S256");
    params.set("resource", "https://attacker.invalid/mcp");
    const wrongResource = await request(`/oauth/auth?${params}`);
    assert.match(wrongResource.headers.get("location") ?? (await wrongResource.text()), /invalid_target/);
    const fresh = await authorize();
    const response = await request(
      "/oauth/token",
      form({ ...values, client_id: fresh.client.client_id, code: fresh.code, code_verifier: fresh.verifier }),
    );
    assert.equal(response.status, 200);
    const tokens = await response.json();
    const db = new DatabaseSync(join(dir, "oauth.sqlite"));
    db.prepare("UPDATE oauth SET expires=0 WHERE model='AccessToken'").run();
    db.close();
    assert.equal((await request("/mcp", { headers: { authorization: `Bearer ${tokens.access_token}` } })).status, 401);
  });
});
