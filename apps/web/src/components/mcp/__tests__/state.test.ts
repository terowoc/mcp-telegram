import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SaasMe } from '../types';

import { McpApiError } from '../api';
import { McpPanelController } from '../state';

const ME: SaasMe = {
  user: { id: 'saas-A', login: 'alice' },
  csrfToken: 'csrf',
  policy: { profile: 'read', chatIds: [], version: 1 },
  telegram: { state: 'ready', busy: false, sessionPresent: true, account: { id: '111', username: 'alice' } },
  mcpUrl: 'https://mcp.example.test/mcp',
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

afterEach(() => vi.useRealTimers());

describe('ephemeral MCP panel lifecycle', () => {
  it('recovery confirms a new password and clears that confirmation on close', async () => {
    const request = vi.fn((path) => path.endsWith('/me')
      ? Promise.reject(new McpApiError(401, 'authentication-required'))
      : Promise.resolve({ ok: true, recoveryCodes: ['replacement-private-code'] }));
    const controller = new McpPanelController({ request });
    await controller.show();
    await controller.recover('alice', 'single-use-code', 'a new private login password');
    expect(controller.getState().isRecovered).toBe(true);
    expect(controller.getState().recoveryCodes).toEqual(['replacement-private-code']);
    expect(controller.getState().me).toBeUndefined();
    controller.hide();
    expect(controller.getState().isRecovered).toBeUndefined();
    expect(controller.getState().recoveryCodes).toBeUndefined();
  });
  it('blocks registration until the initial cookie check settles', async () => {
    let reject: (error: unknown) => void;
    const request = vi.fn(
      () =>
        new Promise((_, fail) => {
          reject = fail;
        }),
    );
    const controller = new McpPanelController({ request });
    const showing = controller.show();
    expect(controller.getState().isBusy).toBe(true);
    await controller.register('alice', 'a private login password');
    expect(request).toHaveBeenCalledTimes(1);
    reject!(new McpApiError(401, 'authentication-required'));
    await showing;
    expect(controller.getState().isBusy).toBe(false);
    controller.hide();
  });
  it('shows invalid login feedback without retaining private state', async () => {
    const request = vi.fn(async (path) => {
      await Promise.resolve();
      throw new McpApiError(401, path.endsWith('/login') ? 'invalid-credentials' : 'authentication-required');
    });
    const controller = new McpPanelController({ request });
    await controller.show();
    await controller.login('alice', 'wrong private password');
    expect(controller.getState().error?.code).toBe('invalid-credentials');
    expect(controller.getState().me).toBeUndefined();
    controller.hide();
  });
  it('a different SaaS cookie clears the former recovery codes and login attempt', async () => {
    let me = ME;
    const request = vi.fn(async (path) => {
      await Promise.resolve();
      if (path.endsWith('/me')) return me;
      if (path.endsWith('/register')) return { recoveryCodes: ['former-private-code'] };
      if (path.endsWith('/telegram/login')) {
        return { id: 'former-attempt', state: 'qr', expiresAt: Date.now() + 300000 };
      }
      return { clients: [] };
    });
    const controller = new McpPanelController({ request });
    await controller.show();
    await controller.register('alice', 'a private login password');
    await controller.startLogin();
    me = { ...ME, user: { id: 'saas-B', login: 'bob' } };
    await controller.refresh();
    expect(controller.getState().me?.user.id).toBe('saas-B');
    expect(controller.getState().recoveryCodes).toBeUndefined();
    expect(controller.getState().attempt).toBeUndefined();
    controller.hide();
  });
  it('closing the panel cancels polling and clears recovery codes', async () => {
    vi.useFakeTimers();
    const request = vi.fn(async (path, options) => {
      await Promise.resolve();
      if (path.endsWith('/register')) {
        return { user: ME.user, csrfToken: 'csrf', recoveryCodes: ['private-recovery-code'] };
      }
      if (path.endsWith('/me')) return ME;
      if (path.endsWith('/clients')) return { clients: [] };
      if (path.endsWith('/telegram/login') && options.method === 'POST') {
        return {
          id: 'attempt',
          state: 'qr',
          expiresAt: Date.now() + 300000,
          dataUrl: 'data:image/png;base64,AA==',
        };
      }
      if (options.method === 'DELETE') return undefined;
      return { id: 'attempt', state: 'needs-password', expiresAt: Date.now() + 300000 };
    });
    const controller = new McpPanelController({ request });
    await controller.show();
    await controller.register('alice', 'a private login password');
    expect(controller.getState().recoveryCodes).toEqual(['private-recovery-code']);
    await controller.startLogin();
    await flush();
    controller.hide();
    const count = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(request.mock.calls.length).toBe(count);
    expect(controller.getState().recoveryCodes).toBeUndefined();
    expect(controller.getState().me).toBeUndefined();
    expect(controller.getState().attempt).toBeUndefined();
  });
  it('account switching clears former cabinet and revokes its browser cookie', async () => {
    const request = vi.fn((path) => Promise.resolve(path.endsWith('/me') ? ME : { clients: [] }));
    const controller = new McpPanelController({ request });
    controller.setBrowserAccount('111');
    await controller.show();
    expect(controller.getState().hasMismatch).toBe(false);
    controller.setBrowserAccount('222');
    expect(controller.getState().me).toBeUndefined();
    expect(controller.getState().hasMismatch).toBe(false);
    await flush();
    expect(request).toHaveBeenCalledWith('/api/saas/logout', { method: 'POST', csrfToken: ME.csrfToken });
    expect(
      request.mock.calls.every(([path]) => [
        '/api/saas/me', '/api/saas/clients', '/api/saas/logout',
      ].includes(path)),
    ).toBe(true);
    controller.hide();
  });
  it('late results cannot restore the identity or codes after closing', async () => {
    let resolve: (value: SaasMe) => void;
    const request = vi.fn(
      () =>
        new Promise<SaasMe>((done) => {
          resolve = done;
        }),
    );
    const controller = new McpPanelController({ request });
    const showing = controller.show();
    controller.hide();
    resolve!(ME);
    await showing;
    expect(controller.getState().me).toBeUndefined();
    expect(controller.getState().recoveryCodes).toBeUndefined();
    expect(request.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it('QR expiry and 401 clear state and never claim a connection', async () => {
    vi.useFakeTimers();
    let unauthorized = false;
    const request = vi.fn(async (path) => {
      await Promise.resolve();
      if (unauthorized) throw new McpApiError(401, 'authentication-required');
      if (path.endsWith('/me')) {
        return { ...ME, telegram: { state: 'stopped', busy: false, sessionPresent: false } };
      }
      if (path.endsWith('/clients')) return { clients: [] };
      return {
        id: 'attempt',
        state: 'qr',
        expiresAt: Date.now() + 1000,
        dataUrl: 'data:image/png;base64,AA==',
      };
    });
    const controller = new McpPanelController({ request });
    await controller.show();
    await controller.startLogin();
    await vi.advanceTimersByTimeAsync(2000);
    expect(controller.getState().attempt?.state).toBe('expired');
    expect(controller.getState().me?.telegram.sessionPresent).toBe(false);
    unauthorized = true;
    await controller.refresh();
    expect(controller.getState().me).toBeUndefined();
    expect(controller.getState().attempt).toBeUndefined();
    expect(controller.getState().isSignedOut).toBe(true);
    controller.hide();
  });
});
