import { randomUUID } from "node:crypto";
import type { SaasAuth } from "./auth.js";
import type { SessionVault } from "./session-vault.js";
import type { SaasStore } from "./store.js";
import type { TelegramAuthEvent, TelegramAuthWorker } from "./telegram-auth-protocol.js";
import type { VerifiedTelegramLogin } from "./types.js";

export interface TelegramAuthView {
  id: string;
  state:
    | "connecting"
    | "token"
    | "needs-password"
    | "verified"
    | "completing"
    | "success"
    | "cancelled"
    | "expired"
    | "error";
  expiresAt: number;
  token?: string;
  tokenExpiresAt?: number;
  code?: string;
}
type Worker = Pick<TelegramAuthWorker, "start" | "submitPassword" | "dispose">;
interface Attempt {
  context: string;
  view: TelegramAuthView;
  worker: Worker;
  proof?: VerifiedTelegramLogin;
  timer: NodeJS.Timeout;
  passwords: number;
}
const terminal = new Set(["success", "cancelled", "expired", "error"]);
export class TelegramAuthAttempts {
  private attempts = new Map<string, Attempt>();
  private owners = new Map<string, string>();
  private closing = false;
  private now: () => number;
  constructor(
    private options: {
      auth: SaasAuth;
      store: SaasStore;
      vault: SessionVault;
      createWorker: () => Worker;
      now?: () => number;
    },
  ) {
    this.now = options.now ?? Date.now;
  }
  async start(contextHash: string): Promise<TelegramAuthView> {
    if (this.closing) throw new Error("Login unavailable");
    const prior = this.owners.get(contextHash);
    if (prior && this.attempts.has(prior)) throw new Error("Login already active");
    const worker = this.options.createWorker(),
      id = randomUUID();
    const attempt: Attempt = {
      context: contextHash,
      view: { id, state: "connecting", expiresAt: this.now() + 300000 },
      worker,
      passwords: 0,
      timer: setTimeout(() => {
        void this.terminate(attempt, "expired").catch(() => {});
      }, 300000),
    };
    attempt.timer.unref();
    this.attempts.set(id, attempt);
    this.owners.set(contextHash, id);
    try {
      await worker.start(id, (event) => this.event(attempt, event));
    } catch (error) {
      await this.terminate(attempt, "error");
      throw error;
    }
    if (this.closing) {
      await this.terminate(attempt, "cancelled");
      throw new Error("Login unavailable");
    }
    return { ...attempt.view };
  }
  private event(attempt: Attempt, event: TelegramAuthEvent) {
    if (
      this.attempts.get(attempt.view.id) !== attempt ||
      terminal.has(attempt.view.state) ||
      attempt.view.state === "completing" ||
      attempt.view.expiresAt <= this.now()
    )
      return;
    delete attempt.view.token;
    delete attempt.view.tokenExpiresAt;
    if (event.type === "token") {
      attempt.view.state = "token";
      attempt.view.token = event.token;
      attempt.view.tokenExpiresAt = event.expiresAt;
    } else if (event.type === "needs-password") attempt.view.state = "needs-password";
    else if (event.type === "verified") {
      attempt.proof = event.proof;
      attempt.view.state = "verified";
    } else {
      attempt.view.code = event.code;
      void this.terminate(attempt, "error").catch(() => {});
    }
  }
  get(contextHash: string, id: string): TelegramAuthView | undefined {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.context !== contextHash) return undefined;
    if (attempt.view.expiresAt <= this.now() && !terminal.has(attempt.view.state))
      void this.terminate(attempt, "expired").catch(() => {});
    return { ...attempt.view };
  }
  password(contextHash: string, id: string, password: string): boolean {
    const view = this.get(contextHash, id),
      attempt = this.attempts.get(id);
    if (!attempt || view?.state !== "needs-password" || !password || password.length > 1024) return false;
    if (++attempt.passwords > 5) {
      void this.terminate(attempt, "error").catch(() => {});
      return false;
    }
    attempt.view.state = "connecting";
    attempt.worker.submitPassword(password);
    return true;
  }
  async complete(contextHash: string, id: string, options: { legacyUserId?: string; authorize?: () => boolean } = {}) {
    const view = this.get(contextHash, id),
      attempt = this.attempts.get(id);
    if (!attempt || view?.state !== "verified" || !attempt.proof) throw new Error("Login not verified");
    attempt.view.state = "completing";
    const proof = attempt.proof;
    try {
      const plan = this.options.store.planTelegramLogin(proof.account, options.legacyUserId);
      await attempt.worker.dispose({ logout: !plan.persistSession });
      if (this.closing || attempt.view.state !== "completing" || attempt.view.expiresAt <= this.now())
        throw new Error("Login expired");
      if (options.authorize && !options.authorize()) throw new Error("Legacy authentication expired");
      const result = this.options.auth.completeTelegramLogin(proof, {
        vault: this.options.vault,
        legacyUserId: options.legacyUserId,
        plan,
      });
      attempt.view.state = "success";
      this.release(attempt);
      return result;
    } catch (error) {
      await this.terminate(attempt, "error");
      throw error;
    }
  }
  private release(attempt: Attempt) {
    clearTimeout(attempt.timer);
    attempt.proof = undefined;
    delete attempt.view.token;
    delete attempt.view.tokenExpiresAt;
    if (this.owners.get(attempt.context) === attempt.view.id) this.owners.delete(attempt.context);
    this.attempts.delete(attempt.view.id);
  }
  private async terminate(attempt: Attempt, state: "cancelled" | "expired" | "error") {
    if (terminal.has(attempt.view.state)) return;
    attempt.view.state = state;
    try {
      await attempt.worker.dispose({ logout: true });
    } finally {
      this.release(attempt);
    }
  }
  async cancel(contextHash: string, id: string): Promise<boolean> {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.context !== contextHash) return false;
    await this.terminate(attempt, "cancelled");
    return true;
  }
  async clearContext(contextHash: string): Promise<void> {
    const id = this.owners.get(contextHash);
    if (id) await this.cancel(contextHash, id);
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.attempts.values()].map((a) => this.terminate(a, "cancelled")));
  }
}
