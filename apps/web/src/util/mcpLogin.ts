import type { SaasMe } from '../components/mcp/types';

import { mcpRequest } from '../components/mcp/api';

const initialParams = new URLSearchParams(typeof window === 'undefined' ? undefined : window.location.search);
const initialHandle = initialParams.get('mcp_login');
let continuation = initialHandle && /^[A-Za-z0-9_-]{43}$/.test(initialHandle) ? initialHandle : undefined;
let shouldConnect = false;
let hasOpened = false;
const cancellations = new Set<() => Promise<void>>();
let cleanup: Promise<void> = Promise.resolve();
let pendingCleanups = 0;

export function getMcpLoginOptIn() {
  return shouldConnect;
}

export function setMcpLoginOptIn(value: boolean) {
  shouldConnect = value;
  if (value) hasOpened = false;
}

export function getMcpLoginEntry() {
  return { continuation, isLegacy: initialParams.get('mcp_legacy') === '1' };
}

export function consumeMcpLoginEntry() {
  if (hasOpened || (!continuation && !shouldConnect)) return undefined;
  hasOpened = true;
  const shouldStart = shouldConnect;
  shouldConnect = false;
  return { shouldStart, continuation };
}

export function subscribeMcpCancellation(cancel: () => Promise<void>) {
  cancellations.add(cancel);
  return () => {
    cancellations.delete(cancel);
  };
}

export function revokeMcpCabinet(options: {
  csrfToken?: string;
  request?: (path: string, options: NonNullable<Parameters<typeof mcpRequest>[1]>) => Promise<unknown>;
} = {}) {
  pendingCleanups += 1;
  cleanup = cleanup.then(async () => {
    try {
      const request = options.request || mcpRequest;
      const csrfToken = options.csrfToken || (await request('/api/saas/me', {}) as SaasMe).csrfToken;
      await request('/api/saas/logout', { method: 'POST', csrfToken });
    } catch { /* An absent or expired cabinet is already signed out */ } finally {
      pendingCleanups -= 1;
    }
  });
  return cleanup;
}

export async function clearMcpLogin() {
  shouldConnect = false;
  hasOpened = false;
  continuation = undefined;
  await Promise.allSettled([...cancellations].map((cancel) => cancel()));
  try {
    const context = await mcpRequest<{ csrfToken: string }>('/api/saas/telegram-auth/start', { method: 'POST' });
    await mcpRequest('/api/saas/telegram-auth/revoke', { method: 'POST', csrfToken: context.csrfToken });
  } catch { /* The server expiry also fences unavailable bootstrap contexts */ }
  await revokeMcpCabinet();
}

export function waitForMcpCleanup() {
  return pendingCleanups ? cleanup : undefined;
}
