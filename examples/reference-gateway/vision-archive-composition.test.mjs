import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const archiveOperations = [
  'vision.archive.experiment.search',
  'vision.archive.file.list',
  'vision.archive.json.read',
  'vision.archive.json.search',
];

async function startGateway(t, env) {
  const child = spawn(process.execPath, ['examples/reference-gateway/server.mjs'], {
    cwd: path.resolve(import.meta.dirname, '../..'),
    env: { PATH: process.env.PATH, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  t.after(() => child.kill('SIGTERM'));
  const baseUrl = `http://127.0.0.1:${env.PORT}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`gateway exited early: ${stderr}`);
    try {
      const response = await fetch(`${baseUrl}/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      if (response.ok) return { child, baseUrl, stderr: () => stderr };
    } catch {
      // startup race
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`gateway did not start: ${stderr}`);
}

async function post(baseUrl, endpoint, body) {
  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test('reference Gateway composes Archive alone and with Bitable using exact dispatch and audit metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vision-composition-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '固体称量实验_20260729'));
  const port = 19_000 + (process.pid % 500);
  const archiveEnv = {
    PORT: String(port),
    VISION_ARCHIVE_ROOT: root,
    VISION_ARCHIVE_READ_ENABLED: 'true',
    VISION_ARCHIVE_RESOURCES_JSON: JSON.stringify({
      vision: { readers: ['u1'], agentGroups: ['ag1'] },
    }),
  };
  const first = await startGateway(t, archiveEnv);
  const described = await post(first.baseUrl, '/describe', {});
  const names = described.body.operations.map((operation) => operation.name);
  assert.deepEqual(
    names.filter((name) => name.startsWith('vision.archive.')),
    archiveOperations,
  );
  assert.equal(
    names.some((name) => name.startsWith('feishu.bitable.')),
    false,
  );
  assert.ok(
    described.body.operations
      .filter((operation) => operation.name.startsWith('vision.archive.'))
      .every((operation) => operation.mutating === false),
  );

  const envelope = {
    operation: 'vision.archive.experiment.search',
    input: { resource: 'vision', dateFrom: '2026-07-29' },
    requester: { userId: 'u1' },
    requesterSource: 'session',
    agent: { agentGroupId: 'ag1' },
  };
  assert.equal((await post(first.baseUrl, '/authorize', envelope)).body.allowed, true);
  const executed = await post(first.baseUrl, '/execute', envelope);
  assert.equal(executed.status, 200);
  assert.equal(executed.body.ok, true);
  assert.equal(executed.body.result.archives.length, 1);

  const denied = await post(first.baseUrl, '/execute', { ...envelope, requesterSource: 'agent-asserted' });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.code, 'BACKEND_UNAUTHORIZED');
  const invalid = await post(first.baseUrl, '/execute', {
    ...envelope,
    input: { resource: 'vision', path: '../../etc/passwd' },
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.code, 'VALIDATION_FAILED');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(first.stderr(), /vision-archive-audit/);
  assert.match(first.stderr(), /"requesterUserId":"u1"/);
  assert.match(first.stderr(), /"agentGroupId":"ag1"/);
  first.child.kill('SIGTERM');
  await new Promise((resolve) => first.child.once('exit', resolve));

  const combined = await startGateway(t, {
    ...archiveEnv,
    PORT: String(port + 1),
    FEISHU_BITABLE_APP_ID: 'cli_test',
    FEISHU_BITABLE_APP_SECRET: 'secret-for-test',
    FEISHU_BITABLE_CURSOR_SECRET: 'c'.repeat(32),
    FEISHU_BITABLE_CONFIRMATION_SECRET: 'd'.repeat(32),
    FEISHU_BITABLE_READ_ENABLED: 'true',
    FEISHU_BITABLE_RESOURCES_JSON: JSON.stringify({
      table: {
        appToken: 'app-token',
        tableId: 'table-id',
        readers: ['u1'],
        writers: [],
        allowedOperations: ['feishu.bitable.record.list'],
      },
    }),
  });
  const combinedNames = (await post(combined.baseUrl, '/describe', {})).body.operations.map(
    (operation) => operation.name,
  );
  assert.deepEqual(
    combinedNames.filter((name) => name.startsWith('vision.archive.')),
    archiveOperations,
  );
  assert.ok(combinedNames.includes('feishu.bitable.record.list'));
});
