/**
 * Real-container A2A + Backend Gateway E2E.
 *
 * Boundary covered:
 *   Web-origin canonical user → frontdesk Session → real mock-provider
 *   container → Host A2A router → real worker container → production Gateway
 *   MCP handler → HTTP Gateway → outbound gateway_audit → Host central audit.
 *
 * No live LLM or Feishu tenant is required. Docker and the built base image are
 * required, so this script belongs to the release/smoke suite rather than the
 * default fast unit suite.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http, { type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WAIT_MS = 90_000;
const POLL_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(label: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = read();
      if (value !== undefined) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`${label} did not complete within ${WAIT_MS}ms${lastError ? `: ${String(lastError)}` : ''}`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Gateway E2E server did not bind');
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function runProbe(runtime: string, image: string, sessionDir: string, groupDir: string): Promise<void> {
  const name = `agentdesk-e2e-gateway-probe-${process.pid}`;
  const args = [
    'run',
    '--rm',
    '--name',
    name,
    '--security-opt=no-new-privileges:true',
    '-e',
    'BRAND_NAMESPACE=agentdesk',
  ];
  if (os.platform() === 'linux') args.push('--add-host=host.docker.internal:host-gateway');
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (uid != null && uid !== 0 && uid !== 1000) {
    args.push('--user', `${uid}:${gid}`, '-e', 'HOME=/home/node');
  }
  args.push(
    '-v',
    `${sessionDir}:/workspace`,
    '-v',
    `${groupDir}:/workspace/agent`,
    '-v',
    `${path.join(REPO_ROOT, 'container', 'agent-runner', 'src')}:/app/src:ro`,
    '--entrypoint',
    'bash',
    image,
    '-c',
    'exec bun run /app/src/testing/gateway-e2e-probe.ts',
  );

  await new Promise<void>((resolve, reject) => {
    const child = spawn(runtime, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output = (output + chunk).slice(-8_000);
      process.stdout.write(`[gateway-probe] ${chunk}`);
    });
    child.stderr.on('data', (chunk) => {
      output = (output + chunk).slice(-8_000);
      process.stderr.write(`[gateway-probe] ${chunk}`);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Gateway probe exited ${code ?? 'without a code'}\n${output}`));
    });
  });
}

async function main(): Promise<void> {
  const runtime = process.env.CONTAINER_RUNTIME || 'docker';
  const { getDefaultContainerImage } = await import('../src/install-slug.js');
  const image = process.env.CONTAINER_IMAGE || getDefaultContainerImage(REPO_ROOT);
  process.env.CONTAINER_IMAGE = image;
  const imageQuery = spawnSync(runtime, ['images', '-q', image], { encoding: 'utf8' });
  if (imageQuery.status !== 0 || !imageQuery.stdout.trim()) {
    throw new Error(`container image not found: ${image}; run pnpm container:build first`);
  }

  const gatewayRequests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const committedCreates = new Map<string, Record<string, unknown>>();
  const gateway = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    gatewayRequests.push({ path: request.url ?? '', body });
    response.statusCode = 200;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/describe') {
      response.end(
        JSON.stringify({
          contractVersion: body.contractVersion,
          operations: [{ name: 'feishu.bitable.record.create', mutating: true }],
        }),
      );
      return;
    }
    if (request.url === '/execute') {
      const idempotencyKey = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
      if (!idempotencyKey) {
        response.statusCode = 422;
        response.end(JSON.stringify({ code: 'VALIDATION_FAILED', message: 'idempotency key required' }));
        return;
      }
      const committed = committedCreates.get(idempotencyKey);
      if (committed) {
        response.end(JSON.stringify({ ...committed, replayed: true }));
        return;
      }
      const input = body.input as { fields?: Record<string, unknown> } | undefined;
      const created = {
        contractVersion: body.contractVersion,
        ok: true,
        result: { recordId: 'rec-e2e-created', fields: input?.fields ?? {} },
        auditId: 'gateway-e2e-audit',
      };
      committedCreates.set(idempotencyKey, created);
      response.end(JSON.stringify(created));
      return;
    }
    response.end(
      JSON.stringify({
        contractVersion: body.contractVersion,
        ok: true,
        result: { records: [], pageToken: null, hasMore: false },
        auditId: 'gateway-e2e-audit',
      }),
    );
  });
  const gatewayPort = await listen(gateway);

  const originalCwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentdesk-a2a-gateway-e2e-'));
  let stopAllContainers: ((reason: string) => Promise<void>) | undefined;
  let activeContainerCount: (() => number) | undefined;
  let closeDb: (() => void) | undefined;

  try {
    fs.symlinkSync(path.join(REPO_ROOT, 'container'), path.join(tmp, 'container'), 'dir');
    process.chdir(tmp);

    const [{ initDb }, migrations, agentGroups, permissionsMembers, configs, conversations, lanes, sessions] =
      await Promise.all([
        import('../src/db/connection.js'),
        import('../src/db/migrations/index.js'),
        import('../src/db/agent-groups.js'),
        import('../src/modules/permissions/db/agent-group-members.js'),
        import('../src/container-config.js'),
        import('../src/web/conversations.js'),
        import('../src/db/conversation-lanes.js'),
        import('../src/session-manager.js'),
      ]);
    const connection = await import('../src/db/connection.js');
    closeDb = connection.closeDb;
    const delivery = await import('../src/delivery.js');
    const containerRunner = await import('../src/container-runner.js');
    stopAllContainers = containerRunner.stopAllContainers;
    activeContainerCount = containerRunner.getActiveContainerCount;
    const destinationDb = await import('../src/modules/agent-to-agent/db/agent-destinations.js');
    await import('../src/modules/gateway-audit/index.js');

    const central = initDb(path.join(tmp, 'central.db'));
    migrations.runMigrations(central);
    const now = new Date().toISOString();
    central
      .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run('user-e2e', 'person', 'E2E User', now);
    agentGroups.createAgentGroup({
      id: 'frontdesk-e2e',
      name: 'E2E Frontdesk',
      folder: 'frontdesk-e2e',
      agent_provider: 'mock',
      created_at: now,
    });
    agentGroups.createAgentGroup({
      id: 'worker-e2e',
      name: 'E2E Worker',
      folder: 'worker-e2e',
      agent_provider: 'mock',
      created_at: now,
    });
    permissionsMembers.addMember({
      user_id: 'user-e2e',
      agent_group_id: 'frontdesk-e2e',
      added_by: null,
      added_at: now,
    });

    for (const folder of ['frontdesk-e2e', 'worker-e2e']) configs.initContainerConfig(folder);
    configs.updateContainerConfig('frontdesk-e2e', (config) => {
      config.provider = 'mock';
      config.skills = [];
      config.idleExitMs = 1_500;
    });
    configs.updateContainerConfig('worker-e2e', (config) => {
      config.provider = 'mock';
      config.skills = [];
      config.idleExitMs = 1_500;
      config.backendGateway = {
        baseUrl: `http://host.docker.internal:${gatewayPort}`,
        timeoutMs: 10_000,
      };
    });

    const lane = conversations.createWebConversation('user-e2e', 'frontdesk-e2e');
    const binding = lanes
      .listConversationBindings(lane.id)
      .find((candidate) => candidate.channel_type === 'web' && candidate.revoked_at === null);
    if (!binding?.messaging_group_id) throw new Error('Web E2E binding was not created');
    const front = sessions.resolveSession(
      'frontdesk-e2e',
      binding.messaging_group_id,
      null,
      'per-user',
      'user-e2e',
      null,
      null,
      lane.id,
    ).session;
    destinationDb.createDestination({
      agent_group_id: 'frontdesk-e2e',
      local_name: 'worker',
      target_type: 'agent',
      target_id: 'worker-e2e',
      created_at: now,
    });
    sessions.writeSessionMessage('frontdesk-e2e', front.id, {
      id: 'web-origin-turn',
      kind: 'chat',
      timestamp: now,
      platformId: binding.platform_id,
      channelType: 'web',
      content: JSON.stringify({
        text: '[mock-response]<message to="worker">请通过 Gateway 查询多维表格联系人</message>[/mock-response]',
        sender: 'E2E User',
      }),
      originUserId: 'user-e2e',
      conversationThreadId: front.conversation_thread_id,
    });

    delivery.setDeliveryAdapter({
      async deliver() {
        return 'e2e-noop';
      },
    });

    if (!(await containerRunner.wakeContainer(front))) throw new Error('frontdesk container wake was rejected');
    const frontOutboundPath = sessions.outboundDbPath('frontdesk-e2e', front.id);
    const delegated = await waitFor('frontdesk A2A output', () => {
      const db = new Database(frontOutboundPath, { readonly: true });
      try {
        return db
          .prepare(
            `SELECT id, channel_type, platform_id, origin_user_id
             FROM messages_out
             WHERE kind = 'chat' AND channel_type = 'agent' AND platform_id = 'worker-e2e'
             LIMIT 1`,
          )
          .get() as
          | { id: string; channel_type: string; platform_id: string; origin_user_id: string | null }
          | undefined;
      } finally {
        db.close();
      }
    });
    if (delegated.origin_user_id !== 'user-e2e') {
      throw new Error(`frontdesk container lost canonical origin: ${delegated.origin_user_id}`);
    }

    await delivery.deliverSessionMessages(front);
    const worker = central
      .prepare(
        `SELECT * FROM sessions
         WHERE agent_group_id = 'worker-e2e'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get() as import('../src/types.js').Session | undefined;
    if (!worker) throw new Error('Host A2A router did not create a worker Session');

    const workerInboundPath = sessions.inboundDbPath('worker-e2e', worker.id);
    const workerInboundDb = new Database(workerInboundPath, { readonly: true });
    const workerInbound = workerInboundDb
      .prepare(
        `SELECT id, channel_type, platform_id, origin_user_id, conversation_thread_id
         FROM messages_in ORDER BY seq DESC LIMIT 1`,
      )
      .get() as {
      id: string;
      channel_type: string;
      platform_id: string;
      origin_user_id: string | null;
      conversation_thread_id: string | null;
    };
    workerInboundDb.close();
    if (
      workerInbound.channel_type !== 'agent' ||
      workerInbound.platform_id !== 'frontdesk-e2e' ||
      workerInbound.origin_user_id !== 'user-e2e' ||
      workerInbound.conversation_thread_id !== front.conversation_thread_id
    ) {
      throw new Error(`worker A2A identity/thread propagation failed: ${JSON.stringify(workerInbound)}`);
    }

    const workerOutboundPath = sessions.outboundDbPath('worker-e2e', worker.id);
    await waitFor('worker real-container processing acknowledgement', () => {
      const db = new Database(workerOutboundPath, { readonly: true });
      try {
        const ack = db.prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(workerInbound.id) as
          | { status: string }
          | undefined;
        return ack?.status === 'completed' ? ack : undefined;
      } finally {
        db.close();
      }
    });

    await containerRunner.killContainer(worker.id, 'gateway-e2e-probe');
    await waitFor('worker container exit', () => (containerRunner.isContainerRunning(worker.id) ? undefined : true));
    await runProbe(
      runtime,
      image,
      sessions.sessionDir('worker-e2e', worker.id),
      path.join(tmp, 'groups', 'worker-e2e'),
    );
    await delivery.deliverSessionMessages(worker);

    const audit = central
      .prepare(
        `SELECT user_id, path, operation, logical_resource, requester_source, status
         FROM gateway_audit
         WHERE session_id = ? AND operation = 'feishu.bitable.record.create'
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker.id) as
      | {
          user_id: string | null;
          path: string;
          operation: string;
          logical_resource: string | null;
          requester_source: string;
          status: string;
        }
      | undefined;
    if (
      !audit ||
      audit.user_id !== 'user-e2e' ||
      audit.path !== '/execute' ||
      audit.logical_resource !== 'e2e.contacts' ||
      audit.requester_source !== 'session' ||
      audit.status !== 'ok'
    ) {
      throw new Error(`Host gateway audit assertion failed: ${JSON.stringify(audit)}`);
    }
    const executeRequests = gatewayRequests.filter((request) => request.path === '/execute');
    if (executeRequests.length !== 2) {
      throw new Error(`Gateway expected one create plus one replay, got ${executeRequests.length}`);
    }
    const keys = executeRequests.map((request) => request.body.idempotencyKey);
    if (
      keys.some((key) => key !== 'container-a2a-stable-create') ||
      committedCreates.size !== 1 ||
      executeRequests.some((request) => {
        const requester = request.body.requester as { userId?: string } | undefined;
        return requester?.userId !== 'user-e2e' || request.body.requesterSource !== 'session';
      })
    ) {
      throw new Error(`Gateway HTTP identity/idempotency assertion failed: ${JSON.stringify(executeRequests)}`);
    }

    console.log(
      '✓ e2e-container-a2a-gateway PASSED — Web identity survived real-container A2A; create replay committed once.',
    );
  } finally {
    if (stopAllContainers) await stopAllContainers('e2e-cleanup');
    if (activeContainerCount) {
      await waitFor('E2E container cleanup', () => (activeContainerCount!() === 0 ? true : undefined));
    }
    closeDb?.();
    process.chdir(originalCwd);
    await closeServer(gateway);
    // Docker Desktop may release the bind mount a fraction after the child
    // close event. Retry ENOTEMPTY/EBUSY instead of turning a passed E2E into a
    // false failure during temp cleanup.
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
        break;
      } catch (error) {
        if (attempt === 19) throw error;
        await sleep(100);
      }
    }
  }
}

main().catch((error) => {
  console.error(
    `✗ e2e-container-a2a-gateway: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
  process.exit(1);
});
