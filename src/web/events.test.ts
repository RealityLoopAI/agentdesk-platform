import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb } from '../db/connection.js';
import { appendWebEvent, encodeWebEventCursor } from '../db/web-events.js';
import { createWebAuthSession, revokeWebAuthSessionByToken } from '../db/web-auth.js';
import { runMigrations } from '../db/migrations/index.js';
import { webSseConnections, webSseEventsTotal } from '../metrics.js';
import type { WebConfig } from './config.js';
import { createWebEventStreamManager, WebEventStreamError } from './events.js';

const SECRET = '82a60d53458239ca70aa1294ef743477cd8772d778d32962362674e3237a20d2';
const NOW = '2026-07-27T10:00:00.000Z';

function config(maxConnections = 2): WebConfig {
  return {
    enabled: true,
    port: 3100,
    publicOrigin: 'https://agent.example.com',
    redirectUri: 'https://agent.example.com/auth/feishu/callback',
    sessionSecret: SECRET,
    sessionPolicy: { idleTtlMs: 60 * 60_000, absoluteTtlMs: 24 * 60 * 60_000 },
    authTransactionTtlMs: 10 * 60_000,
    maxBodyBytes: 32_000,
    requestTimeoutMs: 5_000,
    cookieName: 'agentdesk_web_session',
    secureCookies: true,
    loginRateLimit: 20,
    apiRateLimit: 600,
    rateWindowMs: 60_000,
    sseMaxConnectionsPerUser: maxConnections,
    feishu: {
      appId: 'cli_test',
      appSecret: 'secret',
      authorizeUrl: 'https://accounts.example/authorize',
      tokenUrl: 'https://accounts.example/token',
      userInfoUrl: 'https://accounts.example/user',
      pkce: false,
    },
  };
}

function fakeRequest(): IncomingMessage {
  const request = new EventEmitter() as IncomingMessage;
  Object.assign(request, {
    socket: { setTimeout: vi.fn() },
  });
  return request;
}

