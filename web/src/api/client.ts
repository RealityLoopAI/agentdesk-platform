import type { MeResponse, PublicBranding } from './types';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'ApiError';
  }
}

let csrfToken: string | null = null;

export function clearClientCredentials(): void {
  csrfToken = null;
}

async function parseError(response: Response): Promise<ApiError> {
  let code = `http_${response.status}`;
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') code = body.error;
  } catch {
    // A non-JSON proxy error still becomes a typed HTTP failure.
  }
  return new ApiError(response.status, code);
}

export async function apiFetch<T>(
  path: string,
  init: RequestInit & { json?: Record<string, unknown> } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  let body = init.body;
  if (init.json) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(init.json);
  }
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    if (!csrfToken) throw new ApiError(401, 'authentication_required');
    headers.set('x-csrf-token', csrfToken);
  }
  const response = await fetch(path, {
    ...init,
    body,
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    if (response.status === 401) clearClientCredentials();
    throw await parseError(response);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function getBranding(): Promise<PublicBranding> {
  const response = await apiFetch<{ branding: PublicBranding }>('/api/branding');
  return response.branding;
}

export async function getMe(): Promise<MeResponse> {
  const response = await apiFetch<MeResponse>('/api/me');
  csrfToken = response.csrfToken;
  return response;
}
