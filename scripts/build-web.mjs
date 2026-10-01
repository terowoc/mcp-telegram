import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function frontendBuildEnv(mode, input = process.env) {
  if (!["production", "dev"].includes(mode)) throw new Error("Unknown dashboard mode");
  const env = {};
  for (const key of ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "SYSTEMROOT", "SystemRoot"])
    if (input[key] !== undefined) env[key] = input[key];
  return env;
}

async function build(mode, validateOnly) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const env = frontendBuildEnv(mode);
  const input = resolve(root, "apps/dashboard");
  await readFile(resolve(input, "index.html"));
  if (validateOnly) {
    console.log("Telegram MCP dashboard: no browser Telegram credentials required");
    return;
  }
  const output = resolve(input, "dist");
  await rm(output, { recursive: true, force: true });
  const result = spawnSync(
    process.execPath,
    [resolve(root, "node_modules/typescript/bin/tsc"), "-p", resolve(input, "tsconfig.json")],
    { cwd: root, env, stdio: "inherit" },
  );
  if (result.status !== 0) throw new Error("Dashboard TypeScript build failed");
  await mkdir(resolve(output, "assets"), { recursive: true });
  const replacements = {};
  for (const file of ["api.js", "retire-client.js", "style.css", "logo.svg", "app.js"]) {
    let data = await readFile(resolve(file.endsWith(".js") ? output : input, file));
    if (file === "app.js") {
      let code = data.toString("utf8");
      for (const dependency of ["api.js", "retire-client.js"])
        code = code.replaceAll(`./${dependency}`, `./${replacements[dependency]}`);
      code = code.replaceAll("/assets/logo.svg", `/assets/${replacements["logo.svg"]}`);
      data = Buffer.from(code);
    }
    const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
    const name = file.replace(/\.(js|css|svg)$/, `-${hash}.$1`);
    replacements[file] = name;
    await writeFile(resolve(output, "assets", name), data);
    if (file.endsWith(".js")) await rm(resolve(output, file));
  }
  let html = await readFile(resolve(input, "index.html"), "utf8");
  for (const [file, name] of Object.entries(replacements)) html = html.replaceAll(`/assets/${file}`, `/assets/${name}`);
  await writeFile(resolve(output, "index.html"), html);
  await writeFile(resolve(output, "retire-worker.js"), await readFile(resolve(input, "retire-worker.js")));
  console.log("Built Telegram MCP dashboard (same-origin API only)");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  build(process.argv[2] || "production", process.argv.includes("--validate")).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
