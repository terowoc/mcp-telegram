// One-time replacement for former Telegram Web service worker URLs.
self.addEventListener("install", (event) => event.waitUntil(self.skipWaiting()));
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) if (name.startsWith("tt-")) await caches.delete(name);
      await self.clients.claim();
      for (const client of await self.clients.matchAll({ type: "window" })) {
        const url = new URL(client.url);
        if (url.origin === self.location.origin) await client.navigate("/" + url.search);
      }
      await self.registration.unregister();
    })(),
  ),
);
