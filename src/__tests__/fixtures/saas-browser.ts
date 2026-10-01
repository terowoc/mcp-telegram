import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startSaas } from "../../saas/main.js";

const root = await mkdtemp(join(tmpdir(), "saas-browser-"));
const key = join(root, "key");
await writeFile(key, randomBytes(32), { mode: 0o600 });
const service = await startSaas(
  {
    publicUrl: "https://localhost",
    authDir: join(root, "auth"),
    sessionKeyFile: key,
    filesRoot: join(root, "files"),
    apiId: 1,
    apiHash: "11111111111111111111111111111111",
    version: "fixture",
  },
  {
    spawn: (_file, args, options) => fork(new URL("./saas-browser-worker.mjs", import.meta.url), args, options),
  },
);
const server = service.app.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (typeof address === "object" && address) process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});
async function close() {
  await service.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
process.once("SIGTERM", () => {
  void close().then(() => process.exit(0));
});
