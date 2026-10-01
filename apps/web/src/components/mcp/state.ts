import type { LoginAttempt, McpClient, McpPanelState, McpPolicy, SaasMe } from './types';

import { revokeMcpCabinet, waitForMcpCleanup } from '../../util/mcpLogin';
import { McpApiError, mcpRequest, type McpRequestOptions } from './api';

const POLL_INTERVAL = 2000;
const ACTIVE_ATTEMPT_STATES = new Set(['connecting', 'qr', 'needs-password']);
type Requester = (path: string, options: McpRequestOptions) => Promise<unknown>;

export class McpPanelController {
  private state: McpPanelState = createSignedOutState();
  private epoch = 0;
  private isOpen = false;
  private isVisible = true;
  private browserAccountId?: string;
  private pending = new Set<AbortController>();
  private pollTimer?: ReturnType<typeof setTimeout>;
  private pollAbort?: AbortController;
  private request: Requester;
  private onChange?: (state: McpPanelState) => void;

  constructor(options: { request?: Requester; onChange?: (state: McpPanelState) => void } = {}) {
    this.request = options.request || mcpRequest;
    this.onChange = options.onChange;
  }

  getState() {
    return this.state;
  }

  async show() {
    if (this.isOpen) return;
    this.isOpen = true;
    this.epoch += 1;
    const epoch = this.epoch;
    this.updateState({ isBusy: true });
    await this.refresh();
    if (this.isCurrent(epoch)) this.updateState({ isBusy: false });
  }

  hide() {
    if (!this.isOpen) return;
    const { attempt, me } = this.state;
    this.isOpen = false;
    this.resetState();
    if (attempt && me && ACTIVE_ATTEMPT_STATES.has(attempt.state)) {
      // Cancellation is best effort; private state is discarded immediately
      void this.request(`/api/saas/telegram/login/${attempt.id}`, {
        method: 'DELETE',
        csrfToken: me.csrfToken,
      }).catch(() => {});
    }
  }

  setBrowserAccount(id?: string) {
    const previous = this.browserAccountId;
    this.browserAccountId = id;
    if (previous && previous !== id) {
      const csrfToken = this.state.me?.csrfToken;
      this.resetState();
      void revokeMcpCabinet({ csrfToken, request: this.request });
      return;
    }
    this.updateState({});
  }

  setVisible(isVisible: boolean) {
    this.isVisible = isVisible;
    this.stopPolling();
    if (isVisible) this.schedulePoll();
  }

  async refresh() {
    if (!this.isOpen) return;
    const cleanup = waitForMcpCleanup();
    if (cleanup) await cleanup;
    let epoch = this.epoch;
    try {
      const me = await this.perform<SaasMe>('/api/saas/me', {}, epoch);
      if (!me || !this.isCurrent(epoch)) return;
      if (this.browserAccountId && me.telegram.account && me.telegram.account.id !== this.browserAccountId) {
        await this.perform('/api/saas/logout', { method: 'POST', csrfToken: me.csrfToken }, epoch);
        if (this.isCurrent(epoch)) this.resetState();
        return;
      }
      if (this.state.me && this.state.me.user.id !== me.user.id) {
        this.resetState();
        epoch = this.epoch;
      }
      this.updateState({ me, isSignedOut: false });
      const result = await this.perform<{ clients: McpClient[] }>('/api/saas/clients', {}, epoch);
      if (result && this.isCurrent(epoch)) this.updateState({ clients: result.clients });
    } catch (err) {
      this.handleError(err, epoch);
    }
  }

  async register(login: string, password: string) {
    await this.mutate(async (epoch) => {
      const result = await this.perform<{ recoveryCodes: string[] }>(
        '/api/saas/register',
        { method: 'POST', body: { login, password } },
        epoch,
      );
      if (!result || !this.isCurrent(epoch)) return;
      this.updateState({ recoveryCodes: result.recoveryCodes });
      await this.refresh();
    });
  }

