import { isAbsolute } from "node:path";
import express from "express";

const RESERVED_ROUTES = ["/api", "/oauth", "/interaction", "/mcp", "/.well-known", "/healthz"];
export function mountSaasFrontend(app: express.Express, options: { root: string; origin: string; csp: string }): void {
  if (!isAbsolute(options.root) || new URL(options.origin).protocol !== "https:" || /[\r\n]/.test(options.csp))
    throw new Error("Invalid frontend configuration");
  app.use((req, res, next) => {
    let path: string;
    try {
      path = decodeURIComponent(req.path);
    } catch {
      res.status(400).json({ error: "invalid-path" });
      return;
    }
    if (RESERVED_ROUTES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      res.status(404).json({ error: "not-found" });
      return;
    }
    res.set({
      "Content-Security-Policy": `${options.csp}; frame-ancestors 'none'`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });
  app.use(
    express.static(options.root, {
      dotfiles: "deny",
      index: "index.html",
      redirect: false,
      setHeaders(res, path) {
        if (/[\\/]assets[\\/][^\\/]+-[\w-]{8,}\.(?:js|css|woff2?|svg|png|jpe?g|json|wasm)$/.test(path))
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        else res.setHeader("Cache-Control", "no-store");
      },
    }),
  );
  app.use((req, res) => {
    if ((req.method === "GET" || req.method === "HEAD") && !req.path.includes(".") && req.accepts("html"))
      res.sendFile("index.html", { root: options.root });
    else res.status(404).json({ error: "not-found" });
  });
}
