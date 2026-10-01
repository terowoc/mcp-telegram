import { ApiError, type Attempt, type Cabinet, type Client, request } from "./api.js";
import { retireTelegramClient } from "./retire-client.js";

type Page = "mcp" | "telegram" | "access" | "clients" | "account";
type AuthMode = "register" | "login" | "recover";
const app = document.querySelector<HTMLDivElement>("#app")!;
const nav: [Page, string, string][] = [
  ["mcp", "MCP", "◇"],
  ["telegram", "Telegram", "➤"],
  ["access", "Права доступа", "◈"],
  ["clients", "Подключённые клиенты", "▣"],
  ["account", "Аккаунт", "◎"],
];
const errors: Record<string, string> = {
  "registration-failed": "Не удалось зарегистрироваться. Проверьте логин или выберите другой.",
  "invalid-credentials": "Неверный логин или пароль.",
  "recovery-failed": "Проверьте логин и код восстановления.",
  "rate-limited": "Слишком много попыток. Подождите и попробуйте снова.",
  capacity: "Сервер занят. Попробуйте чуть позже.",
  "origin-denied": "Обновите страницу и повторите действие.",
  "csrf-denied": "Обновите страницу и повторите действие.",
  "authentication-required": "Войдите в аккаунт снова.",
  "continuation-expired": "Подключение клиента устарело. Начните его заново в MCP-клиенте.",
  "operation-unavailable": "Операция сейчас недоступна. Обновите статус и попробуйте снова.",
  "invalid-policy": "Укажите до 100 числовых ID чатов, разделяя их запятой.",
  "attempt-not-waiting": "Telegram больше не ожидает пароль. Проверьте состояние подключения.",
  "telegram-already-connected": "Telegram уже подключён. Обновите статус кабинета.",
};
let cabinet: Cabinet | undefined;
let clients: Client[] = [];
let page: Page = "mcp";
let authMode: AuthMode = "register";
let attempt: Attempt | undefined;
let timer: number | undefined;
let recoveryCodes: string[] = [];
let message = "";
let isError = false;
let isBusy = false;
let epoch = 0;
const continuation = new URLSearchParams(location.search).get("mcp_login");
class StaleReply extends Error {}

async function accountRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const currentEpoch = epoch;
  const user = cabinet;
  if (!user) throw new StaleReply();
  const value = await request<T>(path, method, body, user.csrfToken);
  if (currentEpoch !== epoch || cabinet?.user.id !== user.user.id) throw new StaleReply();
  return value;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}
