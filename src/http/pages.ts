const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

// Content is trusted server markup; user/client values must be escaped by the caller.
export function connectionPage(
  title: string,
  description: string,
  content: string,
  theme: "system" | "light" | "dark" = "system",
): string {
  return `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#1674ad"><title>${escapeHtml(title)} — Telegram MCP</title><style>
:root{font:16px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--bg:#edf4f3;--surface:#fff;--soft:#f4f8fb;--text:#1c2c3a;--muted:#526b7a;--line:#dce6ec;--blue:#1674ad;color-scheme:light}
*{box-sizing:border-box}body{margin:0;color:var(--text);background:var(--bg);min-height:100dvh;display:grid;place-items:center;padding:2rem 1rem}main{width:100%;max-width:32rem}a{color:var(--blue)}.brand{display:flex;align-items:center;gap:.7rem;margin:0 0 1.5rem;font-weight:650;font-size:1.1rem}.mark{display:grid;place-items:center;border-radius:50%;background:#1674ad;color:white;width:2.7rem;height:2.7rem;font-size:1.5rem}.badge{margin-left:auto;padding:.3rem .6rem;border-radius:1rem;background:var(--surface);font-size:.75rem;color:var(--muted)}.panel{background:var(--surface);border:1px solid var(--line);border-radius:1.25rem;padding:2rem;box-shadow:0 12px 40px #1c2c3a08}h1{font-size:1.7rem;line-height:1.25;letter-spacing:-.03em;margin:0 0 .8rem}p{line-height:1.6;margin:.7rem 0;color:var(--muted)}.eyebrow{font-size:.7rem;font-weight:700;letter-spacing:.12em;color:var(--blue);margin-bottom:1rem}.access{border:1px solid var(--line);background:var(--soft);border-radius:.85rem;padding:1rem;margin:1.4rem 0;overflow-wrap:anywhere}.access p{margin:.4rem 0}.access strong{color:var(--text)}.accessLabel{font-size:.75rem;color:var(--muted);display:block;margin-bottom:.35rem}.clientName{font-size:1.05rem}.actions,form{margin-top:1.5rem}form{display:flex;flex-wrap:wrap;gap:.75rem}label{display:block;flex-basis:100%;font-size:.9rem;font-weight:600}input:not([type=hidden]){display:block;width:100%;padding:.9rem;border:1px solid var(--line);background:var(--surface);color:var(--text);border-radius:.65rem;font:inherit;margin:.5rem 0}button,.button{min-height:2.75rem;display:inline-flex;align-items:center;justify-content:center;padding:.8rem 1rem;border-radius:.65rem;border:0;font:600 .9rem -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-decoration:none;cursor:pointer}button[value=yes],.button{color:#fff;background:#1674ad;flex:1}button[value=no]{color:var(--blue);background:var(--soft)}button:hover,.button:hover{filter:brightness(.94)}:focus-visible{outline:3px solid var(--blue);outline-offset:3px}.foot{text-align:center;font-size:.75rem;margin-top:1.5rem}.help{font-size:.85rem}.actions .button{width:100%}.permission{font-size:.9rem}.hint{border-left:3px solid var(--blue);padding-left:.8rem;font-size:.85rem}
:root[data-theme="dark"]{--bg:#0e1821;--surface:#17212b;--soft:#202e3b;--text:#e9f0f5;--muted:#a3b4c3;--line:#31424f;--blue:#72bfff;color-scheme:dark}
@media(prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#0e1821;--surface:#17212b;--soft:#202e3b;--text:#e9f0f5;--muted:#a3b4c3;--line:#31424f;--blue:#72bfff;color-scheme:dark}}
@media(max-width:480px){.brand{font-size:1rem;gap:.5rem}.mark{width:2.25rem;height:2.25rem}.badge{font-size:.65rem;white-space:nowrap}body{padding:1.2rem .9rem}.panel{padding:1.4rem}h1{font-size:1.45rem}form{flex-direction:column}button{width:100%}}
</style></head><body><main><div class="brand"><span class="mark" aria-hidden="true">➤</span>Telegram MCP<span class="badge">Подключение AI</span></div><section class="panel"><div class="eyebrow">ВАШ TELEGRAM. В ВАШЕМ AI.</div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(description)}</p>${content}</section><p class="foot">Одна серверная сессия · Доступ под вашим контролем</p></main></body></html>`;
}

export function connectionError(
  title: string,
  description: string,
  href = "/",
  label = "Открыть кабинет",
  theme: "system" | "light" | "dark" = "system",
): string {
  return connectionPage(
    title,
    description,
    `<div class="actions"><a class="button" href="${escapeHtml(href)}">${escapeHtml(label)}</a></div><p class="help">Начните подключение заново в AI-клиенте, если ссылка больше не действует.</p>`,
    theme,
  );
}

export function connectionUi(cookie: string | undefined) {
  const preference = /(?:^|;\s*)mcp-ui-theme=(light|dark)(?:;|$)/.exec(cookie ?? "")?.[1];
  const theme = preference === "light" || preference === "dark" ? preference : "system";
  return {
    page: (title: string, description: string, content: string) => connectionPage(title, description, content, theme),
    error: (title: string, description: string, href?: string, label?: string) =>
      connectionError(title, description, href, label, theme),
  };
}
