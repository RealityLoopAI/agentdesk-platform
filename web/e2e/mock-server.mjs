import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

const HOST = '127.0.0.1';
const PORT = 4173;
const STATIC_ROOT = path.resolve(process.cwd(), 'dist');
const SESSION_COOKIE = 'mock_web_session';
const FIXED_TIME = '2026-07-27T10:00:00.000Z';

const sessions = new Map();
const pendingSsoStates = new Set();

const branding = {
  displayName: 'RealityLoop AgentDesk',
  logoPath: '/brand/logo.svg',
  theme: {
    brandPrimary: '#245866',
    brandPrimaryHover: '#1B4652',
    brandPrimaryActive: '#143A44',
    brandSurfaceSubtle: '#E8F1F2',
    brandBorder: '#B8D0D3',
    canvas: '#FAF8F4',
    surface: '#FFFFFF',
    border: '#DDE5E5',
    textPrimary: '#18343B',
    textSecondary: '#60757A',
    statusSuccess: '#287A5B',
    statusWarning: '#A85E18',
    statusDanger: '#C44545',
  },
};

function json(res, status, body) {
  const encoded = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': String(encoded.length),
    'content-type': 'application/json; charset=utf-8',
  });
  res.end(encoded);
}

function redirect(res, location, cookies = []) {
  res.writeHead(302, {
    location,
    ...(cookies.length ? { 'set-cookie': cookies } : {}),
  });
  res.end();
}

function parseCookies(req) {
  return new Map(
    (req.headers.cookie ?? '')
      .split(';')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => {
        const separator = item.indexOf('=');
        return separator === -1
          ? [item, '']
          : [item.slice(0, separator), decodeURIComponent(item.slice(separator + 1))];
      }),
  );
}

function currentSession(req) {
  const id = parseCookies(req).get(SESSION_COOKIE);
  const session = id ? sessions.get(id) : undefined;
  return session?.valid ? session : null;
}

function createSession() {
  const id = crypto.randomUUID();
  const session = {
    id,
    valid: true,
    csrfToken: `csrf-${id}`,
    nextMessage: 2,
    nextEvent: 1,
    clients: new Set(),
    eventRequests: [],
    idempotency: new Map(),
    deliverySubscriptionEnabled: false,
    messages: [
      {
        id: 'message-feishu-1',
        sequence: 1,
        direction: 'agent',
        kind: 'chat',
        timestamp: FIXED_TIME,
        text: '这是一条从飞书同步过来的历史消息。',
        channel: { type: 'feishu', platformId: 'oc_mock_private', threadId: null },
        status: 'delivered',
      },
    ],
  };
  sessions.set(id, session);
  return session;
}

function conversation(session) {
  const latest = session.messages.at(-1)?.timestamp ?? FIXED_TIME;
  return {
    id: 'lane-main',
    agentGroup: { id: 'agent-research', name: '研究 Agent' },
    sourceChannel: 'feishu',
    status: 'active',
    createdAt: FIXED_TIME,
    archivedAt: null,
    lastActiveAt: latest,
  };
}