  async login(login: string, password: string) {
    await this.mutate(async (epoch) => {
      await this.perform('/api/saas/login', { method: 'POST', body: { login, password } }, epoch);
      if (this.isCurrent(epoch)) await this.refresh();
    });
  }

  async recover(login: string, recoveryCode: string, newPassword: string) {
    await this.mutate(async (epoch) => {
      const result = await this.perform<{ recoveryCodes: string[] }>(
        '/api/saas/recover',
        { method: 'POST', body: { login, recoveryCode, newPassword } },
        epoch,
      );
      if (this.isCurrent(epoch)) {
        this.resetState();
        this.updateState({ isRecovered: true, recoveryCodes: result?.recoveryCodes });
      }
    });
  }

  async logout() {
    await this.mutate(async (epoch) => {
      await this.perform('/api/saas/logout', this.createMutation('POST'), epoch);
      if (this.isCurrent(epoch)) this.resetState();
    });
  }

  dismissRecoveryCodes() {
    this.updateState({ recoveryCodes: undefined });
  }

  async startLogin() {
    if (!this.state.me) return;
    await this.mutate(async (epoch) => {
      const attempt = await this.perform<LoginAttempt>(
        '/api/saas/telegram/login',
        this.createMutation('POST'),
        epoch,
      );
      if (attempt && this.isCurrent(epoch)) {
        this.updateState({ attempt });
        this.schedulePoll();
      }
    });
  }

  async cancelLogin() {
    const { attempt } = this.state;
    if (!attempt) return;
    await this.mutate(async (epoch) => {
      await this.perform(`/api/saas/telegram/login/${attempt.id}`, this.createMutation('DELETE'), epoch);
      if (this.isCurrent(epoch)) {
        this.stopPolling();
        this.updateState({ attempt: { ...attempt, state: 'cancelled', dataUrl: undefined } });
      }
    });
  }

  async submitPassword(password: string) {
    const { attempt } = this.state;
    if (!attempt || attempt.state !== 'needs-password') return;
    await this.mutate(async (epoch) => {
      await this.perform(
        `/api/saas/telegram/login/${attempt.id}/password`,
        this.createMutation('POST', { password }),
        epoch,
      );
      if (this.isCurrent(epoch)) {
        this.updateState({ attempt: { ...attempt, state: 'connecting', dataUrl: undefined } });
      }
    });
  }

  async updatePolicy(profile: McpPolicy['profile'], chatIds: string[]) {
    await this.mutate(async (epoch) => {
      await this.perform('/api/saas/policy', this.createMutation('PUT', { profile, chatIds }), epoch);
      if (this.isCurrent(epoch)) await this.refresh();
    });
  }

  async revokeClient(grantId: string) {
    await this.mutate(async (epoch) => {
      await this.perform(`/api/saas/clients/${grantId}`, this.createMutation('DELETE'), epoch);
      if (this.isCurrent(epoch)) await this.refresh();
    });
  }

  async disconnect() {
    await this.mutate(async (epoch) => {
      await this.perform('/api/saas/telegram/disconnect', this.createMutation('POST'), epoch);
      if (this.isCurrent(epoch)) {
        this.stopPolling();
        this.updateState({ attempt: undefined });
        await this.refresh();
      }
    });
  }

  async deleteAccount(password?: string) {
    await this.mutate(async (epoch) => {
      await this.perform(
        '/api/saas/account',
        this.createMutation('DELETE', password === undefined ? { confirm: true } : { password }),
        epoch,
      );
      if (this.isCurrent(epoch)) this.resetState();
    });
  }

  private createMutation(method: McpRequestOptions['method'], body?: unknown): McpRequestOptions {
    return { method, body, csrfToken: this.state.me?.csrfToken };
  }

