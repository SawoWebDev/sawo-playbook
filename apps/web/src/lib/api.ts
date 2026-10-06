/**
 * API client. The access token lives only in memory (§7.4) — never in
 * localStorage/sessionStorage. On 401 we try one silent refresh using the
 * HttpOnly refresh cookie, then retry the original request once.
 */

/**
 * The five assignable roles, using the wire values the API returns. OPERATOR is the Viewer role.
 * OWNER and TRAINER are legacy database values only: they are never assignable and are not part of this type.
 */
export type Role = 'ADMIN' | 'OPERATOR' | 'EDITOR' | 'PRE_APPROVER' | 'APPROVER';

export interface SessionUser {
  id: string;
  organizationId: string;
  email: string;
  name: string;
  role: Role;
  /** Effective permission strings for this user, from GET /auth/me. Empty until loaded. */
  permissions: string[];
  /** The user's current group IDs, from GET /auth/me. */
  groupIds: string[];
}

/** The authorisation context returned by GET /auth/me (display only; the server enforces every request). */
export interface AuthContext {
  permissions: string[];
  groupIds: string[];
}

export function fetchAuthContext(): Promise<AuthContext> {
  return api<AuthContext>('/auth/me');
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(extractMessage(body) ?? `Request failed (${status})`);
  }
}

function extractMessage(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message: unknown }).message;
    if (Array.isArray(m)) return m.join(', ');
    if (typeof m === 'string') return m;
  }
  return undefined;
}

let accessToken: string | null = null;
let refreshInFlight: Promise<SessionResponse | null> | null = null;
const listeners = new Set<(u: SessionUser | null) => void>();

export function onSessionChange(fn: (u: SessionUser | null) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function applySession(s: SessionResponse | null) {
  accessToken = s?.accessToken ?? null;
  listeners.forEach((fn) => fn(s?.user ?? null));
}

/** Single-flight refresh so parallel 401s trigger only one rotation. */
export function refreshSession(): Promise<SessionResponse | null> {
  refreshInFlight ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(async (r) => (r.ok ? ((await r.json()) as SessionResponse) : null))
    .catch(() => null)
    .then((s) => {
      applySession(s);
      return s;
    })
    .finally(() => {
      refreshInFlight = null;
    });
  return refreshInFlight;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  /** Raw body (e.g. FormData / Blob); bypasses JSON encoding. */
  rawBody?: BodyInit;
  headers?: Record<string, string>;
}

async function doFetch(path: string, opts: RequestOptions): Promise<Response> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  let body: BodyInit | undefined = opts.rawBody;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetch(`/api${path}`, { method: opts.method ?? 'GET', headers, body, credentials: 'same-origin' });
}

export async function apiRaw(path: string, opts: RequestOptions = {}): Promise<Response> {
  let res = await doFetch(path, opts);
  if (res.status === 401 && !path.startsWith('/auth/')) {
    const s = await refreshSession();
    if (s) res = await doFetch(path, opts);
  }
  return res;
}

export async function api<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await apiRaw(path, opts);
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, data);
  return data as T;
}

/** Multipart upload with progress (fetch cannot report upload progress). Refreshes the session once on a 401. */
export async function apiUpload<T = unknown>(path: string, form: FormData, onProgress?: (loaded: number, total: number) => void): Promise<T> {
  const send = () =>
    new Promise<{ status: number; text: string }>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api${path}`);
      xhr.withCredentials = true;
      if (accessToken) xhr.setRequestHeader('Authorization', `Bearer ${accessToken}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress?.(e.loaded, e.total);
      };
      xhr.onload = () => resolve({ status: xhr.status, text: xhr.responseText });
      xhr.onerror = () => reject(new Error('The upload was interrupted'));
      xhr.send(form);
    });
  let res = await send();
  if (res.status === 401 && (await refreshSession())) res = await send();
  const data = res.text ? safeJson(res.text) : undefined;
  if (res.status < 200 || res.status >= 300) throw new ApiError(res.status, data);
  return data as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
}

/** Password step. Returns an MFA challenge instead of a session when the account has MFA enabled. */
export async function login(email: string, password: string): Promise<SessionUser | MfaChallenge> {
  const s = await api<SessionResponse | MfaChallenge>('/auth/login', { method: 'POST', body: { email, password } });
  if ('mfaRequired' in s) return s;
  applySession(s);
  return s.user;
}

export async function loginMfa(mfaToken: string, code: string): Promise<SessionUser> {
  const s = await api<SessionResponse>('/auth/login/mfa', { method: 'POST', body: { mfaToken, code } });
  applySession(s);
  return s.user;
}

/** For endpoints that rotate the session (password change, MFA enable) and return a new access token. */
export function adoptSession(s: SessionResponse) {
  applySession(s);
}

export async function signup(input: {
  organizationName: string;
  name: string;
  email: string;
  password: string;
}): Promise<SessionUser> {
  const s = await api<SessionResponse>('/auth/signup', { method: 'POST', body: input });
  applySession(s);
  return s.user;
}

export async function acceptInvite(input: { token: string; name: string; password: string }): Promise<SessionUser> {
  const s = await api<SessionResponse>('/auth/accept-invite', { method: 'POST', body: input });
  applySession(s);
  return s.user;
}

export async function logout(): Promise<void> {
  await fetch('/api/auth/refresh/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => undefined);
  applySession(null);
}
