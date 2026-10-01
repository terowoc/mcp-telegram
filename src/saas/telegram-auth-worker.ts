import { TelegramService } from "../telegram-client.js";
import { type TelegramAuthEvent, telegramAuthParentSchema } from "./telegram-auth-protocol.js";

let telegram: TelegramService | undefined;
let generation: string | undefined, attemptId: string | undefined, saved: string | undefined;
const abort = new AbortController();
let passwordWait: ((password: string | undefined) => void) | undefined;
let stopping = false;
const send = (event: TelegramAuthEvent) => {
  if (!stopping && process.connected) process.send?.({ generation, attemptId, event });
};
async function shutdown(logout: boolean) {
  if (stopping) return;
  stopping = true;
  abort.abort();
  passwordWait?.(undefined);
  try {
    if (logout) await telegram?.logOut();
    await telegram?.disconnect();
  } finally {
    saved = undefined;
    process.exit(0);
  }
}
async function initialize(init: { generation: string; attemptId: string; apiId: number; apiHash: string }) {
  generation = init.generation;
  attemptId = init.attemptId;
  telegram = new TelegramService(init.apiId, init.apiHash, {
    sessionPath: "/tmp/unused-bootstrap-session",
    sessionStore: {
      load: async () => saved,
      hasSession: () => !!saved,
      save: async (session) => {
        saved = session;
      },
      clear: async () => {
        saved = undefined;
      },
    },
  });
  try {
    const outcome = await telegram.startQrLogin(
      () => {},
      (url) => {
        const token = new URL(url).searchParams.get("token");
        if (token) send({ type: "token", token, expiresAt: Date.now() + 30000 });
      },
      abort.signal,
      {
        requestPassword: async () => {
          send({ type: "needs-password" });
          return new Promise<string | undefined>((resolve) => {
            passwordWait = resolve;
            if (abort.signal.aborted) resolve(undefined);
          });
        },
      },
    );
    passwordWait = undefined;
    if (stopping) return;
    if (!outcome.success || !saved) {
      send({ type: "error", code: "login-failed" });
      await shutdown(true);
      return;
    }
    const account = await telegram.getMe();
    send({
      type: "verified",
      proof: {
        attemptId: init.attemptId,
        account: { id: account.id, username: account.username },
        session: saved,
        authenticatedAt: Date.now(),
      },
    });
  } catch {
    send({ type: "error", code: "login-failed" });
    await shutdown(true);
  }
}
process.on("message", (raw) => {
  const parsed = telegramAuthParentSchema.safeParse(raw);
  if (!parsed.success) {
    void shutdown(true);
    return;
  }
  const message = parsed.data;
  if (message.kind === "init") {
    if (generation || stopping) {
      void shutdown(true);
      return;
    }
    void initialize(message);
    return;
  }
  if (message.generation !== generation || message.attemptId !== attemptId) return;
  if (message.kind === "shutdown") void shutdown(message.logout);
  else {
    const resolve = passwordWait;
    passwordWait = undefined;
    resolve?.(message.password);
  }
});
process.on("SIGTERM", () => {
  void shutdown(true);
});
process.on("disconnect", () => {
  void shutdown(true);
});
