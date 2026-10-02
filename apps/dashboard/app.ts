import { ApiError, type Attempt, type Cabinet, type Client, type InstagramAttempt, request } from "./api.js";
import { retireTelegramClient } from "./retire-client.js";

type Page = "mcp" | "telegram" | "instagram" | "access" | "clients" | "account";
type AuthMode = "register" | "login" | "recover";
const app = document.querySelector<HTMLDivElement>("#app")!;
const nav: [Page, string, string][] = [
  ["mcp", "MCP", "◇"],
  ["telegram", "Telegram", "➤"],
  ["instagram", "Instagram", "◎"],
  ["access", "Права доступа", "◈"],
  ["clients", "Подключённые клиенты", "▣"],
  ["account", "Аккаунт", "◎"],
];
const errors: Record<string, string> = {
  "account-capacity": "Можно добавить до пяти Telegram-аккаунтов. Удалите ненужный аккаунт и повторите попытку.",
  "invalid-account-label": "Название аккаунта должно содержать от 1 до 80 символов.",
  "primary-account-required": "Основной аккаунт можно отключить, но нельзя удалить отдельно от кабинета.",
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
let selectedTelegramAccount: string | undefined;
let selectedInstagramAccount:string|undefined;
let instagramAttempt:InstagramAttempt|undefined;
let instagramTimer:number|undefined;
const instagramErrors:Record<string,string>={"needs-verification":"Откройте официальное приложение Instagram, подтвердите вход и повторите подключение.","invalid-code":"Неверный код. Проверьте код и повторите попытку.","needs-login":"Сессия Instagram истекла. Подключите аккаунт снова.","login-failed":"Не удалось войти в Instagram. Проверьте данные или подтвердите вход в официальном приложении.","reauthentication-required":"Войдите в кабинет снова, затем повторите подключение Instagram.","account-already-added":"Этот Instagram уже добавлен в ваш кабинет.","identity-mismatch":"Подключите тот же аккаунт Instagram или создайте новый слот.","account-capacity":"Можно добавить до пяти Instagram-аккаунтов.","worker-unavailable":"Instagram сейчас недоступен. Обновите статус и повторите попытку."};
let clients: Client[] = [];
let clientsState: "idle" | "loading" | "ready" | "error" = "idle";
let renderedContext = "";
let pendingFieldFocus:
  | {
      context: string;
      form: string;
      name: string;
      value: string;
      start: number | null | undefined;
      end: number | null | undefined;
    }
  | undefined;
let showPassword = false;
let startupFailed = false;
let pendingPage: Page | undefined;
let pendingButtonFocus: { context: string; action?: string; page?: string; revoke?: string } | undefined;
let theme: "system" | "light" | "dark" = "system";
try {
  const saved = localStorage.getItem("mcp-ui-theme");
  if (saved === "light" || saved === "dark") theme = saved;
} catch {
  /* Appearance remains usable when storage is unavailable. */
}
let page: Page = "mcp";
let authMode: AuthMode = "register";
let attempt: Attempt | undefined;
let timer: number | undefined;
let recoveryCodes: string[] = [];
let message = "";
let floatingNotice = false;
let isError = false;
let isBusy = false;
let epoch = 0;
const continuation = new URLSearchParams(location.search).get("mcp_login");
class StaleReply extends Error {}

function scopedPath(path: string): string {
  if (!selectedTelegramAccount || selectedTelegramAccount === cabinet?.user.id || path.startsWith("/telegram/accounts"))
    return path;
  return path === "/me" || path === "/policy" || path.startsWith("/telegram/")
    ? `${path}${path.includes("?") ? "&" : "?"}telegramAccountId=${encodeURIComponent(selectedTelegramAccount)}`
    : path;
}
async function accountRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const currentEpoch = epoch;
  const user = cabinet;
  if (!user) throw new StaleReply();
  const value = await request<T>(scopedPath(path), method, body, user.csrfToken);
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
  return `<button type="button" class="button ${kind}" data-action="${action}" aria-label="${action === "copy-json" ? "Копировать JSON конфигурацию" : action === "copy-toml" ? "Копировать TOML конфигурацию" : action === "dismiss-notice" ? "Закрыть уведомление" : label === "Скопировать" ? "Скопировать адрес MCP" : label}" ${isBusy ? "disabled" : ""}>${label}</button>`;
}
function field(label: string, name: string, type = "text", extra = "", id = name): string {
  return `<div class="field"><label for="field-${id}">${label}</label><div class="inputWrap"><input id="field-${id}" name="${name}" type="${type === "password" && showPassword ? "text" : type}" required ${extra}>${type === "password" ? `<button class="passwordToggle" type="button" data-action="toggle-password" aria-label="${showPassword ? "Скрыть пароль" : "Показать пароль"}" aria-pressed="${showPassword}">${showPassword ? "Скрыть" : "Показать"}</button>` : ""}</div></div>`;
}
function render(): void {
  const context = `${epoch}:${cabinet?.user.id ?? "anonymous"}:${cabinet?.policy.version ?? 0}:${cabinet?.telegramAccountId ?? ""}:${selectedInstagramAccount??""}:${page}:${authMode}`;
  const scrollTop = context === renderedContext ? app.querySelector<HTMLElement>(".canvas")?.scrollTop : undefined;
  const documentScrollTop = context === renderedContext ? document.scrollingElement?.scrollTop : 0;
  const forms = [...app.querySelectorAll<HTMLFormElement>("form")];
  const drafts =
    context === renderedContext
      ? forms.flatMap((form) =>
          [...form.elements]
            .filter(
              (field): field is HTMLInputElement | HTMLTextAreaElement =>
                "value" in field && "name" in field && (field as HTMLInputElement).type !== "hidden" && !["instagramPassword","instagramCode"].includes((field as HTMLInputElement).name),
            )
            .map((field) => ({
              form: form.id,
              name: field.name,
              value: field.value,
              checked: "checked" in field ? field.checked : undefined,
              focused: document.activeElement === field,
              start: field.selectionStart,
              end: field.selectionEnd,
            })),
        )
      : [];
  const focused = drafts.find((draft) => draft.focused);
  if (focused) pendingFieldFocus = { context, ...focused };
  if (context !== renderedContext) {
    pendingButtonFocus = undefined;
    showPassword = false;
    pendingFieldFocus = undefined;
  }
  const active = document.activeElement as HTMLElement | null;
  if (active?.tagName === "BUTTON" && (active.dataset.action || active.dataset.page || active.dataset.revoke)) {
    pendingButtonFocus = {
      context,
      action: active.dataset.action,
      page: active.dataset.page,
      revoke: active.dataset.revoke,
    };
    pendingFieldFocus = undefined;
  }
  const details =
    context === renderedContext
      ? [...app.querySelectorAll<HTMLDetailsElement>("details")].map((detail) => detail.open)
      : [];
  renderView();
  renderedContext = context;
  [...app.querySelectorAll<HTMLDetailsElement>("details")].forEach((detail, index) => {
    if (details[index] !== undefined) detail.open = details[index];
  });
  document.documentElement?.setAttribute("data-theme", theme);
  document.cookie = `mcp-ui-theme=${theme}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  document.title = cabinet ? `${nav.find(([key]) => key === page)?.[1]} — Telegram MCP` : "Telegram MCP";
  if (!isBusy && pendingButtonFocus?.context === context) {
    const focus = pendingButtonFocus;
    const button = [...app.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) =>
        candidate.dataset.action === focus.action &&
        candidate.dataset.page === focus.page &&
        candidate.dataset.revoke === focus.revoke,
    );
    button?.focus({ preventScroll: true });
    pendingButtonFocus = undefined;
  }
  for (const form of app.querySelectorAll<HTMLFormElement>("form")) {
    for (const field of form.elements) {
      if (!("value" in field) || !("name" in field)) continue;
      const input = field as HTMLInputElement | HTMLTextAreaElement;
      const draft = drafts.find(
        (saved) =>
          saved.form === form.id &&
          saved.name === input.name &&
          (input.type !== "radio" || saved.value === input.value),
      );
      if (!draft) continue;
      input.value = draft.value;
      if (draft.checked !== undefined && "checked" in input) input.checked = draft.checked;
      const focus = pendingFieldFocus;
      if (
        !isBusy &&
        focus?.context === context &&
        focus.form === form.id &&
        focus.name === input.name &&
        (input.type !== "radio" || focus.value === input.value)
      ) {
        input.focus({ preventScroll: true });
        if (focus.start != null && focus.end != null && ["text", "password", "textarea"].includes(input.type))
          input.setSelectionRange(focus.start, focus.end);
        pendingFieldFocus = undefined;
      }
    }
    for (const field of form.elements) (field as HTMLInputElement).disabled = isBusy;
  }
  const canvas = app.querySelector<HTMLElement>(".canvas");
  if (canvas && scrollTop !== undefined) canvas.scrollTop = scrollTop;
  if (document.scrollingElement && documentScrollTop !== undefined)
    document.scrollingElement.scrollTop = documentScrollTop;
}
function themeButton(): string {
  return button(
    `Тема: ${theme === "system" ? "авто" : theme === "dark" ? "тёмная" : "светлая"}`,
    "theme",
    "themeButton secondary",
  );
}
function hasConnection():boolean {return !!cabinet?.telegram.sessionPresent || !!cabinet?.instagram?.accounts.some(c=>c.instagram.sessionPresent);}
function clearInstagramAttempt():void {clearTimeout(instagramTimer);instagramTimer=undefined;instagramAttempt=undefined;}
function instagramPath(suffix=""):string {
  if(!selectedInstagramAccount)throw new Error("Выберите Instagram-аккаунт.");
  return `/instagram/accounts/${encodeURIComponent(selectedInstagramAccount)}${suffix}`;
}
function renderInstagram():string {
  const accounts=cabinet?.instagram?.accounts??[];
  if(!cabinet?.instagram?.enabled)return "";
  const selected=accounts.find(c=>c.id===selectedInstagramAccount);
  const cards=`<section class="card instagramCard"><div class="cardHeader"><h2>Instagram-аккаунты</h2><span class="tag">${accounts.length} / 5</span></div><p class="muted">Личные сообщения Instagram через MCP. Для отправки включите разрешение в настройках аккаунта ниже.</p><div class="accountChoices">${accounts.map(c=>button(`${escapeHtml(c.label)} · ${c.removalPending?"Повторить удаление":c.instagram.sessionPresent?"Подключён":"Не подключён"}`,`${c.removalPending?"ig-remove:":"ig-select:"}${escapeHtml(c.id)}`,c.id===selectedInstagramAccount?"primary":"secondary")).join("")}</div>${accounts.length<5?`<form id="addInstagramAccountForm">${field("Название Instagram-аккаунта","instagramLabel","text",'maxlength="80" placeholder="Личный"')}<button class="button secondary" ${isBusy?"disabled":""}>Добавить аккаунт</button></form>`:""}<p class="fieldHint">Изменение аккаунтов и прав отзывает OAuth-доступы. Затем подключите AI-клиенты заново.</p></section>`;
  if(!selected)return cards;
  let login="";
  if(selected.instagram.sessionPresent)login=`<div class="sessionInfo"><span class="statusDot online"></span><strong>Instagram подключён</strong></div><p class="muted">${escapeHtml(selected.instagram.account?.username?"@"+selected.instagram.account.username:"")}</p>${selected.instagram.code?`<p class="notice error">${escapeHtml(instagramErrors[selected.instagram.code]??errors[selected.instagram.code]??"Проверьте подключение Instagram.")}</p>`:""}<div class="actions">${button("Перейти к MCP","open-mcp")}${button("Отключить Instagram","ig-disconnect","danger")}</div>`;
  else if(instagramAttempt&&["starting","needs-code"].includes(instagramAttempt.state))login=instagramAttempt.state==="needs-code"?`<p class="muted">Введите код подтверждения Instagram.</p>${instagramAttempt.code?`<p class="notice error">${escapeHtml(instagramErrors[instagramAttempt.code]??"Проверьте код Instagram.")}</p>`:""}<form id="instagramCodeForm">${field("Код Instagram","instagramCode","text",'autocomplete="one-time-code" maxlength="32"')}<button class="button primary" ${isBusy?"disabled":""}>Подтвердить код</button></form>${button("Отменить","ig-cancel","secondary")}`:`<p role="status">Подключаем Instagram…</p>${button("Отменить","ig-cancel","secondary")}`;
  else login=`${instagramAttempt?`<p class="notice error">${escapeHtml(instagramErrors[instagramAttempt.code??""]??(instagramAttempt.state==="expired"?"Время подключения истекло.":"Подключение не завершено. Повторите попытку."))}</p>`:""}<p class="muted">Введите данные Instagram. Пароль и код используются только для входа и не сохраняются. Вход в кабинет и вход в Instagram — разные подключения.</p><form id="instagramLoginForm">${field("Имя пользователя Instagram","username","text",'autocomplete="username" maxlength="64"')}${field("Пароль Instagram","instagramPassword","password",'autocomplete="current-password" maxlength="1024"')}<button class="button primary" ${isBusy?"disabled":""}>Подключить Instagram</button></form>`;
  return cards+`<section class="card instagramCard"><h2>${escapeHtml(selected.label)}</h2><div class="accountDetail"><span class="muted">ID для AI-клиентов</span><code>${escapeHtml(selected.id)}</code></div>${login}<p class="fieldHint">Если Instagram требует дополнительную проверку, подтвердите её в официальном приложении и повторите вход здесь. После отключения сервер удаляет локальную сессию; активные устройства можно отозвать в настройках Instagram.</p></section><section class="card"><h2>Права этого Instagram-аккаунта</h2><form id="instagramPolicyForm"><label class="choice"><input type="radio" name="instagramProfile" value="read" ${selected.policy.profile==="read"?"checked":""}><span>Только чтение</span></label><label class="choice"><input type="radio" name="instagramProfile" value="full" ${selected.policy.profile==="full"?"checked":""}><span>Чтение и отправка сообщений</span></label><label class="field"><span>Разрешённые ID чатов</span><textarea name="instagramThreadIds" rows="3">${escapeHtml(selected.policy.threadIds.join(", "))}</textarea></label><p class="fieldHint">До 100 числовых ID. Пустое поле разрешает все чаты этого аккаунта.</p><button class="button primary" ${isBusy?"disabled":""}>Сохранить права</button></form></section><section class="card"><form id="renameInstagramAccountForm">${field("Название","instagramLabel","text",`maxlength="80" value="${escapeHtml(selected.label)}"`)}<button class="button secondary" ${isBusy?"disabled":""}>Сохранить название</button></form>${button("Удалить этот Instagram-аккаунт",`ig-remove:${escapeHtml(selected.id)}`,"danger")}</section>`;
}
async function pollInstagram(id:string,account:string,currentEpoch:number):Promise<void>{
  if(!cabinet||instagramAttempt?.id!==id||selectedInstagramAccount!==account||epoch!==currentEpoch)return;
  if(isBusy||document.hidden){instagramTimer=window.setTimeout(()=>void pollInstagram(id,account,currentEpoch),1500);return;}
  try{
    const value=await accountRequest<InstagramAttempt>(`/instagram/accounts/${encodeURIComponent(account)}/login/${encodeURIComponent(id)}`);
    if(epoch!==currentEpoch||selectedInstagramAccount!==account||instagramAttempt?.id!==id)return;
    const changed=value.state!==instagramAttempt.state||value.code!==instagramAttempt.code;instagramAttempt=value;
    if(value.state==="connected"){
      clearInstagramAttempt();await refresh();if(epoch!==currentEpoch)return;selectPage("mcp");message="Instagram подключён. Подключите AI-клиенты заново, чтобы подтвердить доступ.";render();return;
    }
    if(changed)render();
    if(["starting","needs-code"].includes(value.state))instagramTimer=window.setTimeout(()=>void pollInstagram(id,account,currentEpoch),1500);
  }catch(error){if(epoch!==currentEpoch)return;showError(error);render();instagramTimer=window.setTimeout(()=>void pollInstagram(id,account,currentEpoch),3000);}
}
function connectedService():string {return cabinet?.telegram.sessionPresent ? "Telegram" : "Instagram";}
function renderView(): void {
  const active = hasConnection();
  const notice = message
    ? `<div class="notice ${isError ? "error" : ""} ${floatingNotice ? "toast" : ""}" role="${isError ? "alert" : "status"}"><span>${escapeHtml(message)}</span>${floatingNotice ? button("Закрыть", "dismiss-notice", "link") : ""}</div>`
    : "";
  if (!cabinet && recoveryCodes.length) {
    app.innerHTML = `<main class="singleRecovery">${notice}${renderRecovery()}</main>`;
    return;
  }
  if (!cabinet && startupFailed) {
    app.innerHTML = `<main class="singleRecovery"><section class="card"><div class="brand"><img class="logo" src="/assets/logo.svg" alt=""><span>Telegram MCP</span></div><h1 class="outageTitle">Кабинет временно недоступен</h1><p class="muted">Не удалось получить состояние аккаунта. Повторите запрос через несколько секунд.</p>${notice}<div class="actions">${button("Повторить запрос", "retry-status")}</div></section></main>`;
    return;
  }
  if (!cabinet) {
    app.innerHTML = `<main class="authLayout"><section class="authIntro"><div class="brand"><img class="logo" src="/assets/logo.svg" alt=""><span>Telegram MCP</span><span class="freeBadge">Бесплатно</span></div><div class="authCopy"><span class="eyebrow">ВАШ TELEGRAM. В ВАШЕМ AI.</span><h1>Подключите Telegram<br> к своему AI-клиенту.</h1><p>Читайте и отправляйте сообщения через свой AI. Права всегда под вашим контролем.</p><div class="introSteps"><span>1. Создайте аккаунт</span><span>2. Подключите Telegram</span><span>3. Добавьте MCP в AI</span></div></div><p class="introFoot">Отдельная сессия для каждого аккаунта Telegram · OAuth · Доступ только с вашего разрешения</p></section><section class="authPanel"><div class="authToolbar">${themeButton()}</div><div class="authBox"><div class="authMark">➤</div><h2>${authMode === "register" ? "Создать аккаунт" : authMode === "login" ? "С возвращением" : "Восстановить доступ"}</h2><p class="muted">${authMode === "register" ? "Создайте аккаунт, затем подключите Telegram по QR-коду." : authMode === "login" ? "Войдите в свой кабинет Telegram MCP." : "Используйте один из сохранённых кодов восстановления."}</p>${notice}<form id="authForm">${field("Логин", "login", "text", 'autocomplete="username" pattern="[A-Za-z0-9_]{3,32}" minlength="3" maxlength="32" placeholder="username"')}${authMode === "recover" ? field("Код восстановления", "recoveryCode", "text", 'autocomplete="off" maxlength="128"') : ""}${field(authMode === "recover" ? "Новый пароль" : "Пароль", "password", "password", `autocomplete="${authMode === "login" ? "current-password" : "new-password"}" minlength="16" maxlength="1024" placeholder="Минимум 16 символов"`)}<p class="fieldHint">Логин: 3–32 латинских символа, цифры или _. Пароль: минимум 16 символов.</p>${authMode === "register" ? '<div class="permissionSummary"><strong>Полный доступ по умолчанию</strong><span>Чтение, отправка сообщений и изменения во всех чатах. Права можно ограничить в кабинете.</span></div>' : ""}<button class="button primary wide" ${isBusy ? "disabled" : ""}>${isBusy ? "Подождите…" : authMode === "register" ? "Зарегистрироваться" : authMode === "login" ? "Войти" : "Восстановить"}</button></form><div class="authLinks">${authMode === "register" ? "Уже есть аккаунт? " + button("Войти", "auth-login", "link") : button("Создать аккаунт", "auth-register", "link")}${authMode !== "recover" ? button("Забыли пароль?", "auth-recover", "link") : button("Назад ко входу", "auth-login", "link")}</div></div><p class="authFoot">Telegram MCP — независимый сервис для подключения AI.</p></section></main>`;
    return;
  }
  const title = nav.find(([key]) => key === page)![1];
  app.innerHTML = `<a class="skipLink" href="#main-content">Перейти к содержимому</a><div class="workspace"><aside class="sidebar"><div class="brand"><img class="logo" src="/assets/logo.svg" alt=""><span>Telegram MCP</span></div><div class="userCard"><div class="avatar">${escapeHtml(cabinet.user.login[0]?.toUpperCase() || "T")}</div><div class="userInfo"><strong>${escapeHtml(cabinet.user.login)}</strong><span>${active ? connectedService()+" подключён" : "Подключите аккаунт"}</span></div><span class="statusDot ${active ? "online" : ""}"></span></div><nav class="navigation" aria-label="Кабинет">${nav.filter(([key])=>key!=="instagram"||cabinet?.instagram?.enabled).map(([key, label, icon]) => `<button class="navItem ${page === key ? "selected" : ""}" data-page="${key}" aria-label="${label}" ${isBusy ? "disabled" : ""} ${page === key ? 'aria-current="page"' : ""}><span class="navIcon" aria-hidden="true">${icon}</span><span class="navLabel" data-short="${key === "access" ? "Права" : key === "clients" ? "Клиенты" : label}">${label}</span>${key === "telegram" ? `<span class="navDot ${active ? "online" : ""}"></span>` : ""}</button>`).join("")}</nav><div class="sidebarFoot"><div class="freePlan"><span class="planIcon">✦</span><div><strong>Бесплатный доступ</strong><span>Ваш Telegram. Ваши разрешения.</span></div></div>${button("Выйти из аккаунта", "logout", "link")}</div></aside><main class="main" id="main-content" tabindex="-1"><header class="topbar"><div class="topTitle"><span class="topIcon" aria-hidden="true">${nav.find(([key]) => key === page)![2]}</span><div><h1>${title}</h1><p>${page === "mcp" ? "Подключение аккаунтов к вашим AI-клиентам" : "Telegram MCP"}</p></div></div><div class="topActions">${themeButton()}<span class="connectionPill ${active ? "connected" : ""}">${active ? "● Подключено" : "○ Не подключено"}</span></div></header><div class="canvas"><div class="content" aria-busy="${isBusy}"><div class="steps" aria-label="Этапы подключения"><span class="done"><b>✓</b> Аккаунт</span><i></i><span class="${active ? "done" : "current"}"><b>${active ? "✓" : "2"}</b> Telegram</span><i></i><span class="${active ? "current" : ""}"><b>3</b> MCP</span></div>${notice}${recoveryCodes.length ? renderRecovery() : renderConnections() + renderPage()}<p class="canvasFoot">Telegram MCP · Бесплатный сервис · Отдельная сессия для каждого аккаунта</p></div></div></main></div>`;
}
function renderRecovery(): string {
  return `<section class="card recoveryCard"><span class="cardIcon">◈</span><h2>Сохраните коды восстановления</h2><p class="muted">Каждый код можно использовать один раз, чтобы восстановить пароль. Сохраните их в надёжном месте: после закрытия они больше не отображаются.</p><pre class="code recoveryCodes">${escapeHtml(recoveryCodes.join("\n"))}</pre><div class="actions">${button("Скопировать коды", "copy-recovery", "secondary")}${button("Скачать .txt", "download-recovery", "secondary")}${button("Я сохранил коды", "saved-recovery")}</div></section>`;
}
function renderPage(): string {
  if(page==="instagram")return renderInstagram();
  if (page === "telegram") return renderTelegram();
  if (page === "access") return renderAccess();
  if (page === "clients") return renderClients();
  if (page === "account") return renderAccount();
  return renderMcp();
}
function renderMcp(): string {
  const instagramAccess = cabinet?.instagram?.accounts.filter(c=>c.instagram.sessionPresent).map(c=>`<p><strong>${escapeHtml(c.label)} · Instagram</strong>: ${c.policy.profile==="read"?"Только чтение":"Чтение и отправка"}; ${c.policy.threadIds.length?"выбранные чаты ("+c.policy.threadIds.length+")":"все чаты"}.</p>`).join("")??"";
  if (!hasConnection())
    return `<section class="hero"><div class="heroIcon">➤</div><span class="eyebrow">СЛЕДУЮЩИЙ ШАГ</span><h2>Подключите свой Telegram</h2><p>Один QR-код — и ваши AI-клиенты смогут работать с Telegram через MCP. Разрешения всегда под вашим контролем.</p>${button("Подключить Telegram", "open-telegram")}${cabinet?.instagram?.enabled?button("Подключить Instagram","open-instagram","secondary"):""}<div class="heroNotes"><span>◈ ${cabinet!.policy.profile === "read" ? "Только чтение" : "Чтение и изменение"}</span><span>◇ OAuth для AI-клиентов</span></div></section><div class="infoGrid"><section class="card"><h3>Отдельные сессии</h3><p class="muted">Telegram подключается на сервере. Кабинет управляет MCP и не открывает отдельный клиент чатов.</p></section><section class="card"><h3>Ваши данные — ваш доступ</h3><p class="muted">Вы выбираете права и можете отключить любой AI-клиент в кабинете.</p></section></div>`;
  const url = cabinet!.mcpUrl;
  const config = JSON.stringify({ mcpServers: { telegram: { type: "http", url } } }, undefined, 2);
  return `${instagramAccess?`<section class="card"><h2>Доступ к Instagram</h2>${instagramAccess}</section>`:""}<section class="welcomeBubble"><span class="welcomeCheck" aria-hidden="true">✓</span><div><h2>${cabinet!.telegram.sessionPresent ? "Telegram" : "Instagram"} готов к работе с AI</h2><p>Добавьте адрес MCP в своём клиенте и подтвердите доступ через OAuth.</p></div></section><section class="card"><div class="cardHeader"><div><span class="eyebrow">MCP ENDPOINT</span><h2>Ваш адрес подключения</h2></div><span class="tag">Streamable HTTP</span></div><div class="endpoint"><code>${escapeHtml(url)}</code>${button("Скопировать", "copy-url", "secondary")}</div><div class="metadata"><span>Авторизация <strong>OAuth 2.1 + PKCE</strong></span><span>Права <strong>${cabinet!.policy.profile === "read" ? "Только чтение" : "Чтение и изменение"}</strong></span><span>Чаты <strong>${cabinet!.policy.chatIds.length ? cabinet!.policy.chatIds.length + " выбрано" : "Все ваши чаты"}</strong></span></div></section><section class="card"><h2>Как подключить AI-клиент</h2><ol class="connectSteps"><li><strong>Откройте настройки MCP</strong><p>В ChatGPT, Claude или другом клиенте выберите добавление удалённого MCP-сервера.</p></li><li><strong>Вставьте адрес подключения</strong><p>Используйте URL выше и OAuth, если клиент предлагает способ авторизации.</p></li><li><strong>Подтвердите разрешения</strong><p>Войдите в этот кабинет и разрешите клиенту доступ. Повторно подключать аккаунт не нужно.</p></li></ol><p class="fieldHint">Клиент должен поддерживать удалённый MCP по HTTP и OAuth. Его доступ появится в разделе «Подключённые клиенты».</p></section><details class="configDetails"><summary>Конфигурация для MCP-клиентов <span>JSON · TOML</span></summary><div class="infoGrid"><section class="card"><div class="cardHeader"><h3>JSON конфигурация</h3>${button("Копировать", "copy-json", "link")}</div><pre class="code">${escapeHtml(config)}</pre><p class="fieldHint">Для клиентов с форматом mcpServers. Авторизацию выполните через OAuth в клиенте.</p></section><section class="card"><div class="cardHeader"><h3>Codex · TOML</h3>${button("Копировать", "copy-toml", "link")}</div><pre class="code">${escapeHtml(`[mcp_servers.telegram]\nurl = "${url}"`)}</pre><p class="fieldHint">Добавьте сервер в конфигурацию MCP и выполните вход через OAuth.</p></section></div></details>${continuation ? `<section class="card oauthCard"><h3>Продолжить подключение клиента</h3><p class="muted">Аккаунт подключён. Вернитесь к подтверждению доступа для AI-клиента.</p>${button("Продолжить", "resume-oauth")}</section>` : ""}`;
}
function renderTelegram(): string {
  if (cabinet!.telegram.sessionPresent) {
    const account = cabinet!.telegram.account;
    return `<section class="card telegramCard"><div class="telegramAvatar">➤</div><h2>Telegram подключён</h2><p class="muted">${account?.username ? "@" + escapeHtml(account.username) : "Ваш аккаунт Telegram"}${account?.id ? ` · ID ${escapeHtml(account.id)}` : ""}</p><div class="sessionInfo"><span class="statusDot online"></span><span>Отдельная серверная сессия этого аккаунта</span></div><p class="muted">AI-клиенты выбирают этот аккаунт по его ID. Вход в кабинет не создаёт новую сессию Telegram.</p><div class="actions">${button("Перейти к MCP", "open-mcp")}${button("Отключить Telegram", "disconnect", "danger")}</div></section>`;
  }
  let body = button("Показать QR-код", "start-telegram");
  if (attempt) {
    if (attempt.state === "qr")
      body = `<img class="qrImage" src="${escapeHtml(attempt.dataUrl)}" alt="QR-код для подключения Telegram"><ol class="qrInstructions"><li>Откройте Telegram на телефоне.</li><li>Настройки → Устройства → Подключить устройство.</li><li>Отсканируйте этот QR-код.</li></ol><p class="muted small">QR обновляется автоматически. Не отправляйте его другим людям.</p>${button("Отменить", "cancel-telegram", "secondary")}`;
    else if (attempt.state === "needs-password")
      body = `<form id="telegramPasswordForm">${field("Облачный пароль Telegram", "password", "password", 'autocomplete="off" maxlength="1024"')}<button class="button primary wide" ${isBusy ? "disabled" : ""}>Подтвердить</button></form><p class="muted small">Это пароль двухэтапной проверки Telegram.</p>${button("Отменить", "cancel-telegram", "secondary")}`;
    else if (["error", "expired", "cancelled"].includes(attempt.state))
      body = `<p class="notice error">${attempt.code === "account-already-added" ? "Этот Telegram уже добавлен в ваш кабинет. Выберите его в списке аккаунтов." : attempt.state === "expired" ? "Время подключения истекло." : "Подключение не завершено."}</p>${button("Попробовать снова", "start-telegram")}`;
    else
      body = `<div class="loadingRing" aria-hidden="true"></div><p class="muted" role="status">Подключаем Telegram…</p>${button("Отменить", "cancel-telegram", "secondary")}`;
  }
  return `<section class="card telegramCard"><div class="telegramAvatar">➤</div><h2>${attempt?.state === "qr" ? "Отсканируйте QR-код" : attempt?.state === "needs-password" ? "Подтвердите вход" : "Подключить Telegram"}</h2><p class="muted">${attempt?.state === "qr" ? "В Telegram: Настройки → Устройства → Подключить устройство." : attempt?.state === "needs-password" ? "Введите облачный пароль, чтобы завершить подключение Telegram." : "Подтвердите подключение на телефоне. Сессия будет храниться на сервере и использоваться для MCP."}</p><div class="qrBody">${body}</div></section>`;
}
function renderConnections(): string {
  const accounts = cabinet?.accounts;
  if (!accounts?.length) return "";
  const selected = cabinet!.telegramAccountId ?? cabinet!.user.id;
  const current = accounts.find((account) => account.id === selected)!;
  return `<section class="card"><div class="cardHeader"><h2>Telegram-аккаунты</h2><span class="tag">${accounts.length} / 5</span></div><div class="accountChoices">${accounts.map((account) => `<button type="button" class="button ${account.id === selected ? "primary" : "secondary"}" data-action="${account.removalPending ? "retry-remove:" : "select-account:"}${escapeHtml(account.id)}" aria-pressed="${account.id === selected}" ${isBusy ? "disabled" : ""}>${escapeHtml(account.label)} · ${account.removalPending ? "Повторить удаление" : account.telegram.sessionPresent ? "Подключён" : "Не подключён"}</button>`).join("")}</div><p class="muted">Выбор здесь управляет кабинетом. В AI попросите выбрать аккаунт по названию. Без явного выбора AI использует основной аккаунт.</p><div class="accountDetail"><span class="muted">ID выбранного аккаунта</span><code>${escapeHtml(selected)}</code></div>${!current.primary ? `<details><summary>Название и удаление аккаунта</summary><form id="renameTelegramAccountForm">${field("Название", "label", "text", `maxlength="80" value="${escapeHtml(current.label)}"`, "rename-label")}<button class="button secondary" ${isBusy ? "disabled" : ""}>Сохранить название</button></form><div class="actions">${button("Удалить выбранный Telegram-аккаунт", "remove-telegram-account", "danger")}</div></details>` : ""}${accounts.length < 5 ? `<details><summary>Добавить Telegram-аккаунт</summary><form id="addTelegramAccountForm">${field("Название аккаунта", "label", "text", 'maxlength="80" placeholder="Например: Работа"', "add-label")}<button class="button primary" ${isBusy ? "disabled" : ""}>Добавить и показать QR-код</button></form></details>` : ""}<p class="fieldHint">Добавление и удаление аккаунтов отзывают текущие OAuth-доступы. Подключите AI-клиенты заново, чтобы подтвердить новый состав аккаунтов.</p></section>`;
}

function renderAccess(): string {
  return `<section class="card"><h2>Что разрешено AI-клиентам</h2><p class="muted">Эти правила действуют для выбранного Telegram-аккаунта во всех MCP-клиентах.</p><form id="policyForm"><label class="choice"><input type="radio" name="profile" value="read" ${cabinet!.policy.profile === "read" ? "checked" : ""}><span><strong>Только чтение</strong><small>Просмотр и поиск данных. Без отправки и изменения сообщений.</small></span></label><label class="choice"><input type="radio" name="profile" value="full" ${cabinet!.policy.profile === "full" ? "checked" : ""}><span><strong>Чтение и изменение</strong><small>Также разрешает отправку сообщений и другие изменения через MCP.</small></span><span class="tag">По умолчанию</span></label><label class="field"><span>Разрешённые чаты</span><textarea name="chatIds" rows="3" placeholder="Например: -1001234567890, 123456789">${escapeHtml(cabinet!.policy.chatIds.join(", "))}</textarea></label><p class="fieldHint">Числовые ID через запятую, до 100 чатов. Пустое поле разрешает все ваши чаты.</p><div class="notice policyNotice">Если изменить права, текущие OAuth-доступы отключатся. Подключите AI-клиенты заново с новыми разрешениями.</div><button class="button primary" ${isBusy ? "disabled" : ""}>Сохранить права</button></form></section>`;
}
function renderClients(): string {
  const pending = clientsState === "loading" || clientsState === "idle";
  const state = pending
    ? '<div class="emptyState" role="status"><div class="loadingRing"></div><h3>Загружаем подключения…</h3></div>'
    : clientsState === "error"
      ? '<div class="emptyState"><span aria-hidden="true">↻</span><h3>Не удалось загрузить подключения</h3><p class="muted">Нажмите «Обновить», чтобы повторить запрос.</p></div>'
      : "";
  return `<section class="card"><div class="cardHeader"><div><h2>Подключённые клиенты</h2><p class="muted">AI-клиенты, которым вы разрешили доступ по OAuth.</p></div>${button("Обновить", "refresh-clients", "secondary")}</div>${state || (clients.length ? `<div class="clientList">${clients.map((client) => `<div class="clientRow"><div class="clientIcon">◇</div><div class="clientInfo"><strong>${escapeHtml(client.name || client.clientId)}</strong><span>${client.name ? escapeHtml(client.clientId) + " · " : ""}OAuth · версия прав ${escapeHtml(client.version)}</span></div><button class="button danger" aria-label="Отключить ${escapeHtml(client.name || client.clientId)}" data-revoke="${escapeHtml(client.grantId)}" ${isBusy ? "disabled" : ""}>Отключить</button></div>`).join("")}</div>` : '<div class="emptyState"><span>◇</span><h3>Пока нет подключений</h3><p class="muted">Добавьте адрес MCP в AI-клиенте и разрешите доступ. Подключение появится здесь.</p></div>')}</section>`;
}
function renderAccount(): string {
  return `<section class="card"><h2>Ваш аккаунт</h2><div class="accountDetail"><span class="muted">Логин</span><strong>${escapeHtml(cabinet!.user.login)}</strong></div><div class="accountDetail"><span class="muted">Тариф</span><span class="tag">Бесплатно</span></div><p class="muted">Выход из кабинета сохраняет подключение Telegram и доступы ваших MCP-клиентов.</p>${button("Выйти из аккаунта", "logout", "secondary")}</section><details class="card dangerCard"><summary>Удалить аккаунт</summary><p class="muted">Удалятся серверная сессия Telegram, данные кабинета и доступы всех AI-клиентов.</p><form id="deleteForm">${field("Подтвердите пароль аккаунта", "password", "password", 'autocomplete="current-password" maxlength="1024"')}<button class="button danger" ${isBusy ? "disabled" : ""}>Удалить аккаунт</button></form></details>`;
}
function showError(error: unknown): void {
  if (error instanceof StaleReply) return;
  floatingNotice = false;
  isError = true;
  message =
    error instanceof ApiError
      ? (instagramErrors[error.code] ?? errors[error.code] ?? "Не удалось выполнить запрос. Попробуйте снова.")
      : "Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.";
  if (error instanceof ApiError && error.status === 401 && cabinet) {
    clearAttempt();
    cabinet = undefined;
    clients = [];
    clientsState = "idle";
    recoveryCodes = [];
    epoch++;
    pendingPage = undefined;
    authMode = "login";
  }
}
async function run(work: () => Promise<void>): Promise<void> {
  if (isBusy) return;
  const currentEpoch = epoch;
  const operationOwner = cabinet?.user.id;
  isBusy = true;
  message = "";
  floatingNotice = false;
  isError = false;
  render();
  try {
    await work();
  } catch (error) {
    if (currentEpoch === epoch || (operationOwner && cabinet?.user.id === operationOwner)) showError(error);
  } finally {
    isBusy = false;
    if (pendingPage && cabinet) {
      const next = pendingPage;
      pendingPage = undefined;
      openPage(next);
    } else render();
  }
}
async function refresh(): Promise<void> {
  let currentEpoch = epoch;
  let requestedSelection = selectedTelegramAccount;
  let value: Cabinet;
  try {
    value = await request<Cabinet>(scopedPath("/me"));
  } catch (error) {
    if (currentEpoch !== epoch || requestedSelection !== selectedTelegramAccount) return;
    if (!(error instanceof ApiError && error.status === 404 && selectedTelegramAccount)) throw error;
    selectedTelegramAccount = undefined;
    requestedSelection = undefined;
    currentEpoch = ++epoch;
    clearAttempt();
    value = await request<Cabinet>("/me");
  }
  if (currentEpoch !== epoch || requestedSelection !== selectedTelegramAccount) return;
  const switchedAccount = cabinet && cabinet.user.id !== value.user.id;
  if (switchedAccount) {
    selectedTelegramAccount = undefined;
    selectPage(value.telegram.sessionPresent || value.instagram?.accounts.some(c=>c.instagram.sessionPresent) ? "mcp" : "telegram");
    clearAttempt();
    clients = [];
    clientsState = "idle";
    recoveryCodes = [];
    epoch++;
    pendingPage = undefined;
  }
  cabinet = value;
  if(!value.instagram?.accounts.some(c=>c.id===selectedInstagramAccount)) selectedInstagramAccount=value.instagram?.accounts[0]?.id;
  if(switchedAccount)clearInstagramAttempt();
  if (switchedAccount) render();
}
async function resumeAttempt(): Promise<void> {
  if (!cabinet || cabinet.telegram.sessionPresent || attempt) return;
  const currentEpoch = epoch;
  const userId = cabinet.user.id;
  const value = await accountRequest<{ attempt?: Attempt }>("/telegram/login");
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
    const value = await accountRequest<Attempt>(`/telegram/login/${id}`);
    if (attempt?.id !== id || currentEpoch !== epoch) return;
    const changed = value.state !== attempt.state || value.dataUrl !== attempt.dataUrl;
    attempt = value;
    if (value.state === "success") {
      await refresh();
      if (currentEpoch !== epoch || !cabinet || attempt?.id !== id) return;
      clearAttempt();
      selectPage("mcp");
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
          selectPage("mcp");
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
  const currentEpoch = epoch;
  try {
    await navigator.clipboard.writeText(value);
    if (currentEpoch !== epoch) return;
    floatingNotice = true;
    message = "Скопировано.";
    isError = false;
  } catch {
    if (currentEpoch !== epoch) return;
    floatingNotice = true;
    message = "Не удалось скопировать. Выделите и скопируйте текст вручную.";
    isError = true;
  }
  render();
}
function pageFromHash(): Page | undefined {
  const name = location.hash?.slice(1);
  if (name === "instagram" && !cabinet?.instagram?.enabled) return undefined;
  return nav.find(([key]) => key === name)?.[0];
}
function selectPage(next: Page): void {
  page = next;
  history.replaceState(null, "", `#${next}`);
}
function openPage(next: Page, updateHash = true): void {
  page = next;
  message = "";
  floatingNotice = false;
  if (updateHash) location.hash = next;
  render();
  if (page === "clients") void dispatchAction("refresh-clients");
}
window.addEventListener("hashchange", () => {
  const next = pageFromHash();
  if (!cabinet || !next || (next === "instagram" && !cabinet.instagram?.enabled)) return;
  if (isBusy) {
    pendingPage = next === page ? undefined : next;
    return;
  }
  if (next === page) return;
  openPage(next, false);
});
async function dispatchAction(action: string): Promise<void> {
  if (action === "dismiss-notice") {
    message = "";
    floatingNotice = false;
    render();
    return;
  }
  if (action === "retry-status") {
    await run(async () => {
      try {
        await refresh();
        startupFailed = false;
        selectPage(pageFromHash() ?? (hasConnection() ? "mcp" : "telegram"));
        await resumeAttempt();
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          startupFailed = false;
          authMode = "login";
          return;
        }
        throw error;
      }
    });
    if (cabinet && page === "clients") void dispatchAction("refresh-clients");
    return;
  }
  if (action === "theme") {
    theme = theme === "system" ? "dark" : theme === "dark" ? "light" : "system";
    try {
      localStorage.setItem("mcp-ui-theme", theme);
    } catch {
      /* Optional appearance preference. */
    }
    render();
    return;
  }
  if (action === "toggle-password") {
    showPassword = !showPassword;
    render();
    return;
  }
  if (action.startsWith("auth-")) {
    authMode = action.slice(5) as AuthMode;
    showPassword = false;
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
    selectPage("telegram");
    if (!cabinet) authMode = "login";
    render();
    if (cabinet) await run(resumeAttempt);
    return;
  }
  if (!cabinet) return;
  if (action === "open-telegram" || action === "open-mcp" || action === "open-instagram") {
    openPage(action === "open-mcp" ? "mcp" : action === "open-instagram" ? "instagram" : "telegram");
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
  if(action.startsWith("ig-")){
    await run(async()=>{
      if(action.startsWith("ig-select:")){
        const id=action.slice("ig-select:".length);if(!cabinet?.instagram?.accounts.some(c=>c.id===id))return;
        if(instagramAttempt&&["starting","needs-code"].includes(instagramAttempt.state))await accountRequest(instagramPath(`/login/${encodeURIComponent(instagramAttempt.id)}`),"DELETE");
        clearInstagramAttempt();selectedInstagramAccount=id;render();
      }else if(action==="ig-cancel"){
        if(instagramAttempt)await accountRequest(instagramPath(`/login/${encodeURIComponent(instagramAttempt.id)}`),"DELETE");clearInstagramAttempt();await refresh();
      }else if(action==="ig-disconnect"){
        if(!confirm("Отключить Instagram и отозвать доступы MCP-клиентов?"))return;
        await accountRequest(instagramPath("/disconnect"),"POST",{});clearInstagramAttempt();await refresh();message="Instagram отключён. Подключите AI-клиенты заново.";
      }else if(action.startsWith("ig-remove:")){
        const id=action.slice("ig-remove:".length);if(!confirm("Удалить Instagram-аккаунт и отозвать доступы MCP-клиентов?"))return;
        await accountRequest(`/instagram/accounts/${encodeURIComponent(id)}`,"DELETE");clearInstagramAttempt();await refresh();message="Instagram-аккаунт удалён.";
      }
      clients=[];clientsState="idle";
    });return;
  }
  await run(async () => {
    if (action.startsWith("select-account:")) {
      const id = action.slice("select-account:".length);
      if (!cabinet?.accounts?.some((account) => account.id === id)) return;
      epoch++;
      clearAttempt();
      selectedTelegramAccount = id;
      await refresh();
      await resumeAttempt();
    } else if (action === "remove-telegram-account" || action.startsWith("retry-remove:")) {
      const id = action.startsWith("retry-remove:") ? action.slice("retry-remove:".length) : cabinet!.telegramAccountId;
      if (
        !id ||
        id === cabinet!.user.id ||
        !confirm("Удалить выбранный Telegram-аккаунт, его файлы и отозвать OAuth-доступы?")
      )
        return;
      await accountRequest(`/telegram/accounts/${encodeURIComponent(id)}`, "DELETE");
      epoch++;
      clearAttempt();
      selectedTelegramAccount = undefined;
      selectedInstagramAccount = undefined; clearInstagramAttempt();
      clients = [];
      clientsState = "idle";
      await refresh();
      message = "Аккаунт удалён. Подключите AI-клиенты заново.";
    } else if (action === "logout") {
      await accountRequest("/logout", "POST", {});
      epoch++;
      pendingPage = undefined;
      clearAttempt();
      cabinet = undefined;
      selectedTelegramAccount = undefined;
      selectedInstagramAccount = undefined; clearInstagramAttempt();
      clients = [];
      clientsState = "idle";
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
      if (cabinet?.telegram.sessionPresent) selectPage("mcp");
    } else if (action === "disconnect") {
      await accountRequest("/telegram/disconnect", "POST", {});
      clearAttempt();
      clients = [];
      clientsState = "idle";
      await refresh();
      message = "Telegram отключён. Доступы MCP отозваны.";
    } else if (action === "refresh-clients") {
      const requestEpoch = epoch;
      clientsState = "loading";
      render();
      try {
        clients = (await accountRequest<{ clients: Client[] }>("/clients")).clients;
        clientsState = "ready";
      } catch (error) {
        if (requestEpoch === epoch) clientsState = "error";
        throw error;
      }
    } else if (action === "resume-oauth") {
      const result = await accountRequest<{ continueTo: string }>("/oauth/resume", "POST", { continuation });
      if (/^\/interaction\/[A-Za-z0-9_-]+$/.test(result.continueTo)) location.assign(result.continueTo);
    }
  });
}
app.addEventListener("click", (event) => {
  const target = (event.target as Element).closest<HTMLButtonElement>("button");
  if (!target || isBusy) return;
  if (target.dataset.page) {
    openPage(target.dataset.page as Page);
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
  const instagramPassword=value("instagramPassword"),instagramCode=value("instagramCode");
  if(form.id==="instagramLoginForm"||form.id==="instagramCodeForm"){
    for(const control of Array.from(form.elements??[]))if("value" in control&&"name" in control&&["instagramPassword","instagramCode"].includes(String(control.name)))(control as HTMLInputElement).value="";
    values.delete?.("instagramPassword");values.delete?.("instagramCode");pendingFieldFocus=undefined;
  }
  const profile = value("profile");
  const chatIds = value("chatIds")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (form.id === "deleteForm" && !confirm("Удалить аккаунт без возможности восстановления?")) return;
  void run(async () => {
    if(form.id==="instagramLoginForm"&&cabinet){
      clearInstagramAttempt();instagramAttempt=await accountRequest<InstagramAttempt>(instagramPath("/login"),"POST",{username:value("username"),password:instagramPassword});
      instagramTimer=window.setTimeout(()=>void pollInstagram(instagramAttempt!.id,selectedInstagramAccount!,epoch),200);
    }else if(form.id==="instagramCodeForm"&&cabinet&&instagramAttempt){
      await accountRequest(instagramPath(`/login/${encodeURIComponent(instagramAttempt.id)}/code`),"POST",{code:instagramCode});instagramAttempt={...instagramAttempt,state:"starting",code:undefined};
      instagramTimer=window.setTimeout(()=>void pollInstagram(instagramAttempt!.id,selectedInstagramAccount!,epoch),200);
    }else if(form.id==="addInstagramAccountForm"&&cabinet){
      const result=await accountRequest<{account:{id:string}}>("/instagram/accounts","POST",{label:value("instagramLabel")});clearInstagramAttempt();selectedInstagramAccount=result.account.id;await refresh();message="Instagram-аккаунт добавлен. Введите данные Instagram для подключения.";
    }else if(form.id==="renameInstagramAccountForm"&&cabinet){
      await accountRequest(instagramPath(),"PATCH",{label:value("instagramLabel")});await refresh();message="Название Instagram-аккаунта сохранено.";
    }else if(form.id==="instagramPolicyForm"&&cabinet){
      await accountRequest(instagramPath("/policy"),"PUT",{profile:value("instagramProfile"),threadIds:[...new Set(value("instagramThreadIds").split(/[\s,]+/).filter(Boolean))]});clearInstagramAttempt();await refresh();message="Права Instagram сохранены. Подключите AI-клиенты заново.";
    }else if (form.id === "authForm") {
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
      pendingPage = undefined;
      clearAttempt();
      clients = [];
      clientsState = "idle";
      const authenticatedEpoch = epoch;
      try {
        await refresh();
        selectPage(hasConnection() ? "mcp" : "telegram");
        if (!recoveryCodes.length) await resumeAttempt();
      } catch (error) {
        if (authenticatedEpoch === epoch) showError(error);
      }
    } else if (form.id === "addTelegramAccountForm" && cabinet) {
      const result = await accountRequest<{ account: { id: string } }>("/telegram/accounts", "POST", {
        label: value("label"),
      });
      epoch++;
      clearAttempt();
      selectedTelegramAccount = result.account.id;
      clients = [];
      clientsState = "idle";
      await refresh();
      selectPage("telegram");
      attempt = await accountRequest<Attempt>("/telegram/login", "POST", {});
      timer = window.setTimeout(() => void pollAttempt(attempt!.id, epoch), 200);
      message = "Подтвердите вход в добавляемый аккаунт Telegram. Затем подключите AI-клиенты заново.";
    } else if (form.id === "renameTelegramAccountForm" && cabinet?.telegramAccountId) {
      await accountRequest(`/telegram/accounts/${encodeURIComponent(cabinet.telegramAccountId)}`, "PATCH", {
        label: value("label"),
      });
      await refresh();
      message = "Название сохранено.";
    } else if (form.id === "telegramPasswordForm" && cabinet && attempt) {
      await accountRequest(`/telegram/login/${attempt.id}/password`, "POST", { password });
      attempt = { ...attempt, state: "connecting", dataUrl: undefined };
    } else if (form.id === "policyForm" && cabinet) {
      const normalized = [...new Set(chatIds)].sort();
      if (
        profile === cabinet.policy.profile &&
        JSON.stringify(normalized) === JSON.stringify([...new Set(cabinet.policy.chatIds)].sort())
      ) {
        message = "Права уже сохранены. Подключения клиентов сохранены.";
        return;
      }
      await accountRequest("/policy", "PUT", { profile, chatIds });
      clients = [];
      clientsState = "idle";
      await refresh();
      message = "Права сохранены. Подключите AI-клиенты заново.";
    } else if (form.id === "deleteForm" && cabinet) {
      await accountRequest("/account", "DELETE", { password });
      epoch++;
      pendingPage = undefined;
      clearAttempt();
      cabinet = undefined;
      selectedTelegramAccount = undefined;
      selectedInstagramAccount = undefined; clearInstagramAttempt();
      clients = [];
      clientsState = "idle";
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
    selectPage(pageFromHash() ?? (hasConnection() ? "mcp" : "telegram"));
    await resumeAttempt();
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 401)) {
      startupFailed = !cabinet;
      showError(error);
    }
  }
  render();
  if (cabinet && page === "clients") void dispatchAction("refresh-clients");
}
void start();
