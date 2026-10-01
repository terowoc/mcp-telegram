import { randomUUID } from "node:crypto";
import type { WorkerSupervisor } from "./supervisor.js";
import type { LoginEvent } from "./worker-protocol.js";

export type LoginSupervisor = Pick<
  WorkerSupervisor,
  "prepareLogin" | "startLogin" | "submitPassword" | "cancelLogin" | "stopUser" | "status"
>;
export interface LoginAttemptView {
  id: string;
  state: "connecting" | "qr" | "needs-password" | "success" | "error" | "cancelled" | "expired";
  expiresAt: number;
  dataUrl?: string;
  account?: { id: string; username?: string };
  code?: string;
}
interface Attempt {
  userId: string;
  view: LoginAttemptView;
  ttl: NodeJS.Timeout;
  deadline: NodeJS.Timeout;
}
const terminal = new Set(["success", "error", "cancelled", "expired"]);

export class LoginAttempts {
  private attempts = new Map<string, Attempt>();
  private users = new Map<string, string>();
  private closing = false;
  constructor(
    private supervisor: LoginSupervisor,
    private options: { ttlMs?: number; qrDeadlineMs?: number; onLinked?: (userId: string) => void } = {},
  ) {}
  async start(userId: string): Promise<LoginAttemptView> {
    if (this.closing) throw new Error("Login unavailable");
    const old = this.users.get(userId);
    if (old && this.attempts.has(old) && !terminal.has(this.attempts.get(old)?.view.state ?? ""))
      throw new Error("Login already active");
    await this.supervisor.prepareLogin(userId);
    if (this.closing) throw new Error("Login unavailable");
    const id = randomUUID();
    const view: LoginAttemptView = { id, state: "connecting", expiresAt: Date.now() + (this.options.ttlMs ?? 360000) };
    const attempt: Attempt = {
      userId,
      view,
      ttl: setTimeout(() => {
        this.attempts.delete(id);
        if (this.users.get(userId) === id) this.users.delete(userId);
        if (!terminal.has(view.state)) void this.supervisor.cancelLogin(userId, id).catch(() => {});
      }, this.options.ttlMs ?? 360000),
      deadline: setTimeout(() => {
        if (terminal.has(view.state)) return;
        this.setTerminal(attempt, "expired");
        void this.supervisor.cancelLogin(userId, id).catch(() => {});
      }, this.options.qrDeadlineMs ?? 300000),
    };
    attempt.ttl.unref();
    attempt.deadline.unref();
    this.attempts.set(id, attempt);
    this.users.set(userId, id);
    void this.supervisor
      .startLogin(userId, id, (event) => this.event(attempt, event))
      .catch(() => {
        if (!terminal.has(view.state)) {
          this.setTerminal(attempt, "error");
          view.code = "worker-unavailable";
        }
      });
    return { ...view };
  }
  private event(attempt: Attempt, event: LoginEvent) {
    if (
      this.attempts.get(attempt.view.id) !== attempt ||
      terminal.has(attempt.view.state) ||
      attempt.view.expiresAt <= Date.now()
    )
      return;
    delete attempt.view.dataUrl;
    if (event.type === "success") {
      this.options.onLinked?.(attempt.userId);
      this.setTerminal(attempt, "success");
      attempt.view.account = event.account;
    } else if (event.type === "error") {
      this.setTerminal(attempt, "error");
      attempt.view.code = event.code;
    } else if (event.type === "needs-password") attempt.view.state = "needs-password";
    else {
      attempt.view.state = "qr";
      attempt.view.dataUrl = event.dataUrl;
    }
  }
  private setTerminal(attempt: Attempt, state: LoginAttemptView["state"]) {
    clearTimeout(attempt.deadline);
    attempt.view.state = state;
    delete attempt.view.dataUrl;
  }
  get(userId: string, id: string): LoginAttemptView | undefined {
    const attempt = this.attempts.get(id);
    return attempt?.userId === userId && attempt.view.expiresAt > Date.now() ? { ...attempt.view } : undefined;
  }
  password(userId: string, id: string, password: string): boolean {
    const attempt = this.attempts.get(id);
    if (!attempt || !this.get(userId, id) || attempt.view.state !== "needs-password") return false;
    this.supervisor.submitPassword(userId, id, password);
    attempt.view.state = "connecting";
    return true;
  }
  async cancel(userId: string, id: string): Promise<boolean> {
    const attempt = this.attempts.get(id);
    if (!attempt || !this.get(userId, id)) return false;
    if (!terminal.has(attempt.view.state)) {
      this.setTerminal(attempt, "cancelled");
      await this.supervisor.cancelLogin(userId, id);
    }
    return true;
  }
  async clearUser(userId: string) {
    const owned = [...this.attempts.values()].filter((a) => a.userId === userId);
    for (const attempt of owned) {
      this.setTerminal(attempt, "cancelled");
      clearTimeout(attempt.ttl);
      this.attempts.delete(attempt.view.id);
    }
    this.users.delete(userId);
    await Promise.all(owned.map((a) => this.supervisor.cancelLogin(userId, a.view.id)));
  }
  async close() {
    this.closing = true;
    await Promise.all([...this.users.keys()].map((id) => this.clearUser(id)));
  }
}
