import { spawnSync } from "node:child_process";
import express from "express";
import { resolve } from "node:path";
const built = spawnSync(process.execPath, ["scripts/build-web.mjs", "dev"], { stdio: "inherit" });
if (built.status !== 0) process.exit(built.status ?? 1);
const app = express();
app.use(express.static(resolve("apps/dashboard/dist")));
app.listen(1234, "127.0.0.1", () =>
  console.log("Dashboard preview: http://localhost:1234 (connect a local fixture/proxy for API verification)"),
);
