const REQUEST_TIMEOUT = 15000;
const SAFE_PATH = /^\/api\/saas\/[a-zA-Z0-9/_-]+$/;

export type McpRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  csrfToken?: string;
  signal?: AbortSignal;
};

export class McpApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryAfter?: number,
  ) {
    super(`MCP request failed (${status})`);
  }
}

export async function mcpRequest<T>(path: string, options: McpRequestOptions = {}): Promise<T> {
  if (!SAFE_PATH.test(path)) throw new McpApiError(0, 'invalid-path');
  const headers = new Headers({ 'Content-Type': 'application/json' });
  if (options.csrfToken) headers.set('X-CSRF-Token', options.csrfToken);
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
    : AbortSignal.timeout(REQUEST_TIMEOUT);
  let response: Response;
  try {
    response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      signal,
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new McpApiError(0, options.signal?.aborted ? 'cancelled' : 'network-error');
  }
  if (response.status === 204) return undefined as T;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new McpApiError(response.status, 'invalid-response');
  }
  if (!response.ok) {
    const code =
      typeof body === 'object' &&
      body &&
      'error' in body &&
      typeof body.error === 'string' &&
      /^[a-z0-9_-]{1,64}$/.test(body.error)
        ? body.error
        : 'request-failed';
    const retryValue = response.headers.get('Retry-After');
    const retryAfter = retryValue && /^\d{1,5}$/.test(retryValue) ? Number(retryValue) : undefined;
    throw new McpApiError(response.status, code, retryAfter);
  }
  return body as T;
}
