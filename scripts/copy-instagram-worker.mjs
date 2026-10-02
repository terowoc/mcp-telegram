import { copyFile, mkdir } from "node:fs/promises";
await mkdir(new URL("../dist/instagram/", import.meta.url), { recursive: true });
await copyFile(new URL("../src/instagram/worker.py", import.meta.url), new URL("../dist/instagram/worker.py", import.meta.url));
