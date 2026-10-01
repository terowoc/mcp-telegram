import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { transformSync } from "esbuild";

// Execute the actual dashboard modules. Only browser/network boundaries are replaced;
// state transitions, rendering, API error parsing, and event handlers remain real.
export async function dashboard(
  respond: (path: string, method: string, body: Record<string, string> | undefined) => Promise<Response> | Response,
) {
  const events = new Map<string, (event: unknown) => void>();
  const windowEvents = new Map<string, () => void>();
  const timers = new Map<number, () => void>();
  let sequence = 0;
  const app = {
    innerHTML: "",
    addEventListener: (name: string, callback: (event: unknown) => void) => events.set(name, callback),
  };
  const setTimer = (callback: () => void) => {
    timers.set(++sequence, callback);
    return sequence;
  };
  const context = createContext({
    document: { querySelector: () => app, hidden: false },
    location: { search: "", assign: () => {} },
    navigator: {},
    localStorage: {},
    sessionStorage: {},
    indexedDB: { deleteDatabase: () => ({}) },
    URLSearchParams,
    AbortSignal,
    Response,
    FormData: class {
      constructor(private form: { values: Record<string, string> }) {}
      get(key: string) {
        return this.form.values[key];
      }
    },
    confirm: () => true,
    clearTimeout: (id: number) => timers.delete(id),
    setTimeout: setTimer,
    window: { setTimeout: setTimer, addEventListener: (name: string, cb: () => void) => windowEvents.set(name, cb) },
    fetch: (url: string, init: RequestInit) =>
      respond(
        url.slice("/api/saas".length),
        init.method ?? "GET",
        init.body ? JSON.parse(String(init.body)) : undefined,
      ),
  });
  const modules = new Map<string, unknown>();
  function load(name: string): unknown {
    if (modules.has(name)) return modules.get(name);
    const path = new URL(`../../../apps/dashboard/${name.replace(/\.js$/, ".ts")}`, import.meta.url);
    const code = transformSync(readFileSync(path, "utf8"), { loader: "ts", format: "cjs", target: "es2022" }).code;
    const module = { exports: {} };
    const execute = runInContext(`(function(require, module, exports) { ${code}\n})`, context);
    execute((dependency: string) => load(dependency.replace("./", "")), module, module.exports);
    modules.set(name, module.exports);
    return module.exports;
  }
  async function settle() {
    for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  load("app.js");
  await settle();
  return {
    html: () => app.innerHTML,
    settle,
    focus: async () => {
      windowEvents.get("focus")?.();
      await settle();
    },
    click: async (action: string) => {
      events.get("click")?.({ target: { closest: () => ({ dataset: { action } }) } });
      await settle();
    },
    navigate: async (page: string) => {
      events.get("click")?.({ target: { closest: () => ({ dataset: { page } }) } });
      await settle();
    },
    submit: async (id: string, values: Record<string, string>) => {
      events.get("submit")?.({ preventDefault: () => {}, target: { id, values } });
      await settle();
    },
    poll: async () => {
      const next = timers.entries().next().value;
      if (next) {
        timers.delete(next[0]);
        next[1]();
      }
      await settle();
    },
  };
}