  private async mutate(work: (epoch: number) => Promise<void>) {
    if (!this.isOpen || this.state.isBusy) return;
    const epoch = this.epoch;
    this.updateState({ isBusy: true, error: undefined });
    try {
      await work(epoch);
    } catch (err) {
      this.handleError(err, epoch);
      // A network failure can follow a committed mutation; refresh, never replay it
      if (err instanceof McpApiError && (err.status === 0 || err.status >= 500) && this.isCurrent(epoch)) {
        await this.refresh();
      }
    } finally {
      if (this.isCurrent(epoch)) this.updateState({ isBusy: false });
    }
  }

  private async perform<T>(
    path: string,
    options: McpRequestOptions,
    epoch: number,
    abort = new AbortController(),
  ): Promise<T | undefined> {
    if (!this.isCurrent(epoch)) return undefined;
    this.pending.add(abort);
    try {
      const value = await this.request(path, { ...options, signal: abort.signal });
      return this.isCurrent(epoch) ? (value as T) : undefined;
    } finally {
      this.pending.delete(abort);
    }
  }

  private isCurrent(epoch: number) {
    return this.isOpen && this.epoch === epoch;
  }

  private handleError(err: unknown, epoch: number) {
    if (!this.isCurrent(epoch)) return;
    if (err instanceof McpApiError && err.status === 401) {
      this.resetState();
      if (err.code === 'invalid-credentials') {
        this.updateState({ error: { status: err.status, code: err.code } });
      }
      return;
    }
    if (err instanceof McpApiError && err.code === 'cancelled') return;
    this.updateState({
      error:
        err instanceof McpApiError
          ? { status: err.status, code: err.code, retryAfter: err.retryAfter }
          : { status: 0, code: 'request-failed' },
    });
  }

  private resetState() {
    this.epoch += 1;
    this.stopPolling();
    this.pending.forEach((abort) => abort.abort());
    this.pending.clear();
    this.state = createSignedOutState();
    this.onChange?.(this.state);
  }

  private updateState(patch: Partial<McpPanelState>) {
    this.state = { ...this.state, ...patch };
    const serverId = this.state.me?.telegram.account?.id;
    this.state.hasMismatch = Boolean(serverId && this.browserAccountId && serverId !== this.browserAccountId);
    this.onChange?.(this.state);
  }

  private stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    this.pollAbort?.abort();
    this.pollAbort = undefined;
  }

  private schedulePoll() {
    if (
      !this.isOpen ||
      !this.isVisible ||
      !this.state.attempt ||
      !ACTIVE_ATTEMPT_STATES.has(this.state.attempt.state) ||
      this.pollAbort ||
      this.pollTimer
    ) { return; }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      void this.poll();
    }, POLL_INTERVAL);
  }

  private async poll() {
    const { attempt } = this.state;
    if (!attempt || !this.isOpen || !this.isVisible) return;
    if (attempt.expiresAt <= Date.now()) {
      this.updateState({ attempt: { ...attempt, state: 'expired', dataUrl: undefined } });
      return;
    }
    const epoch = this.epoch;
    const abort = new AbortController();
    this.pollAbort = abort;
    try {
      const updated = await this.perform<LoginAttempt>(
        `/api/saas/telegram/login/${attempt.id}`,
        {},
        epoch,
        abort,
      );
      if (!updated || !this.isCurrent(epoch)) return;
      this.updateState({ attempt: updated });
      if (updated.state === 'success') await this.refresh();
    } catch (err) {
      if (err instanceof McpApiError && err.status === 404 && this.isCurrent(epoch)) {
        this.updateState({ attempt: { ...attempt, state: 'expired', dataUrl: undefined } });
      } else {
        this.handleError(err, epoch);
      }
    } finally {
      if (this.pollAbort === abort) this.pollAbort = undefined;
      if (this.isCurrent(epoch)) this.schedulePoll();
    }
  }
}

function createSignedOutState(): McpPanelState {
  return { clients: [], isBusy: false, isSignedOut: true, hasMismatch: false };
}
