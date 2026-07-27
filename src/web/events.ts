import type { IncomingMessage, ServerResponse } from 'node:http';

import { getConversationLane } from '../db/conversation-lanes.js';
import {
  decodeWebEventCursor,
  encodeWebEventCursor,
  listWebEventsAfter,
  subscribeWebEvents,
  type WebEvent,
} from '../db/web-events.js';
import { authenticateWebSession, type AuthenticatedWebSession } from '../db/web-auth.js';
import { log } from '../log.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import type { WebConfig } from './config.js';

const REPLAY_PAGE_SIZE = 500;
const DEFAULT_HEARTBEAT_MS = 15_000;

export class WebEventStreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'WebEventStreamError';
  }
}

export interface WebEventPayload {
  eventId: string;
  cursor: string;
  type: WebEvent['event_type'];
  laneId: string;
  resourceId: string;
  createdAt: string;
}

export interface WebEventStreamManager {
  open(args: {
    req: IncomingMessage;
    res: ServerResponse;
    token: string;
    authenticated: AuthenticatedWebSession;
    cursor: string | null;
  }): void;
  connectionCount(userId: string): number;
  closeAll(): void;
}

function accessibleToUser(event: WebEvent, userId: string): boolean {
  const lane = getConversationLane(event.lane_id);
  return Boolean(
    lane &&
    lane.owner_user_id === userId &&
    lane.status === 'active' &&
    canAccessAgentGroup(userId, lane.agent_group_id).allowed,
  );
}

function payload(event: WebEvent): WebEventPayload {
  return {
    eventId: event.event_id,
    cursor: encodeWebEventCursor(event.sequence),
    type: event.event_type,
    laneId: event.lane_id,
    resourceId: event.resource_id,
    createdAt: event.created_at,
  };
}

function eventFrame(event: WebEvent): string {
  const item = payload(event);
  return `id: ${item.cursor}\nevent: web-event\ndata: ${JSON.stringify(item)}\n\n`;
}

export function createWebEventStreamManager(
  config: WebConfig,
  options: { heartbeatMs?: number } = {},
): WebEventStreamManager {
  const connections = new Map<string, Set<() => void>>();
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10) throw new Error('invalid SSE heartbeat interval');

  function connectionCount(userId: string): number {
    return connections.get(userId)?.size ?? 0;
  }

  function open(args: {
    req: IncomingMessage;
    res: ServerResponse;
    token: string;
    authenticated: AuthenticatedWebSession;
    cursor: string | null;
  }): void {
    let afterSequence: number;
    try {
      afterSequence = decodeWebEventCursor(args.cursor).sequence;
    } catch {
      throw new WebEventStreamError(400, 'invalid_event_cursor');
    }

    const userId = args.authenticated.session.user_id;
    if (connectionCount(userId) >= config.sseMaxConnectionsPerUser) {
      throw new WebEventStreamError(429, 'sse_connection_limit');
    }

    args.res.statusCode = 200;
    args.res.setHeader('content-type', 'text/event-stream; charset=utf-8');
    args.res.setHeader('cache-control', 'no-store, no-transform');
    args.res.setHeader('connection', 'keep-alive');
    args.res.setHeader('x-accel-buffering', 'no');
    args.res.flushHeaders();
    args.res.setTimeout(0);
    args.req.socket.setTimeout(0);

    let closed = false;
    let lastSequence = afterSequence;
    const timers: { heartbeat?: NodeJS.Timeout } = {};
    let unsubscribe = () => {};

    const close = (): void => {
      if (closed) return;
      closed = true;
      if (timers.heartbeat) clearInterval(timers.heartbeat);
      unsubscribe();
      args.req.off('aborted', close);
      args.res.off('close', close);
      const userConnections = connections.get(userId);
      userConnections?.delete(close);
      if (userConnections?.size === 0) connections.delete(userId);
      if (!args.res.writableEnded) args.res.end();
    };

    const write = (chunk: string): boolean => {
      if (closed || args.res.writableEnded || args.res.destroyed) {
        close();
        return false;
      }
      let accepted: boolean;
      try {
        accepted = args.res.write(chunk);
        // eslint-disable-next-line no-catch-all/no-catch-all
      } catch (error) {
        log.warn('Web SSE response write failed; closing the connection', {
          userId,
          errorName: error instanceof Error ? error.name : 'unknown',
        });
        close();
        return false;
      }
      if (!accepted) {
        log.warn('Web SSE connection closed because the client exceeded backpressure capacity', { userId });
        close();
        return false;
      }
      return true;
    };

    const send = (event: WebEvent): void => {
      if (event.sequence <= lastSequence) return;
      lastSequence = event.sequence;
      if (accessibleToUser(event, userId)) write(eventFrame(event));
    };

    const userConnections = connections.get(userId) ?? new Set<() => void>();
    userConnections.add(close);
    connections.set(userId, userConnections);
    args.req.on('aborted', close);
    args.res.on('close', close);

    // Subscribe before replay. Both replay reads and append notifications are
    // synchronous in this single Host process, so no event can fall into a gap
    // between the two operations.
    unsubscribe = subscribeWebEvents(userId, send);
    while (!closed) {
      const replay = listWebEventsAfter(userId, lastSequence, REPLAY_PAGE_SIZE);
      if (replay.length === 0) break;
      for (const event of replay) {
        send(event);
        if (closed) break;
      }
      if (replay.length < REPLAY_PAGE_SIZE) break;
    }

    if (closed) return;
    timers.heartbeat = setInterval(() => {
      const current = authenticateWebSession({
        token: args.token,
        secret: config.sessionSecret,
        policy: config.sessionPolicy,
        touch: false,
      });
      if (!current || current.session.user_id !== userId) {
        write(`event: session-revoked\ndata: {"reason":"authentication_required"}\n\n`);
        close();
        return;
      }
      write(': heartbeat\n\n');
    }, heartbeatMs);
    timers.heartbeat.unref?.();
  }

  return {
    open,
    connectionCount,
    closeAll() {
      for (const userConnections of [...connections.values()]) {
        for (const close of [...userConnections]) close();
      }
    },
  };
}
