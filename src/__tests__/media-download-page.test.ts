import assert from "node:assert/strict";
import { test } from "node:test";
import { createContext, runInContext } from "node:vm";
import { DOWNLOAD_SCRIPT } from "../http/media-download-page.js";

for (const [name, preparing] of [
  ["отчёт.pdf", false],
  ['report "draft".pdf', false],
  ["лекция.mp4", true],
] as const)
  test(`browser page preserves filename ${name} and keeps the capability in a header${preparing ? " while the file is still preparing" : ""}`, async () => {
    let click: (() => Promise<void>) | undefined;
    let cleared = false,
      saved = 0;
    const anchor = {
      href: "",
      download: "",
      className: "",
      textContent: "",
      click: () => {
        saved++;
      },
    };
    const button = {
      disabled: false,
      addEventListener: (_event: string, action: () => Promise<void>) => {
        click = action;
      },
      replaceWith: (value: unknown) => assert.equal(value, anchor),
    };
    const shown: string[] = [];
    const status = {
      set textContent(text: string) {
        shown.push(text);
      },
      get textContent() {
        return shown.at(-1) ?? "";
      },
    };
    let polls = 0;
    const bytes = Buffer.from("file bytes"),
      token = "a".repeat(43);
    const urls = {
      createObjectURL: (blob: Blob) => {
        assert.equal(blob.size, bytes.length);
        return "blob:test";
      },
      revokeObjectURL: () => {},
    };
    const context = createContext({
      document: {
        querySelector: (selector: string) => (selector === "#download" ? button : status),
        createElement: () => anchor,
      },
      location: { hash: `#token=${token}`, pathname: "/media/downloads/11111111-1111-4111-8111-111111111111" },
      history: {
        replaceState: (_state: unknown, _title: string, path: string) => {
          assert.doesNotMatch(path, /token/);
          cleared = true;
        },
      },
      URLSearchParams,
      URL: urls,
      AbortSignal,
      Response,
      TransformStream,
      setTimeout: (resolve: () => void) => resolve(),
      window: { addEventListener: () => {} },
      fetch: async (path: string, options: { headers: { Authorization: string }; cache: string }) => {
        assert.equal(cleared, true);
        assert.doesNotMatch(path, /token|#/);
        assert.equal(options.headers.Authorization, `Bearer ${token}`);
        assert.equal(options.cache, "no-store");
        if (preparing && polls++ < 2) {
          return Response.json({ status: "preparing", receivedBytes: 3 * 1048576 }, { status: 202 });
        }
        return new Response(bytes, {
          headers: {
            "Content-Length": String(bytes.length),
            "Content-Disposition": name.includes('"')
              ? "attachment; filename=" + JSON.stringify(name)
              : `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          },
        });
      },
    });
    runInContext(DOWNLOAD_SCRIPT, context);
    assert.ok(click);
    await click();
    assert.equal(anchor.download, name);
    assert.equal(saved, 1);
    assert.equal(anchor.href, "blob:test");
    assert.match(status.textContent, /Файл готов/);
    assert.ok(
      shown.some((text) => /Скачивается: 0\.0 МБ из 0\.0 МБ/.test(text)),
      "progress is counted while the bytes stream",
    );
    if (preparing) assert.equal(polls, 3, "polled while preparing, then downloaded");
  });

test("a link without its private fragment cannot trigger a browser download", () => {
  const button = {
    disabled: false,
    addEventListener: () => {
      throw new Error("Missing tokens cannot initiate downloads");
    },
  };
  const status = { textContent: "" };
  runInContext(
    DOWNLOAD_SCRIPT,
    createContext({
      document: { querySelector: (selector: string) => (selector === "#download" ? button : status) },
      location: { hash: "", pathname: "/media/downloads/id" },
      history: { replaceState: () => {} },
      URLSearchParams,
    }),
  );
  assert.equal(button.disabled, true);
  assert.match(status.textContent, /полную ссылку/);
});