function button(label: string, action: string, kind = "primary"): string {
  return `<button type="button" class="button ${kind}" data-action="${action}" ${isBusy ? "disabled" : ""}>${label}</button>`;
}
function field(label: string, name: string, type = "text", extra = ""): string {
  return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" required ${extra}></label>`;
}
function render(): void {
  const active = cabinet?.telegram.sessionPresent;
  const notice = message
    ? `<div class="notice ${isError ? "error" : ""}" role="${isError ? "alert" : "status"}">${escapeHtml(message)}</div>`
    : "";
  if (!cabinet && recoveryCodes.length) {
    app.innerHTML = `<main class="singleRecovery">${notice}${renderRecovery()}</main>`;
    return;
  }
  if (!cabinet) {
    app.innerHTML = `<main class="authLayout"><section class="authIntro"><div class="brand"><img class="logo" src="/assets/logo.svg" alt=""><span>Telegram MCP</span><span class="freeBadge">Бесплатно</span></div><div class="authCopy"><span class="eyebrow">ВАШ TELEGRAM. В ВАШЕМ AI.</span><h1>Подключите Telegram<br>к своему AI-клиенту.</h1><p>Читайте нужные сообщения, находите информацию и управляйте доступом — через MCP.</p><div class="introSteps"><span>1. Создайте аккаунт</span><span>2. Подключите Telegram</span><span>3. Добавьте MCP в AI</span></div></div><p class="introFoot">Одна серверная сессия Telegram · OAuth · Доступ только с вашего разрешения</p></section><section class="authPanel"><div class="authBox"><div class="authMark">➤</div><h2>${authMode === "register" ? "Создать аккаунт" : authMode === "login" ? "С возвращением" : "Восстановить доступ"}</h2><p class="muted">${authMode === "register" ? "Сначала аккаунт MCP. Telegram подключите на следующем шаге." : authMode === "login" ? "Войдите в свой кабинет Telegram MCP." : "Используйте один из сохранённых кодов восстановления."}</p>${notice}<form id="authForm">${field("Логин", "login", "text", 'autocomplete="username" pattern="[A-Za-z0-9_]{3,32}" minlength="3" maxlength="32" placeholder="username"')}${authMode === "recover" ? field("Код восстановления", "recoveryCode", "text", 'autocomplete="off" maxlength="128"') : ""}${field(authMode === "recover" ? "Новый пароль" : "Пароль", "password", "password", `autocomplete="${authMode === "login" ? "current-password" : "new-password"}" minlength="16" maxlength="1024" placeholder="Минимум 16 символов"`)}<p class="fieldHint">Логин: 3–32 латинских символа, цифры или _.</p><button class="button primary wide" ${isBusy ? "disabled" : ""}>${isBusy ? "Подождите…" : authMode === "register" ? "Зарегистрироваться" : authMode === "login" ? "Войти" : "Восстановить"}</button></form><div class="authLinks">${authMode === "register" ? "Уже есть аккаунт? " + button("Войти", "auth-login", "link") : button("Создать аккаунт", "auth-register", "link")}${authMode !== "recover" ? button("Забыли пароль?", "auth-recover", "link") : button("Назад ко входу", "auth-login", "link")}</div></div><p class="authFoot">Telegram MCP — независимый сервис для подключения AI.</p></section></main>`;
    return;
  }
  const title = nav.find(([key]) => key === page)![1];
  app.innerHTML = `<div class="workspace"><aside class="sidebar"><div class="brand"><img class="logo" src="/assets/logo.svg" alt=""><span>Telegram MCP</span></div><div class="userCard"><div class="avatar">${escapeHtml(cabinet.user.login[0]?.toUpperCase() || "T")}</div><div class="userInfo"><strong>${escapeHtml(cabinet.user.login)}</strong><span>${active ? "Telegram подключён" : "Подключите Telegram"}</span></div><span class="statusDot ${active ? "online" : ""}"></span></div><nav class="navigation" aria-label="Кабинет">${nav.map(([key, label, icon]) => `<button class="navItem ${page === key ? "selected" : ""}" data-page="${key}" ${page === key ? 'aria-current="page"' : ""}><span class="navIcon">${icon}</span><span>${label}</span>${key === "telegram" ? `<span class="navDot ${active ? "online" : ""}"></span>` : ""}</button>`).join("")}</nav><div class="sidebarFoot"><div class="freePlan"><span class="planIcon">✦</span><div><strong>Бесплатный доступ</strong><span>Ваш Telegram. Ваши разрешения.</span></div></div>${button("Выйти из аккаунта", "logout", "link")}</div></aside><main class="main"><header class="topbar"><div class="topTitle"><span class="topIcon">${nav.find(([key]) => key === page)![2]}</span><div><h1>${title}</h1><p>${page === "mcp" ? "Подключение Telegram к вашим AI-клиентам" : "Telegram MCP"}</p></div></div><span class="connectionPill ${active ? "connected" : ""}">${active ? "● Подключено" : "○ Не подключено"}</span></header><div class="canvas"><div class="content"><div class="steps"><span class="done"><b>✓</b> Аккаунт</span><i></i><span class="${active ? "done" : "current"}"><b>${active ? "✓" : "2"}</b> Telegram</span><i></i><span class="${active ? "current" : ""}"><b>3</b> MCP</span></div>${notice}${recoveryCodes.length ? renderRecovery() : renderPage()}<p class="canvasFoot">Telegram MCP · Бесплатный сервис · Одна серверная сессия</p></div></div></main></div>`;
}
function renderRecovery(): string {
  return `<section class="card recoveryCard"><span class="cardIcon">◈</span><h2>Сохраните коды восстановления</h2><p class="muted">Каждый код можно использовать один раз, чтобы восстановить пароль. Сохраните их в надёжном месте: после закрытия они больше не отображаются.</p><pre class="code recoveryCodes">${escapeHtml(recoveryCodes.join("\n"))}</pre><div class="actions">${button("Скопировать коды", "copy-recovery", "secondary")}${button("Скачать .txt", "download-recovery", "secondary")}${button("Я сохранил коды", "saved-recovery")}</div></section>`;
}
function renderPage(): string {
  if (page === "telegram") return renderTelegram();
  if (page === "access") return renderAccess();
  if (page === "clients") return renderClients();
  if (page === "account") return renderAccount();
  return renderMcp();
}
function renderMcp(): string {
  if (!cabinet!.telegram.sessionPresent)
    return `<section class="hero"><div class="heroIcon">➤</div><span class="eyebrow">СЛЕДУЮЩИЙ ШАГ</span><h2>Подключите свой Telegram</h2><p>Один QR-код — и ваши AI-клиенты смогут работать с Telegram через MCP. Разрешения всегда под вашим контролем.</p>${button("Подключить Telegram", "open-telegram")}<div class="heroNotes"><span>◈ Только чтение по умолчанию</span><span>◇ OAuth для AI-клиентов</span></div></section><div class="infoGrid"><section class="card"><h3>Одна сессия</h3><p class="muted">Telegram подключается на сервере. Кабинет управляет MCP и не открывает отдельный клиент чатов.</p></section><section class="card"><h3>Ваши данные — ваш доступ</h3><p class="muted">Вы выбираете права и можете отключить любой AI-клиент в кабинете.</p></section></div>`;
  const url = cabinet!.mcpUrl;
  const config = JSON.stringify({ mcpServers: { telegram: { type: "http", url } } }, undefined, 2);
  return `<section class="welcomeBubble"><span class="welcomeCheck">✓</span><div><h2>Telegram готов к работе с AI</h2><p>Добавьте адрес MCP в своём клиенте и подтвердите доступ через OAuth.</p></div></section><section class="card"><div class="cardHeader"><div><span class="eyebrow">MCP ENDPOINT</span><h2>Ваш адрес подключения</h2></div><span class="tag">Streamable HTTP</span></div><div class="endpoint"><code>${escapeHtml(url)}</code>${button("Скопировать", "copy-url", "secondary")}</div><div class="metadata"><span>Авторизация <strong>OAuth 2.1 + PKCE</strong></span><span>Права <strong>${cabinet!.policy.profile === "read" ? "Только чтение" : "Чтение и изменение"}</strong></span><span>Чаты <strong>${cabinet!.policy.chatIds.length ? cabinet!.policy.chatIds.length + " выбрано" : "Все ваши чаты"}</strong></span></div></section><section class="card"><h2>Как подключить AI-клиент</h2><ol class="connectSteps"><li><strong>Откройте настройки MCP</strong><p>В ChatGPT, Claude или другом клиенте выберите добавление удалённого MCP-сервера.</p></li><li><strong>Вставьте адрес подключения</strong><p>Используйте URL выше и OAuth, если клиент предлагает способ авторизации.</p></li><li><strong>Подтвердите разрешения</strong><p>Войдите в этот кабинет и разрешите клиенту доступ. Повторно подключать Telegram не нужно.</p></li></ol><p class="fieldHint">Клиент должен поддерживать удалённый MCP по HTTP и OAuth. Его доступ появится в разделе «Подключённые клиенты».</p></section><div class="infoGrid"><section class="card"><div class="cardHeader"><h3>JSON конфигурация</h3>${button("Копировать", "copy-json", "link")}</div><pre class="code">${escapeHtml(config)}</pre><p class="fieldHint">Для клиентов с форматом mcpServers. Авторизацию выполните через OAuth в клиенте.</p></section><section class="card"><div class="cardHeader"><h3>Codex · TOML</h3>${button("Копировать", "copy-toml", "link")}</div><pre class="code">${escapeHtml(`[mcp_servers.telegram]\nurl = "${url}"`)}</pre><p class="fieldHint">Добавьте сервер в конфигурацию MCP и выполните вход через OAuth.</p></section></div>${continuation ? `<section class="card oauthCard"><h3>Продолжить подключение клиента</h3><p class="muted">Telegram подключён. Вернитесь к подтверждению доступа для AI-клиента.</p>${button("Продолжить", "resume-oauth")}</section>` : ""}`;
}
function renderTelegram(): string {
  if (cabinet!.telegram.sessionPresent) {
    const account = cabinet!.telegram.account;
    return `<section class="card telegramCard"><div class="telegramAvatar">➤</div><h2>Telegram подключён</h2><p class="muted">${account?.username ? "@" + escapeHtml(account.username) : "Ваш аккаунт Telegram"}${account?.id ? ` · ID ${escapeHtml(account.id)}` : ""}</p><div class="sessionInfo"><span class="statusDot online"></span><span>Одна серверная сессия для MCP</span></div><p class="muted">Все AI-клиенты используют это подключение. Вход в кабинет не создаёт новую сессию Telegram.</p><div class="actions">${button("Перейти к MCP", "open-mcp")}${button("Отключить Telegram", "disconnect", "danger")}</div></section>`;
  }
  let body = button("Показать QR-код", "start-telegram");
  if (attempt) {
    if (attempt.state === "qr")
      body = `<img class="qrImage" src="${escapeHtml(attempt.dataUrl)}" alt="QR-код для подключения Telegram"><ol class="qrInstructions"><li>Откройте Telegram на телефоне.</li><li>Настройки → Устройства → Подключить устройство.</li><li>Отсканируйте этот QR-код.</li></ol><p class="muted small">QR обновляется автоматически. Не отправляйте его другим людям.</p>${button("Отменить", "cancel-telegram", "secondary")}`;
    else if (attempt.state === "needs-password")
      body = `<form id="telegramPasswordForm">${field("Облачный пароль Telegram", "password", "password", 'autocomplete="off" maxlength="1024"')}<button class="button primary wide" ${isBusy ? "disabled" : ""}>Подтвердить</button></form><p class="muted small">Это пароль двухэтапной проверки Telegram.</p>${button("Отменить", "cancel-telegram", "secondary")}`;
    else if (["error", "expired", "cancelled"].includes(attempt.state))
      body = `<p class="notice error">${attempt.state === "expired" ? "Время подключения истекло." : "Подключение не завершено."}</p>${button("Попробовать снова", "start-telegram")}`;
    else
      body = `<div class="loadingRing" aria-label="Подключение"></div><p class="muted">Подключаем Telegram…</p>${button("Отменить", "cancel-telegram", "secondary")}`;
  }
  return `<section class="card telegramCard"><div class="telegramAvatar">➤</div><h2>Подключить Telegram</h2><p class="muted">Подтвердите подключение на телефоне. Сессия будет храниться на сервере и использоваться для MCP.</p><div class="qrBody">${body}</div></section>`;
}
function renderAccess(): string {
  return `<section class="card"><h2>Что разрешено AI-клиентам</h2><p class="muted">Эти правила действуют для всех подключённых MCP-клиентов.</p><form id="policyForm"><label class="choice"><input type="radio" name="profile" value="read" ${cabinet!.policy.profile === "read" ? "checked" : ""}><span><strong>Только чтение</strong><small>Просмотр и поиск данных. Без отправки и изменения сообщений.</small></span><span class="tag">Рекомендуется</span></label><label class="choice"><input type="radio" name="profile" value="full" ${cabinet!.policy.profile === "full" ? "checked" : ""}><span><strong>Чтение и изменение</strong><small>Также разрешает отправку сообщений и другие изменения через MCP.</small></span></label><label class="field"><span>Разрешённые чаты</span><textarea name="chatIds" rows="3" placeholder="Например: -1001234567890, 123456789">${escapeHtml(cabinet!.policy.chatIds.join(", "))}</textarea></label><p class="fieldHint">Числовые ID через запятую, до 100 чатов. Пустое поле разрешает все ваши чаты.</p><div class="notice">Изменение прав отключит текущие OAuth-доступы. Подключите AI-клиенты заново с новыми разрешениями.</div><button class="button primary" ${isBusy ? "disabled" : ""}>Сохранить права</button></form></section>`;
}
function renderClients(): string {
  return `<section class="card"><div class="cardHeader"><div><h2>Подключённые клиенты</h2><p class="muted">AI-клиенты, которым вы разрешили доступ по OAuth.</p></div>${button("Обновить", "refresh-clients", "secondary")}</div>${clients.length ? `<div class="clientList">${clients.map((client) => `<div class="clientRow"><div class="clientIcon">◇</div><div class="clientInfo"><strong>${escapeHtml(client.clientId)}</strong><span>OAuth · версия прав ${escapeHtml(client.version)}</span></div><button class="button danger" data-revoke="${escapeHtml(client.grantId)}" ${isBusy ? "disabled" : ""}>Отключить</button></div>`).join("")}</div>` : '<div class="emptyState"><span>◇</span><h3>Пока нет подключений</h3><p class="muted">Добавьте адрес MCP в AI-клиенте и разрешите доступ. Подключение появится здесь.</p></div>'}</section>`;
}
function renderAccount(): string {
  return `<section class="card"><h2>Ваш аккаунт</h2><div class="accountDetail"><span class="muted">Логин</span><strong>${escapeHtml(cabinet!.user.login)}</strong></div><div class="accountDetail"><span class="muted">Тариф</span><span class="tag">Бесплатно</span></div><p class="muted">Выход из кабинета сохраняет подключение Telegram и доступы ваших MCP-клиентов.</p>${button("Выйти из аккаунта", "logout", "secondary")}</section><section class="card dangerCard"><h3>Удалить аккаунт</h3><p class="muted">Удалятся серверная сессия Telegram, данные кабинета и доступы всех AI-клиентов.</p><form id="deleteForm">${field("Подтвердите пароль аккаунта", "password", "password", 'autocomplete="current-password" maxlength="1024"')}<button class="button danger" ${isBusy ? "disabled" : ""}>Удалить аккаунт</button></form></section>`;
}
function showError(error: unknown): void {
  if (error instanceof StaleReply) return;
  isError = true;
  message =
    error instanceof ApiError
      ? (errors[error.code] ?? "Не удалось выполнить запрос. Попробуйте снова.")
      : "Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.";
  if (error instanceof ApiError && error.status === 401 && cabinet) {
    clearAttempt();
    cabinet = undefined;
    clients = [];
    recoveryCodes = [];
    epoch++;
    authMode = "login";
  }
}
async function run(work: () => Promise<void>): Promise<void> {
  if (isBusy) return;
  const currentEpoch = epoch;
  isBusy = true;
  message = "";
  isError = false;
  render();
  try {
    await work();
  } catch (error) {
    if (currentEpoch === epoch) showError(error);
  } finally {
    isBusy = false;
    render();
  }
}
async function refresh(): Promise<void> {
  const currentEpoch = epoch;
  const value = await request<Cabinet>("/me");
  if (currentEpoch !== epoch) return;
  if (cabinet && cabinet.user.id !== value.user.id) {
    clearAttempt();
    clients = [];
    recoveryCodes = [];
    epoch++;
  }
  cabinet = value;
}
async function resumeAttempt(): Promise<void> {
  if (!cabinet || cabinet.telegram.sessionPresent || attempt) return;
  const currentEpoch = epoch;
  const userId = cabinet.user.id;
  const value = await request<{ attempt?: Attempt }>("/telegram/login");
  if (currentEpoch !== epoch || cabinet?.user.id !== userId || attempt) return;
  attempt = value.attempt;
  if (attempt) {
    const id = attempt.id;
    timer = window.setTimeout(() => void pollAttempt(id, currentEpoch), 200);
  }
}
function clearAttempt(): void {
  clearTimeout(timer);
  timer = undefined;
  attempt = undefined;
}
async function pollAttempt(id: string, currentEpoch: number): Promise<void> {
  if (!cabinet || attempt?.id !== id || currentEpoch !== epoch) return;
  if (document.hidden || isBusy) {
    timer = window.setTimeout(() => void pollAttempt(id, currentEpoch), 1500);
    return;
  }
  try {
    const value = await request<Attempt>(`/telegram/login/${id}`);
    if (attempt?.id !== id || currentEpoch !== epoch) return;
    const changed = value.state !== attempt.state || value.dataUrl !== attempt.dataUrl;
    attempt = value;
    if (value.state === "success") {
      await refresh();
      if (currentEpoch !== epoch || !cabinet || attempt?.id !== id) return;
      clearAttempt();
      page = "mcp";
      message = "Telegram подключён. Теперь добавьте MCP в свой AI-клиент.";
      isError = false;
      render();
      return;
    }
    if (changed) render();
    if (!["error", "expired", "cancelled"].includes(value.state))
      timer = window.setTimeout(() => void pollAttempt(id, currentEpoch), 1500);
  } catch (error) {
    if (currentEpoch !== epoch || attempt?.id !== id) return;
    if (error instanceof ApiError && error.status === 404) {
      clearAttempt();
      attempt = { id, state: "expired", expiresAt: Date.now() };
      try {
        await refresh();
        if (cabinet?.telegram.sessionPresent) {
          clearAttempt();
          page = "mcp";
        }
      } catch (refreshError) {
        showError(refreshError);
      }
      render();
      return;
    }
    showError(error);
    render();
    if (cabinet) timer = window.setTimeout(() => void pollAttempt(id, currentEpoch), 3000);
  }
}
async function copy(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    message = "Скопировано.";
    isError = false;
  } catch {
    message = "Не удалось скопировать. Выделите и скопируйте текст вручную.";
    isError = true;
  }
  render();
}
async function dispatchAction(action: string): Promise<void> {
  if (action.startsWith("auth-")) {
    authMode = action.slice(5) as AuthMode;
    message = "";
    render();
    return;
  }
  if (action === "copy-recovery") {
    await copy(recoveryCodes.join("\n"));
    return;
  }
  if (action === "download-recovery") {
    const url = URL.createObjectURL(new Blob([recoveryCodes.join("\n")], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "telegram-mcp-recovery.txt";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  if (action === "saved-recovery") {
    recoveryCodes = [];
    message = "";
    page = "telegram";
    if (!cabinet) authMode = "login";
    render();
    if (cabinet) await run(resumeAttempt);
    return;
  }
  if (!cabinet) return;
  if (action === "open-telegram" || action === "open-mcp") {
    page = action === "open-mcp" ? "mcp" : "telegram";
    message = "";
    render();
    return;
  }
  if (action === "copy-url") {
    await copy(cabinet.mcpUrl);
    return;
  }
  if (action === "copy-json") {
    await copy(JSON.stringify({ mcpServers: { telegram: { type: "http", url: cabinet.mcpUrl } } }, undefined, 2));
    return;
  }
  if (action === "copy-toml") {
    await copy(`[mcp_servers.telegram]\nurl = "${cabinet.mcpUrl}"`);
    return;
  }
  if (action === "disconnect" && !confirm("Отключить Telegram и отозвать доступ всех MCP-клиентов?")) return;
  await run(async () => {
    if (action === "logout") {
      await accountRequest("/logout", "POST", {});
      epoch++;
      clearAttempt();
      cabinet = undefined;
      clients = [];
      recoveryCodes = [];
      authMode = "login";
    } else if (action === "start-telegram") {
      clearAttempt();
      attempt = await accountRequest<Attempt>("/telegram/login", "POST", {});
      timer = window.setTimeout(() => void pollAttempt(attempt!.id, epoch), 200);
    } else if (action === "cancel-telegram") {
      const id = attempt?.id;
      if (id) {
        try {
          await accountRequest(`/telegram/login/${id}`, "DELETE");
        } catch (error) {
          if (!(error instanceof ApiError && error.status === 404)) throw error;
        }
      }
      clearAttempt();
      await refresh();
      if (cabinet?.telegram.sessionPresent) page = "mcp";
    } else if (action === "disconnect") {
      await accountRequest("/telegram/disconnect", "POST", {});
      clearAttempt();
      clients = [];
      await refresh();
      message = "Telegram отключён. Доступы MCP отозваны.";
    } else if (action === "refresh-clients")
      clients = (await accountRequest<{ clients: Client[] }>("/clients")).clients;
    else if (action === "resume-oauth") {
      const result = await accountRequest<{ continueTo: string }>("/oauth/resume", "POST", { continuation });
      if (/^\/interaction\/[A-Za-z0-9_-]+$/.test(result.continueTo)) location.assign(result.continueTo);
    }
  });
}
app.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!target || isBusy) return;
  if (target.dataset.page) {
    page = target.dataset.page as Page;
    message = "";
    render();
    if (page === "clients") void dispatchAction("refresh-clients");
    return;
  }
  if (target.dataset.revoke && cabinet && confirm("Отозвать доступ этого клиента?")) {
    const id = target.dataset.revoke;
    void run(async () => {
      await accountRequest(`/clients/${encodeURIComponent(id)}`, "DELETE");
      clients = clients.filter((client) => client.grantId !== id);
      message = "Доступ клиента отозван.";
    });
    return;
  }
  if (target.dataset.action) void dispatchAction(target.dataset.action);
});
app.addEventListener("submit", (event) => {
  event.preventDefault();
  if (isBusy) return;
  const form = event.target as HTMLFormElement;
  const values = new FormData(form);
  const value = (name: string) => String(values.get(name) ?? "");
  const password = value("password");
  const login = value("login");
  const recoveryCode = value("recoveryCode");
  const profile = value("profile");
  const chatIds = value("chatIds")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (form.id === "deleteForm" && !confirm("Удалить аккаунт без возможности восстановления?")) return;
  void run(async () => {
    if (form.id === "authForm") {
      if (authMode === "recover") {
        const result = await request<{ recoveryCodes: string[] }>("/recover", "POST", {
          login,
          recoveryCode,
          newPassword: password,
        });
        recoveryCodes = result.recoveryCodes;
        authMode = "login";
        message = "Пароль обновлён. Сохраните новые коды и войдите с новым паролем.";
        return;
      } else {
        const result = await request<{ recoveryCodes?: string[] }>(`/${authMode}`, "POST", { login, password });
        recoveryCodes = result.recoveryCodes ?? [];
      }
      epoch++;
      clearAttempt();
      clients = [];
      await refresh();
      page = cabinet!.telegram.sessionPresent ? "mcp" : "telegram";
      if (!recoveryCodes.length) await resumeAttempt();
    } else if (form.id === "telegramPasswordForm" && cabinet && attempt) {
      await accountRequest(`/telegram/login/${attempt.id}/password`, "POST", { password });
      attempt = { ...attempt, state: "connecting", dataUrl: undefined };
    } else if (form.id === "policyForm" && cabinet) {
      await accountRequest("/policy", "PUT", { profile, chatIds });
      clients = [];
      await refresh();
      message = "Права сохранены. Подключите AI-клиенты заново.";
    } else if (form.id === "deleteForm" && cabinet) {
      await accountRequest("/account", "DELETE", { password });
      epoch++;
      clearAttempt();
      cabinet = undefined;
      clients = [];
      recoveryCodes = [];
      authMode = "register";
      message = "Аккаунт удалён.";
    }
  });
});
window.addEventListener("focus", () => {
  if (!cabinet || isBusy || attempt || recoveryCodes.length) return;
  const currentEpoch = epoch;
  void refresh()
    .then(async () => {
      if (currentEpoch !== epoch) {
        render();
        return;
      }
      await resumeAttempt();
      render();
    })
    .catch((error) => {
      if (currentEpoch !== epoch) return;
      showError(error);
      render();
    });
});
async function start(): Promise<void> {
  await retireTelegramClient().catch(() => {});
  if (new URLSearchParams(location.search).get("reauth") === "1") {
    authMode = "login";
    render();
    return;
  }
  try {
    await refresh();
    page = cabinet!.telegram.sessionPresent ? "mcp" : "telegram";
    await resumeAttempt();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) showError(error);
  }
  render();
}
void start();
