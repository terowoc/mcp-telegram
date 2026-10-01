# Telegram MCP dashboard

The public app is a Telegram-style MCP cabinet. It provides registration, recovery codes, a server QR + 2FA Telegram connection, MCP endpoint/configuration information, access policy, client revocation, logout and account deletion. It has no chat reader, composer, browser MTProto or Telegram session.

```sh
npm ci
npm run web:build
npm run web:check
npm run web:dev
```

The source is in `apps/dashboard`; production output is `apps/dashboard/dist`. The build uses the existing root TypeScript compiler, copies local CSS/SVG and fingerprints assets. No browser Telegram credentials or environment files are embedded. `web:dev` previews static files on localhost:1234; API flows require a local backend or an isolated fixture.

Production serves the dashboard from the same HTTPS origin as the SaaS API and OAuth. CSP limits connections to that origin and forbids browser workers. No service worker is installed. Previous Telegram Web worker URLs serve a one-time retirement script; old client caches and browser credentials are cleared when users load the cabinet.
