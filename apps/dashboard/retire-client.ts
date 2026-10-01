// Retire only this origin's former Telegram Web caches and browser credentials.
export async function retireTelegramClient(): Promise<void> {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations().catch(() => []);
    await Promise.all(
      registrations
        .filter((registration) => /\/service\.worker-[\w-]+\.js$/.test(registration.active?.scriptURL ?? ""))
        .map((registration) => registration.unregister()),
    );
  }
  if ("caches" in window) {
    const names = await caches.keys().catch(() => []);
    await Promise.all(names.filter((name) => name.startsWith("tt-")).map((name) => caches.delete(name)));
  }
  for (const storage of [localStorage, sessionStorage]) {
    for (const key of Object.keys(storage)) {
      if (/^(?:tt-|GramJs:|account\d+$|dc\d+_|user_auth$|dc$|sessionsVault_|globalsVault_)/.test(key))
        storage.removeItem(key);
    }
  }
  for (const name of ["tt-passcode", "tt-data"]) {
    const deletion = indexedDB.deleteDatabase(name);
    deletion.onerror = () => {};
  }
}
