import { afterEach, describe, expect, it, vi } from 'vitest';

import { McpApiError, mcpRequest } from '../api';

afterEach(() => vi.unstubAllGlobals());

describe('MCP browser API boundary', () => {
  it('rejects external and traversal URLs before issuing a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const path of [
      'https://other.invalid/api/saas/me',
      '//other.invalid/api/saas/me',
      '/api/saas/../oauth',
      '/api/saas/%2e%2e/me',
    ]) {
      await expect(mcpRequest(path, {})).rejects.toThrow();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses same-origin cookies, adds CSRF and never puts a password in the URL', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(undefined, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await mcpRequest('/api/saas/telegram/login/attempt/password', {
      method: 'POST',
      body: { password: 'transient-password' },
      csrfToken: 'csrf',
    });
    const [path, options] = fetch.mock.calls[0];
    expect(path).toBe('/api/saas/telegram/login/attempt/password');
    expect(options.credentials).toBe('same-origin');
    expect(options.cache).toBe('no-store');
    expect(options.redirect).toBe('error');
    expect(new Headers(options.headers).get('X-CSRF-Token')).toBe('csrf');
    expect(options.body).toBe(JSON.stringify({ password: 'transient-password' }));
  });
  it('redacts server error details while retaining capacity retry metadata', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: 'capacity', session: 'private-session' }), {
            status: 503,
            headers: { 'Retry-After': '30' },
          }),
        ),
    );
    try {
      await mcpRequest('/api/saas/me', {});
      throw new Error('Expected capacity error');
    } catch (err) {
      expect(err).toBeInstanceOf(McpApiError);
      expect(err.retryAfter).toBe(30);
      expect(err.message).not.toContain('private-session');
    }
  });
});