function writeSse(res, event, data, id) {
  if (id) res.write(`id: ${id}\n`);
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function emitWebEvent(session, type, resourceId) {
  const cursor = String(session.nextEvent++);
  const payload = {
    eventId: `event-${cursor}`,
    cursor,
    type,
    laneId: 'lane-main',
    resourceId,
    createdAt: FIXED_TIME,
  };
  for (const client of session.clients) writeSse(client, 'web-event', payload, cursor);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function serveStatic(res, pathname) {
  const relative =
    pathname === '/' ||
    pathname === '/login' ||
    pathname === '/conversations' ||
    /^\/conversations\/[^/]+$/.test(pathname)
      ? 'index.html'
      : pathname.startsWith('/assets/') || pathname.startsWith('/brand/')
        ? pathname.slice(1)
        : null;
  if (!relative || relative.includes('..')) return false;
  const candidate = path.resolve(STATIC_ROOT, relative);
  if (!candidate.startsWith(`${STATIC_ROOT}${path.sep}`)) return false;
  const body = await fs.readFile(candidate).catch(() => null);
  if (!body) return false;
  const type =
    path.extname(candidate) === '.html'
      ? 'text/html; charset=utf-8'
      : path.extname(candidate) === '.js'
        ? 'text/javascript; charset=utf-8'
        : path.extname(candidate) === '.css'
          ? 'text/css; charset=utf-8'
          : path.extname(candidate) === '.svg'
            ? 'image/svg+xml'
            : 'application/octet-stream';
  res.writeHead(200, { 'content-length': String(body.length), 'content-type': type });
  res.end(body);
  return true;
}

function mockProviderPage(state) {
  return `<!doctype html>
<html lang="zh-CN">
  <head><meta charset="utf-8"><title>Mock Feishu Provider</title></head>
  <body>
    <main>
      <h1>飞书测试身份授权</h1>
      <p>这是端到端测试使用的本地飞书身份提供方，不会访问真实飞书账号。</p>
      <a href="/auth/feishu/callback?code=mock-code&state=${encodeURIComponent(state)}">同意并继续</a>
    </main>
  </body>
</html>`;
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', `http://${HOST}:${PORT}`);
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/api/branding') {
    json(res, 200, { branding });
    return;
  }

  if (method === 'GET' && url.pathname === '/auth/feishu/start') {
    const state = crypto.randomUUID();
    pendingSsoStates.add(state);
    redirect(res, `/mock-feishu/authorize?state=${encodeURIComponent(state)}`);
    return;
  }

  if (method === 'GET' && url.pathname === '/mock-feishu/authorize') {
    const state = url.searchParams.get('state') ?? '';
    if (!pendingSsoStates.has(state)) {
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('invalid mock SSO state');
      return;
    }
    const body = Buffer.from(mockProviderPage(state));
    res.writeHead(200, {
      'content-length': String(body.length),
      'content-type': 'text/html; charset=utf-8',
    });
    res.end(body);
    return;
  }

  if (method === 'GET' && url.pathname === '/auth/feishu/callback') {
    const state = url.searchParams.get('state') ?? '';
    const code = url.searchParams.get('code');
    if (code !== 'mock-code' || !pendingSsoStates.delete(state)) {
      redirect(res, '/login?error=authentication_failed');
      return;
    }
    const session = createSession();
    redirect(res, '/conversations', [
      `${SESSION_COOKIE}=${encodeURIComponent(session.id)}; Path=/; HttpOnly; SameSite=Lax`,
    ]);
    return;
  }

  const session = currentSession(req);
  if (url.pathname.startsWith('/api/') && !session) {
    json(res, 401, { error: 'authentication_required' });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    json(res, 200, {
      user: { id: 'user-alice', kind: 'person', displayName: 'Alice 实习生' },
      csrfToken: session.csrfToken,
      sessionExpiresAt: '2026-07-28T10:00:00.000Z',
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/conversations') {
    json(res, 200, {
      conversations: [conversation(session)],
      availableAgentGroups: [{ id: 'agent-research', name: '研究 Agent' }],
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/conversations/reconcile') {
    if (req.headers['x-csrf-token'] !== session.csrfToken) {
      json(res, 403, { error: 'request_forbidden' });
      return;
    }
    await readJson(req);
    json(res, 200, {
      scanned: 1,
      linked: 0,
      existing: 1,
      dryRunEligible: 0,
      skippedUnauthorized: 0,
      skippedMode: 0,
      conflicts: 0,
      hasMore: false,
      nextCursor: 'session-feishu-main',
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/conversations/lane-main/messages') {
    json(res, 200, { messages: session.messages, nextCursor: null });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/conversations/lane-main/delivery-subscription') {
    json(res, 200, {
      subscription: {
        channel: 'feishu',
        deliveryKind: 'agent-reply-mirror',
        enabled: session.deliverySubscriptionEnabled,
        available: true,
      },
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/conversations/lane-main/delivery-subscription') {
    if (req.headers['x-csrf-token'] !== session.csrfToken) {
      json(res, 403, { error: 'request_forbidden' });
      return;
    }
    const body = await readJson(req);
    if (typeof body.enabled !== 'boolean') {
      json(res, 400, { error: 'invalid_subscription_state' });
      return;
    }
    session.deliverySubscriptionEnabled = body.enabled;
    json(res, 200, {
      subscription: {
        channel: 'feishu',
        deliveryKind: 'agent-reply-mirror',
        enabled: session.deliverySubscriptionEnabled,
        available: true,
      },
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/conversations/lane-main/messages') {
    if (req.headers['x-csrf-token'] !== session.csrfToken) {
      json(res, 403, { error: 'request_forbidden' });
      return;
    }
    const body = await readJson(req);
    const clientMessageId = typeof body.clientMessageId === 'string' ? body.clientMessageId : '';
    const text = typeof body.text === 'string' ? body.text : '';
    const replay = session.idempotency.get(clientMessageId);
    if (replay) {
      json(res, 200, { message: { ...replay, replayed: true } });
      return;
    }
    const messageId = `message-${session.nextMessage++}`;
    const result = { clientMessageId, messageId, status: 'accepted', replayed: false };
    session.idempotency.set(clientMessageId, result);
    session.messages.push({
      id: messageId,
      sequence: session.messages.length + 1,
      direction: 'user',
      kind: 'chat',
      timestamp: FIXED_TIME,
      text,
      channel: { type: 'web', platformId: null, threadId: null },
      status: 'accepted',
    });
    emitWebEvent(session, 'conversation.message.accepted', messageId);
    json(res, 202, { message: result });

    const delay = text.includes('[慢速]') ? 2_000 : 120;
    setTimeout(() => {
      if (!session.valid) return;
      const agentMessageId = `message-${session.nextMessage++}`;
      session.messages.push({
        id: agentMessageId,
        sequence: session.messages.length + 1,
        direction: 'agent',
        kind: 'chat',
        timestamp: FIXED_TIME,
        text: `Agent 已收到：${text.replace('[慢速]', '').trim()}`,
        channel: { type: 'web', platformId: null, threadId: null },
        status: 'delivered',
      });
      emitWebEvent(session, 'conversation.message.available', agentMessageId);
    }, delay).unref();
    return;
  }

  if (method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    });
    res.write(': connected\n\n');
    session.eventRequests.push(url.searchParams.get('cursor'));
    session.clients.add(res);
    req.on('close', () => session.clients.delete(res));
    return;
  }

  if (method === 'POST' && url.pathname === '/api/logout') {
    session.valid = false;
    for (const client of session.clients) client.end();
    session.clients.clear();
    res.writeHead(204, {
      'set-cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`,
    });
    res.end();
    return;
  }

  if (method === 'POST' && url.pathname === '/__test__/disconnect-events') {
    for (const client of session.clients) client.end();
    session.clients.clear();
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'POST' && url.pathname === '/__test__/expire-session') {
    for (const client of session.clients) {
      writeSse(client, 'session-revoked', { reason: 'test-expiry' });
      client.end();
    }
    session.clients.clear();
    session.valid = false;
    res.writeHead(204);
    res.end();
    return;
  }

  if (method === 'GET' && url.pathname === '/__test__/state') {
    json(res, 200, {
      eventRequests: session.eventRequests,
      messageCount: session.messages.length,
    });
    return;
  }

  if (method === 'GET' && (await serveStatic(res, url.pathname))) return;
  json(res, 404, { error: 'not_found' });
}

const server = http.createServer((req, res) => {
  void handle(req, res).catch((error) => {
    console.error(error);
    if (!res.headersSent) json(res, 500, { error: 'mock_server_failure' });
    else res.destroy();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Mock Feishu Web E2E server listening on http://${HOST}:${PORT}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
