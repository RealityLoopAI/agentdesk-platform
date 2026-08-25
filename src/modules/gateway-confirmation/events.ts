export type GatewayConfirmationKind = 'create' | 'update' | 'delete';

export interface GatewayConfirmationDeliveredEvent {
  confirmationId: string;
  kind: GatewayConfirmationKind;
  requesterUserId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  resource?: string;
  correlationId?: string;
}

export type GatewayConfirmationResolution = 'approved' | 'rejected' | 'expired' | 'failed';

export interface GatewayConfirmationResolvedEvent {
  confirmationId: string;
  kind: GatewayConfirmationKind;
  status: GatewayConfirmationResolution;
  requesterUserId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
}

export type GatewayConfirmationDeliveredListener = (
  event: GatewayConfirmationDeliveredEvent,
) => void | Promise<void>;

export type GatewayConfirmationResolvedListener = (
  event: GatewayConfirmationResolvedEvent,
) => void | Promise<void>;

const deliveredListeners = new Set<GatewayConfirmationDeliveredListener>();
const resolvedListeners = new Set<GatewayConfirmationResolvedListener>();

/**
 * Subscribe to the non-authoritative observation that a Host confirmation
 * card was successfully handed to its channel adapter.
 *
 * This event carries no approval or authorization capability. Callers must
 * treat correlationId as untrusted correlation-only metadata.
 */
export function onGatewayConfirmationDelivered(
  listener: GatewayConfirmationDeliveredListener,
): () => void {
  deliveredListeners.add(listener);
  return () => deliveredListeners.delete(listener);
}

/**
 * Notify listeners without allowing an auxiliary observer failure to turn a
 * successfully delivered confirmation into a delivery retry.
 */
export async function emitGatewayConfirmationDelivered(
  event: GatewayConfirmationDeliveredEvent,
): Promise<void> {
  await Promise.allSettled([...deliveredListeners].map((listener) => listener(event)));
}

/**
 * Subscribe to the non-authoritative observation that a persisted Host
 * confirmation reached a terminal state.
 *
 * This event cannot approve or execute an operation. Consumers may use it to
 * release auxiliary local work, but authorization continues to rely on the
 * persisted Host confirmation and Worker response.
 */
export function onGatewayConfirmationResolved(
  listener: GatewayConfirmationResolvedListener,
): () => void {
  resolvedListeners.add(listener);
  return () => resolvedListeners.delete(listener);
}

/**
 * Isolate terminal-state observers from the authoritative confirmation path.
 */
export async function emitGatewayConfirmationResolved(
  event: GatewayConfirmationResolvedEvent,
): Promise<void> {
  await Promise.allSettled([...resolvedListeners].map((listener) => listener(event)));
}
