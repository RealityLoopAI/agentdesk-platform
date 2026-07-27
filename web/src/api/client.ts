import type {
  ConversationHistoryResponse,
  ConversationListResponse,
  ConversationSummary,
  DeliverySubscriptionState,
  MeResponse,
  PublicBranding,
  SubmittedMessage,
} from './types';

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
const authRequiredSubscribers = new Set<() => void>();

export function clearClientCredentials(): void {
  csrfToken = null;
}

export function subscribeAuthenticationRequired(callback: () => void): () => void {
  authRequiredSubscribers.add(callback);
  return () => authRequiredSubscribers.delete(callback);
}

export function notifyAuthenticationRequired(): void {
  clearClientCredentials();
  for (const callback of authRequiredSubscribers) callback();
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
    if (response.status === 401) notifyAuthenticationRequired();
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

export async function listConversations(): Promise<ConversationListResponse> {
  return apiFetch<ConversationListResponse>('/api/conversations');
}

export async function createConversation(agentGroupId: string): Promise<ConversationSummary> {
  const response = await apiFetch<{ conversation: ConversationSummary }>('/api/conversations', {
    method: 'POST',
    json: { agentGroupId },
  });
  return response.conversation;
}

export async function getConversationHistory(
  laneId: string,
  cursor: string | null,
): Promise<ConversationHistoryResponse> {
  const query = new URLSearchParams({ limit: '50' });
  if (cursor) query.set('cursor', cursor);
  return apiFetch<ConversationHistoryResponse>(
    `/api/conversations/${encodeURIComponent(laneId)}/messages?${query.toString()}`,
  );
}

export async function submitMessage(args: {
  laneId: string;
  clientMessageId: string;
  text: string;
}): Promise<SubmittedMessage> {
  const response = await apiFetch<{ message: SubmittedMessage }>(
    `/api/conversations/${encodeURIComponent(args.laneId)}/messages`,
    {
      method: 'POST',
      json: { clientMessageId: args.clientMessageId, text: args.text },
    },
  );
  return response.message;
}

export async function getDeliverySubscription(laneId: string): Promise<DeliverySubscriptionState> {
  const response = await apiFetch<{ subscription: DeliverySubscriptionState }>(
    `/api/conversations/${encodeURIComponent(laneId)}/delivery-subscription`,
  );
  return response.subscription;
}

export async function setDeliverySubscription(args: {
  laneId: string;
  enabled: boolean;
}): Promise<DeliverySubscriptionState> {
  const response = await apiFetch<{ subscription: DeliverySubscriptionState }>(
    `/api/conversations/${encodeURIComponent(args.laneId)}/delivery-subscription`,
    {
      method: 'POST',
      json: { enabled: args.enabled },
    },
  );
  return response.subscription;
}

export async function logout(): Promise<void> {
  await apiFetch<void>('/api/logout', { method: 'POST' });
  notifyAuthenticationRequired();
}