function fakeResponse(writeResult = true): ServerResponse & {
  chunks: string[];
  headers: Map<string, string>;
} {
  const response = new EventEmitter() as ServerResponse & {
    chunks: string[];
    headers: Map<string, string>;
  };
  response.chunks = [];
  response.headers = new Map();
  Object.assign(response, {
    statusCode: 0,
    writableEnded: false,
    destroyed: false,
    setHeader(name: string, value: string) {
      response.headers.set(name.toLowerCase(), value);
      return response;
    },
    flushHeaders: vi.fn(),
    setTimeout: vi.fn(),
    write(chunk: string) {
      response.chunks.push(chunk);
      return writeResult;
    },
    end() {
      Object.defineProperty(response, 'writableEnded', { value: true, configurable: true });
      return response;
    },
  });
  return response;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES ('alice', 'feishu', 'Alice', '${NOW}'), ('bob', 'feishu', 'Bob', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES
      ('ag-allowed', 'Allowed', 'allowed', NULL, '${NOW}', NULL),
      ('ag-denied', 'Denied', 'denied', NULL, '${NOW}', NULL);
    INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
      VALUES ('alice', 'ag-allowed', NULL, '${NOW}');
    INSERT INTO conversation_lanes
      (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
      VALUES
      ('lane-allowed', 'ag-allowed', 'alice', NULL, 'active', '${NOW}', NULL),
      ('lane-denied', 'ag-denied', 'alice', NULL, 'active', '${NOW}', NULL),
      ('lane-bob', 'ag-allowed', 'bob', NULL, 'active', '${NOW}', NULL);
  `);
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

function session() {
  return createWebAuthSession({
    userId: 'alice',
    secret: SECRET,
    policy: config().sessionPolicy,
  });
}

describe('Web SSE event stream', () => {
  it('replays after the opaque cursor and filters lanes through the current Host access gate', async () => {
    const replayBefore =
      (await webSseEventsTotal.get()).values.find((value) => value.labels.delivery === 'replay')?.value ?? 0;
    const liveBefore =
      (await webSseEventsTotal.get()).values.find((value) => value.labels.delivery === 'live')?.value ?? 0;
    const connectionsBefore = (await webSseConnections.get()).values[0]?.value ?? 0;
    const auth = session();
    const first = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-allowed',
      eventType: 'conversation.message.accepted',
      resourceId: 'message-1',
    }).event;
    appendWebEvent({
      userId: 'alice',
      laneId: 'lane-denied',
      eventType: 'conversation.message.available',
      resourceId: 'message-secret',
    });
    const visible = appendWebEvent({
      userId: 'alice',
      laneId: 'lane-allowed',
      eventType: 'conversation.message.available',
      resourceId: 'message-2',
    }).event;
    appendWebEvent({
      userId: 'bob',
      laneId: 'lane-bob',
      eventType: 'conversation.message.available',
      resourceId: 'message-bob',
    });

    const manager = createWebEventStreamManager(config());
    const response = fakeResponse();
    manager.open({
      req: fakeRequest(),
      res: response,
      token: auth.token,
      authenticated: { session: auth.session, csrfToken: auth.csrfToken },
      cursor: encodeWebEventCursor(first.sequence),
    });

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.chunks.join('')).toContain(visible.event_id);
    expect(response.chunks.join('')).not.toContain('message-secret');
    expect(response.chunks.join('')).not.toContain('message-bob');

    appendWebEvent({
      userId: 'alice',
      laneId: 'lane-allowed',
      eventType: 'conversation.message.available',
      resourceId: 'message-live',
    });
    expect(response.chunks.join('')).toContain('message-live');
    expect((await webSseEventsTotal.get()).values.find((value) => value.labels.delivery === 'replay')?.value).toBe(
      replayBefore + 1,
    );
    expect((await webSseEventsTotal.get()).values.find((value) => value.labels.delivery === 'live')?.value).toBe(
      liveBefore + 1,
    );
    expect((await webSseConnections.get()).values[0]?.value).toBe(connectionsBefore + 1);

    getDb()
      .prepare('DELETE FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .run('alice', 'ag-allowed');
    appendWebEvent({
      userId: 'alice',
      laneId: 'lane-allowed',
      eventType: 'conversation.message.available',
      resourceId: 'message-after-revoke',
    });
    expect(response.chunks.join('')).not.toContain('message-after-revoke');
    manager.closeAll();
    expect((await webSseConnections.get()).values[0]?.value).toBe(connectionsBefore);
  });

  it('rejects malformed cursors and enforces a per-user connection ceiling', () => {
    const auth = session();
    const manager = createWebEventStreamManager(config(1));
    expect(() =>
      manager.open({
        req: fakeRequest(),
        res: fakeResponse(),
        token: auth.token,
        authenticated: { session: auth.session, csrfToken: auth.csrfToken },
        cursor: 'forged',
      }),
    ).toThrow(new WebEventStreamError(400, 'invalid_event_cursor'));

    manager.open({
      req: fakeRequest(),
      res: fakeResponse(),
      token: auth.token,
      authenticated: { session: auth.session, csrfToken: auth.csrfToken },
      cursor: null,
    });
    expect(manager.connectionCount('alice')).toBe(1);
    expect(() =>
      manager.open({
        req: fakeRequest(),
        res: fakeResponse(),
        token: auth.token,
        authenticated: { session: auth.session, csrfToken: auth.csrfToken },
        cursor: null,
      }),
    ).toThrow(new WebEventStreamError(429, 'sse_connection_limit'));
    manager.closeAll();
  });

  it('closes a slow client immediately when ServerResponse reports backpressure', () => {
    const auth = session();
    appendWebEvent({
      userId: 'alice',
      laneId: 'lane-allowed',
      eventType: 'conversation.message.available',
      resourceId: 'message-too-slow',
    });
    const manager = createWebEventStreamManager(config());
    const response = fakeResponse(false);
    manager.open({
      req: fakeRequest(),
      res: response,
      token: auth.token,
      authenticated: { session: auth.session, csrfToken: auth.csrfToken },
      cursor: null,
    });
    expect(response.writableEnded).toBe(true);
    expect(manager.connectionCount('alice')).toBe(0);
  });

  it('notifies and closes the stream when the bound login session is revoked', async () => {
    vi.useFakeTimers();
    const auth = session();
    const manager = createWebEventStreamManager(config(), { heartbeatMs: 10 });
    const response = fakeResponse();
    manager.open({
      req: fakeRequest(),
      res: response,
      token: auth.token,
      authenticated: { session: auth.session, csrfToken: auth.csrfToken },
      cursor: null,
    });
    revokeWebAuthSessionByToken({
      token: auth.token,
      secret: SECRET,
      actor: 'alice',
      reason: 'test',
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(response.chunks.join('')).toContain('event: session-revoked');
    expect(response.writableEnded).toBe(true);
    expect(manager.connectionCount('alice')).toBe(0);
  });
});
