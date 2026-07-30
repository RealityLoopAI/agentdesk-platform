import { randomUUID } from 'node:crypto';

import { getDb } from './connection.js';

export type WebEventType =
  | 'conversation.message.accepted'
  | 'conversation.message.available'
  | 'conversation.confirmation.available'
  | 'conversation.confirmation.resolved';

export interface WebEvent {
  sequence: number;
  event_id: string;
  user_id: string;
  lane_id: string;
  event_type: WebEventType;
  resource_id: string;
  created_at: string;
}

export interface WebEventCursor {
  version: 1;
  sequence: number;
}

const subscribers = new Map<string, Set<(event: WebEvent) => void>>();

function requireText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

export function encodeWebEventCursor(sequence: number): string {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('event sequence must be a non-negative integer');
  return Buffer.from(JSON.stringify({ version: 1, sequence } satisfies WebEventCursor)).toString('base64url');
}

export function decodeWebEventCursor(raw: string | null | undefined): WebEventCursor {
  if (!raw) return { version: 1, sequence: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<WebEventCursor>;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.sequence) || parsed.sequence! < 0) {
      throw new Error('invalid event cursor shape');
    }
    return parsed as WebEventCursor;
  } catch (error) {
    throw new Error('invalid_event_cursor', { cause: error });
  }
}

export function appendWebEvent(args: {
  userId: string;
  laneId: string;
  eventType: WebEventType;
  resourceId: string;
  createdAt?: string;
}): { event: WebEvent; created: boolean } {
  const candidate = {
    event_id: `web-event-${randomUUID()}`,
    user_id: requireText('userId', args.userId),
    lane_id: requireText('laneId', args.laneId),
    event_type: args.eventType,
    resource_id: requireText('resourceId', args.resourceId),
    created_at: args.createdAt ?? new Date().toISOString(),
  };
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO web_events
         (event_id, user_id, lane_id, event_type, resource_id, created_at)
       VALUES
         (@event_id, @user_id, @lane_id, @event_type, @resource_id, @created_at)`,
    )
    .run(candidate);
  const event = getDb()
    .prepare(
      `SELECT * FROM web_events
       WHERE user_id = ? AND lane_id = ? AND event_type = ? AND resource_id = ?`,
    )
    .get(candidate.user_id, candidate.lane_id, candidate.event_type, candidate.resource_id) as WebEvent | undefined;
  if (!event) throw new Error('web event insert did not produce a readable row');

  if (result.changes > 0) {
    for (const subscriber of subscribers.get(event.user_id) ?? []) {
      // A disconnected/buggy browser stream must never roll a successfully
      // persisted event back into the message delivery path.
      try {
        subscriber(event);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        // The stream manager owns connection cleanup. Continue notifying other
        // tabs even if one subscriber has already become unusable.
        void error;
      }
    }
  }
  return { event, created: result.changes > 0 };
}

export function listWebEventsAfter(userId: string, sequence: number, limit = 500): WebEvent[] {
  if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error('event sequence must be a non-negative integer');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error('invalid web event page size');
  return getDb()
    .prepare(
      `SELECT * FROM web_events
       WHERE user_id = ? AND sequence > ?
       ORDER BY sequence ASC
       LIMIT ?`,
    )
    .all(userId, sequence, limit) as WebEvent[];
}

export function subscribeWebEvents(userId: string, subscriber: (event: WebEvent) => void): () => void {
  const userSubscribers = subscribers.get(userId) ?? new Set<(event: WebEvent) => void>();
  userSubscribers.add(subscriber);
  subscribers.set(userId, userSubscribers);
  return () => {
    userSubscribers.delete(subscriber);
    if (userSubscribers.size === 0) subscribers.delete(userId);
  };
}

export function clearWebEventSubscribersForTests(): void {
  subscribers.clear();
}
