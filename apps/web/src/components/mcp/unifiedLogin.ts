import type { UnifiedLoginAttempt, UnifiedLoginState } from './types';

import { revokeMcpCabinet, waitForMcpCleanup } from '../../util/mcpLogin';
import { callApi } from '../../api/gramjs';
import { McpApiError, mcpRequest } from './api';

const POLL_INTERVAL = 2000;
const PREFIX = '/api/saas/telegram-auth';
const ACTIVE_STATES = new Set(['connecting', 'token', 'needs-password', 'verified', 'completing']);

export class UnifiedLoginController {
  private state: UnifiedLoginState = { isBusy: false, isManual: false };
  private epoch = 0;
  private browserAccountId?: string;
  private csrfToken?: string;
  private timer?: ReturnType<typeof setTimeout>;
  private accepted = new Set<string>();
  private pending = new Set<Promise<unknown>>();
  private teardown: Promise<void> = Promise.resolve();
  private shouldLinkLegacy = false;

  constructor(private options: {
    onChange: (state: UnifiedLoginState) => void;
    onSuccess: () => Promise<void>;
  }) {}

  getState() { return this.state; }

  setBrowserAccount(id?: string) {
    if (this.browserAccountId && this.browserAccountId !== id) void this.revokeContext();
    this.browserAccountId = id;
  }

  async start(options: { continuation?: string; isManual?: boolean; shouldLinkLegacy?: boolean } = {}) {
    await this.cancel();
    await waitForMcpCleanup();
    const epoch = ++this.epoch;
    this.shouldLinkLegacy = Boolean(options.shouldLinkLegacy);
    this.accepted.clear();
    this.updateState({ attempt: undefined, error: undefined, requiresLegacy: false,
      isBusy: true, isManual: Boolean(options.isManual) });
    try {
      const context = await this.request<{ csrfToken: string }>(`${PREFIX}/start`, { method: 'POST' });
      if (epoch !== this.epoch) return;
      this.csrfToken = context.csrfToken;
      const attempt = await this.request<UnifiedLoginAttempt>(`${PREFIX}/start`, {
        method: 'POST', csrfToken: this.csrfToken, body: { continuation: options.continuation },
      });
      if (epoch !== this.epoch) {
        await mcpRequest(`${PREFIX}/${attempt.id}`, { method: 'DELETE', csrfToken: context.csrfToken }).catch(() => {});
        return;
      }
      await this.processAttempt(attempt, epoch);
    } catch (err) { this.handleError(err, epoch); } finally {
      if (epoch === this.epoch) this.updateState({ isBusy: false });
    }
  }

  async submitPassword(password: string) {
    const attempt = this.state.attempt;
    if (!attempt || attempt.state !== 'needs-password' || this.state.isBusy) return;
    const epoch = this.epoch;
    this.updateState({ isBusy: true, error: undefined });
    try {
      await this.request(`${PREFIX}/${attempt.id}/password`, {
        method: 'POST', csrfToken: this.csrfToken, body: { password },
      });
      if (epoch === this.epoch) {
        this.updateState({ attempt: { ...attempt, state: 'connecting' } });
        this.schedulePoll(epoch);
      }
    } catch (err) { this.handleError(err, epoch); } finally {
      if (epoch === this.epoch) this.updateState({ isBusy: false });
    }
  }

  async complete(options: { legacyPassword?: string } = {}) {
    const attempt = this.state.attempt;
    if (!attempt || attempt.state !== 'verified') return;
    const epoch = this.epoch;
    clearTimeout(this.timer);
    this.updateState({ attempt: { ...attempt, state: 'completing' }, isBusy: true, error: undefined });
    try {
      const result = await this.request<{ continueTo?: string; csrfToken: string }>(
        `${PREFIX}/${attempt.id}/complete`, {
          method: 'POST', csrfToken: this.csrfToken, body: options,
        },
      );
      if (epoch !== this.epoch) {
        await revokeMcpCabinet({ csrfToken: result.csrfToken });
        return;
      }
      this.updateState({ attempt: { ...attempt, state: 'success', token: undefined }, requiresLegacy: false });
      await this.options.onSuccess();
      if (epoch !== this.epoch) {
        await revokeMcpCabinet({ csrfToken: result.csrfToken });
        return;
      }
      if (result.continueTo && /^\/interaction\/[A-Za-z0-9_-]{1,128}$/.test(result.continueTo)) {
        window.location.assign(result.continueTo);
      }
    } catch (err) { this.handleError(err, epoch); } finally {
      if (epoch === this.epoch) this.updateState({ isBusy: false });
    }
  }

