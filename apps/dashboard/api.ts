export interface Cabinet {
  instagram?: {enabled:boolean;accounts:InstagramAccount[]};
  user: { id: string; login: string; hasPassword: boolean };
  csrfToken: string;
  policy: { profile: "read" | "full"; chatIds: string[]; version: number };
  telegram: { state: string; busy: boolean; sessionPresent: boolean; account?: { id: string; username?: string } };
  telegramAccountId?: string;
  accounts?: Array<{
    id: string;
    label: string;
    primary: boolean;
    removalPending?: boolean;
    policy: Cabinet["policy"];
    telegram: Cabinet["telegram"];
  }>;
  mcpUrl: string;
}
export interface Client {
  grantId: string;
  clientId: string;
  name?: string;
  version: number;
}
export interface InstagramAccount {
  id:string;label:string;removalPending:boolean;policy:{profile:"read"|"full";threadIds:string[]};
  instagram:{state:string;busy?:boolean;sessionPresent:boolean;account?:{id:string;username?:string};code?:string;cooldownUntil?:number};
}
export interface InstagramAttempt { id:string;state:string;expiresAt:number;code?:string; }
export interface Attempt {
  id: string;
  state: string;
  expiresAt: number;
  dataUrl?: string;
  code?: string;
}
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
export async function request<T>(path: string, method = "GET", body?: unknown, csrf?: string): Promise<T> {
  const response = await fetch(`/api/saas${path}`, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
    headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new ApiError(response.status, typeof result.error === "string" ? result.error : "request-failed");
  }
  return response.status === 204 ? (undefined as T) : ((await response.json()) as T);
}