  async cancel() {
    this.epoch += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    const attempt = this.state.attempt;
    const csrfToken = this.csrfToken;
    this.updateState({ attempt: undefined, error: undefined, isBusy: false, requiresLegacy: false });
    const pending = [...this.pending];
    this.teardown = this.teardown.then(async () => {
      if (attempt && ACTIVE_STATES.has(attempt.state)) {
        await mcpRequest(`${PREFIX}/${attempt.id}`, { method: 'DELETE', csrfToken }).catch(() => {});
      }
      await Promise.allSettled(pending);
    });
    await this.teardown;
  }

  async revokeContext() {
    const csrfToken = this.csrfToken;
    const revocation = csrfToken
      ? mcpRequest(`${PREFIX}/revoke`, { method: 'POST', csrfToken }).catch(() => {}) : Promise.resolve();
    const cancellation = this.cancel();
    this.teardown = Promise.allSettled([revocation, cancellation]).then(() => {});
    await this.teardown;
    this.csrfToken = undefined;
  }

  async resume(continuation: string) {
    const epoch = this.epoch;
    try {
      const context = await this.request<{ csrfToken: string }>(`${PREFIX}/start`, { method: 'POST' });
      if (epoch !== this.epoch) return;
      const result = await this.request<{ continueTo: string }>(`${PREFIX}/resume`, {
        method: 'POST', csrfToken: context.csrfToken, body: { continuation },
      });
      if (epoch === this.epoch && /^\/interaction\/[A-Za-z0-9_-]{1,128}$/.test(result.continueTo)) {
        window.location.assign(result.continueTo);
      }
    } catch (err) { this.handleError(err, epoch); }
  }

  private async request<T>(path: string, options: Parameters<typeof mcpRequest>[1]): Promise<T> {
    const pending = mcpRequest<T>(path, options);
    this.pending.add(pending);
    try {
      return await pending;
    } finally {
      this.pending.delete(pending);
    }
  }

  private async processAttempt(attempt: UnifiedLoginAttempt, epoch: number) {
    if (epoch !== this.epoch) return;
    this.updateState({ attempt });
    if (attempt.state === 'verified') {
      if (this.shouldLinkLegacy) this.updateState({ requiresLegacy: true });
      else await this.complete();
      return;
    }
    if (attempt.state === 'token' && attempt.token && attempt.tokenExpiresAt! > Date.now()
      && !this.state.isManual && !this.accepted.has(attempt.token)) {
      if (!this.browserAccountId) throw new McpApiError(409, 'browser-login-required');
      const token = attempt.token;
      this.accepted.add(token);
      const accepted = await callApi('acceptMcpLoginToken', { token, browserTelegramId: this.browserAccountId });
      if (epoch !== this.epoch) return;
      if (!accepted) this.updateState({ error: { status: 409, code: 'bridge-failed' } });
    }
    this.schedulePoll(epoch);
  }

  private schedulePoll(epoch: number) {
    clearTimeout(this.timer);
    const attempt = this.state.attempt;
    if (!attempt || !ACTIVE_STATES.has(attempt.state) || attempt.state === 'verified') return;
    this.timer = setTimeout(async () => {
      if (epoch !== this.epoch) return;
      if (attempt.expiresAt <= Date.now()) {
        this.updateState({ attempt: { ...attempt, state: 'expired', token: undefined } });
        return;
      }
      try {
        const updated = await this.request<UnifiedLoginAttempt>(`${PREFIX}/${attempt.id}`, {});
        await this.processAttempt(updated, epoch);
      } catch (err) { this.handleError(err, epoch); }
    }, POLL_INTERVAL);
  }

  private handleError(err: unknown, epoch: number) {
    if (epoch !== this.epoch) return;
    const error = err instanceof McpApiError ? { status: err.status, code: err.code, retryAfter: err.retryAfter }
      : { status: 0, code: 'request-failed' };
    const attempt = this.state.attempt;
    const canRetryPassword = error.code === 'invalid-credentials' && attempt?.state === 'completing';
    this.updateState({
      attempt: attempt ? { ...attempt, state: canRetryPassword ? 'verified' : 'error', token: undefined } : undefined,
      error,
      requiresLegacy: error.code === 'legacy-link-required' || this.state.requiresLegacy,
    });
  }

  private updateState(patch: Partial<UnifiedLoginState>) {
    this.state = { ...this.state, ...patch };
    this.options.onChange(this.state);
  }
}
