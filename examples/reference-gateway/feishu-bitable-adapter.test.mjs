import assert from 'node:assert/strict';
import test from 'node:test';

import { createFeishuBitableAdapter } from './feishu-bitable-adapter.mjs';

const ALICE = 'user-alice';
const BOB = 'user-bob';
const APP_TOKEN = 'bas-secret-app-token';
const TABLE_ID = 'tbl-secret-table-id';
const TENANT_TOKEN = 't-secret-tenant-token';

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function fieldPayload(extra = []) {
  return {
    code: 0,
    data: {
      items: [
        { field_id: 'fld-name', field_name: 'Name', type: 1, ui_type: 'Text', property: null },
        {
          field_id: 'fld-status',
          field_name: 'Status',
          type: 3,
          ui_type: 'SingleSelect',
          property: { options: [{ name: 'Open' }, { name: 'Closed' }] },
        },
        ...extra,
      ],
      has_more: false,
    },
  };
}

function makeHarness(providerHandler, overrides = {}) {
  const calls = [];
  const audits = [];
  const fetchImpl = async (url, init = {}) => {
    const href = String(url);
    const parsedBody = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: href, method: init.method ?? 'GET', headers: init.headers ?? {}, body: parsedBody });
    if (href.endsWith('/auth/v3/tenant_access_token/internal')) {
      assert.equal(parsedBody.app_id, 'cli-app-id');
      assert.equal(parsedBody.app_secret, 'gateway-only-app-secret');
      return json({ code: 0, tenant_access_token: TENANT_TOKEN, expire: 7200 });
    }
    assert.equal(init.headers.authorization, `Bearer ${TENANT_TOKEN}`);
    if (href.includes('/fields')) return json(fieldPayload());
    return providerHandler({ url: new URL(href), init, body: parsedBody, calls });
  };

  const adapter = createFeishuBitableAdapter({
    appId: 'cli-app-id',
    appSecret: 'gateway-only-app-secret',
    cursorSecret: 'cursor-secret-at-least-32-characters-long',
    confirmationSecret: 'confirmation-secret-at-least-32-characters',
    fetchImpl,
    baseUrl: 'https://mock.feishu.local/open-apis',
    audit: async (event) => audits.push(event),
    resources: {
      sales: {
        appToken: APP_TOKEN,
        name: '销售应用',
        readers: [ALICE],
        writers: [],
        allowedOperations: ['feishu.bitable.app.get', 'feishu.bitable.table.list'],
      },
      'sales.pipeline': {
        appToken: APP_TOKEN,
        tableId: TABLE_ID,
        name: '销售管道',
        readers: [ALICE],
        writers: [ALICE],
        requiredFields: ['Name'],
        highImpactFields: ['Status'],
        filters: { active: { conjunction: 'and', conditions: [] } },
        sorts: { recent: [{ field_name: 'Name', desc: true }] },
        views: { board: 'vew-approved' },
      },
    },
    ...overrides,
  });
  return { adapter, calls, audits };
}

function request(operation, input, overrides = {}) {
  return {
    operation,
    input,
    requester: { userId: ALICE },
    requesterSource: 'session',
    dryRun: false,
    idempotencyKey: operation.includes('.record.') ? `idem-${operation}-${JSON.stringify(input)}` : null,
    ...overrides,
  };
}

test('credentials and raw resource ids stay inside the Gateway boundary', async () => {
  const { adapter, calls, audits } = makeHarness(({ url }) => {
    assert.ok(url.pathname.endsWith(`/bitable/v1/apps/${APP_TOKEN}`));
    return json({ code: 0, data: { app: { app_token: APP_TOKEN, name: 'Provider App' } } });
  });

  const descriptors = adapter.describeOperations();
  assert.equal(descriptors.length, 11);
  assert.doesNotMatch(JSON.stringify(descriptors), /bas-secret|tbl-secret|tenant-token|app-secret/);

  const response = await adapter.execute(request('feishu.bitable.app.get', { resource: 'sales' }));
  assert.equal(response.ok, true);
  assert.deepEqual(response.result, { resource: 'sales', name: '销售应用', revision: undefined });
  assert.doesNotMatch(JSON.stringify(response), /bas-secret|tbl-secret|tenant-token|app-secret/);
  assert.doesNotMatch(JSON.stringify(audits), /Provider App|bas-secret|tbl-secret|tenant-token|app-secret/);
  assert.equal(calls.length, 2);

  const rejected = await adapter.execute(
    request('feishu.bitable.record.get', {
      resource: 'sales.pipeline',
      recordId: 'rec-1',
      app_token: APP_TOKEN,
      table_id: TABLE_ID,
    }),
  );
  assert.equal(rejected.body.code, 'VALIDATION_FAILED');
  assert.equal(calls.length, 2, 'raw identifiers must be rejected before another Feishu call');
});

test('unknown resources, unauthorized users and agent-asserted writes fail before Feishu', async () => {
  const { adapter, calls } = makeHarness(() => {
    throw new Error('provider must not be called');
  });

  const unknown = await adapter.execute(
    request('feishu.bitable.record.get', { resource: 'unknown.table', recordId: 'rec-1' }),
  );
  assert.equal(unknown.body.code, 'RESOURCE_NOT_ALLOWED');

  const bob = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      { resource: 'sales.pipeline' },
      { requester: { userId: BOB }, idempotencyKey: null },
    ),
  );
  assert.equal(bob.body.code, 'BACKEND_UNAUTHORIZED');

  const asserted = await adapter.execute(
    request(
      'feishu.bitable.record.create',
      { resource: 'sales.pipeline', fields: { Name: 'Blocked' } },
      { requesterSource: 'agent-asserted' },
    ),
  );
  assert.equal(asserted.body.code, 'BACKEND_UNAUTHORIZED');
  assert.equal(calls.length, 0);
});

test('table and field discovery expose only configured logical metadata', async () => {
  const { adapter } = makeHarness(({ url }) => {
    if (url.pathname.endsWith('/tables')) {
      return json({
        code: 0,
        data: {
          items: [
            { table_id: TABLE_ID, name: 'Provider Pipeline', revision: 8 },
            { table_id: 'tbl-not-whitelisted', name: 'Hidden Table', revision: 1 },
          ],
          has_more: false,
        },
      });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  });

  const tables = await adapter.execute(
    request('feishu.bitable.table.list', { resource: 'sales' }, { idempotencyKey: null }),
  );
  assert.deepEqual(tables.result.items, [{ resource: 'sales.pipeline', name: '销售管道', revision: undefined }]);
  assert.doesNotMatch(JSON.stringify(tables), /tbl-not-whitelisted|tbl-secret-table-id/);

  const fields = await adapter.execute(
    request('feishu.bitable.field.list', { resource: 'sales.pipeline' }, { idempotencyKey: null }),
  );
  assert.equal(fields.result.items[0].name, 'Name');
  assert.equal(fields.result.items[0].required, true);
  assert.equal(fields.result.items[1].options[1], 'Closed');
  assert.doesNotMatch(JSON.stringify(fields), /fld-name|fld-status/);
});

test('record pagination uses a signed opaque cursor bound to the query', async () => {
  let recordCalls = 0;
  const { adapter } = makeHarness(({ url }) => {
    if (!url.pathname.endsWith('/records/search')) throw new Error(`unexpected path ${url.pathname}`);
    recordCalls += 1;
    if (recordCalls === 1) {
      assert.equal(url.searchParams.get('page_token'), null);
      return json({
        code: 0,
        data: {
          items: [{ record_id: 'rec-1', fields: { Name: 'First' } }],
          has_more: true,
          page_token: 'provider-secret-page-token',
        },
      });
    }
    assert.equal(url.searchParams.get('page_token'), 'provider-secret-page-token');
    return json({
      code: 0,
      data: { items: [{ record_id: 'rec-2', fields: { Name: 'Second' } }], has_more: false },
    });
  });

  const first = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      { resource: 'sales.pipeline', pageSize: 1, filterAlias: 'active' },
      { idempotencyKey: null },
    ),
  );
  assert.equal(first.result.items[0].recordId, 'rec-1');
  assert.equal(first.result.hasMore, true);
  assert.doesNotMatch(first.result.nextCursor, /provider-secret-page-token/);

  const second = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      {
        resource: 'sales.pipeline',
        pageSize: 1,
        filterAlias: 'active',
        cursor: first.result.nextCursor,
      },
      { idempotencyKey: null },
    ),
  );
  assert.equal(second.result.items[0].recordId, 'rec-2');

  const rebound = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      { resource: 'sales.pipeline', filterAlias: 'active', sortAlias: 'recent', cursor: first.result.nextCursor },
      { idempotencyKey: null },
    ),
  );
  assert.equal(rebound.body.code, 'VALIDATION_FAILED');
  assert.equal(recordCalls, 2);
});

test('field schema cache refreshes once on drift and validates before writing', async () => {
  let fieldCalls = 0;
  let writeCalls = 0;
  const driftCalls = [];
  const driftAdapter = createFeishuBitableAdapter({
    appId: 'cli-app-id',
    appSecret: 'gateway-only-app-secret',
    cursorSecret: 'cursor-secret-at-least-32-characters-long',
    confirmationSecret: 'confirmation-secret-at-least-32-characters',
    baseUrl: 'https://mock.feishu.local/open-apis',
    resources: {
      'sales.pipeline': {
        appToken: APP_TOKEN,
        tableId: TABLE_ID,
        readers: [ALICE],
        writers: [ALICE],
        requiredFields: ['Name'],
      },
    },
    fetchImpl: async (url, init = {}) => {
      const href = String(url);
      driftCalls.push(href);
      if (href.endsWith('/auth/v3/tenant_access_token/internal')) {
        return json({ code: 0, tenant_access_token: TENANT_TOKEN, expire: 7200 });
      }
      if (href.includes('/fields')) {
        fieldCalls += 1;
        const extra =
          fieldCalls >= 2 ? [{ field_id: 'fld-priority', field_name: 'Priority', type: 2, ui_type: 'Number' }] : [];
        return json(fieldPayload(extra));
      }
      writeCalls += 1;
      const body = JSON.parse(init.body);
      return json({ code: 0, data: { record: { record_id: 'rec-created', fields: body.fields } } });
    },
  });

  const created = await driftAdapter.execute(
    request('feishu.bitable.record.create', { resource: 'sales.pipeline', fields: { Name: 'Initial' } }),
  );
  assert.equal(created.ok, true);
  const updated = await driftAdapter.execute(
    request('feishu.bitable.record.update', {
      resource: 'sales.pipeline',
      recordId: 'rec-created',
      fields: { Priority: 2 },
    }),
  );
  assert.equal(updated.ok, true);
  assert.equal(fieldCalls, 2);
  assert.equal(writeCalls, 2);
  assert.ok(driftCalls.some((href) => href.includes('/fields')));
});

test('idempotency replay returns the first committed record and rejects key rebinding', async () => {
  let createCalls = 0;
  const { adapter } = makeHarness(({ url, body }) => {
    if (url.pathname.endsWith('/records')) {
      createCalls += 1;
      return json({
        code: 0,
        data: { record: { record_id: `rec-${createCalls}`, fields: body.fields } },
      });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  });
  const firstRequest = request(
    'feishu.bitable.record.create',
    { resource: 'sales.pipeline', fields: { Name: 'Only once' } },
    { idempotencyKey: 'stable-create-key' },
  );
  const first = await adapter.execute(firstRequest);
  const replay = await adapter.execute(firstRequest);
  assert.equal(first.result.recordId, 'rec-1');
  assert.equal(replay.result.recordId, 'rec-1');
  assert.equal(replay.replayed, true);
  assert.equal(createCalls, 1);

  const rebound = await adapter.execute({
    ...firstRequest,
    input: { resource: 'sales.pipeline', fields: { Name: 'Different input' } },
  });
  assert.equal(rebound.body.code, 'CONFLICT');
  assert.equal(createCalls, 1);
});

test('delete and high-impact update require a user/resource/record-bound confirmation', async () => {
  let deleteCalls = 0;
  let updateCalls = 0;
  const { adapter } = makeHarness(({ url, init, body }) => {
    if (url.pathname.endsWith('/records/rec-1') && init.method === 'DELETE') {
      deleteCalls += 1;
      return json({ code: 0, data: {} });
    }
    if (url.pathname.endsWith('/records/rec-1') && init.method === 'PUT') {
      updateCalls += 1;
      return json({ code: 0, data: { record: { record_id: 'rec-1', fields: body.fields } } });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  });
  const without = await adapter.execute(
    request(
      'feishu.bitable.record.delete',
      { resource: 'sales.pipeline', recordId: 'rec-1' },
      { idempotencyKey: 'delete-key' },
    ),
  );
  assert.equal(without.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(deleteCalls, 0);

  const confirmation = adapter.issueConfirmation({
    requesterUserId: ALICE,
    operation: 'feishu.bitable.record.delete',
    resource: 'sales.pipeline',
    recordIds: ['rec-1'],
  });
  const committed = await adapter.execute(
    request(
      'feishu.bitable.record.delete',
      { resource: 'sales.pipeline', recordId: 'rec-1', confirmation },
      { idempotencyKey: 'delete-key' },
    ),
  );
  assert.equal(committed.result.deleted, true);
  assert.equal(deleteCalls, 1);

  const wrongRecord = await adapter.execute(
    request(
      'feishu.bitable.record.delete',
      { resource: 'sales.pipeline', recordId: 'rec-2', confirmation },
      { idempotencyKey: 'delete-other-key' },
    ),
  );
  assert.equal(wrongRecord.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(deleteCalls, 1);

  const highImpactWithout = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { resource: 'sales.pipeline', recordId: 'rec-1', fields: { Status: 'Closed' } },
      { idempotencyKey: 'high-impact-key' },
    ),
  );
  assert.equal(highImpactWithout.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(updateCalls, 0);

  const updateConfirmation = adapter.issueConfirmation({
    requesterUserId: ALICE,
    operation: 'feishu.bitable.record.update',
    resource: 'sales.pipeline',
    recordIds: ['rec-1'],
    highImpactFields: ['Status'],
  });
  const highImpactCommitted = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      {
        resource: 'sales.pipeline',
        recordId: 'rec-1',
        fields: { Status: 'Closed' },
        confirmation: updateConfirmation,
      },
      { idempotencyKey: 'high-impact-key' },
    ),
  );
  assert.equal(highImpactCommitted.result.fields.Status, 'Closed');
  assert.equal(updateCalls, 1);
});

test('rate limits and timeouts map to bounded retryable closed errors', async () => {
  const { adapter } = makeHarness(({ url }) => {
    if (url.pathname.endsWith('/records/search')) {
      return json({ code: 1254290, msg: 'TooManyRequest' }, 200, { 'retry-after': '120' });
    }
    throw new Error(`unexpected path ${url.pathname}`);
  });
  const limited = await adapter.execute(
    request('feishu.bitable.record.list', { resource: 'sales.pipeline' }, { idempotencyKey: null }),
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, 'RATE_LIMITED');
  assert.equal(limited.body.retryable, true);
  assert.equal(limited.body.retryAfterMs, 30_000);

  const timeoutAdapter = createFeishuBitableAdapter({
    appId: 'cli-app-id',
    appSecret: 'gateway-only-app-secret',
    cursorSecret: 'cursor-secret-at-least-32-characters-long',
    confirmationSecret: 'confirmation-secret-at-least-32-characters',
    baseUrl: 'https://mock.feishu.local/open-apis',
    timeoutMs: 5,
    resources: {
      'sales.pipeline': {
        appToken: APP_TOKEN,
        tableId: TABLE_ID,
        readers: [ALICE],
        writers: [ALICE],
      },
    },
    fetchImpl: async (url, init = {}) => {
      if (String(url).endsWith('/auth/v3/tenant_access_token/internal')) {
        return json({ code: 0, tenant_access_token: TENANT_TOKEN, expire: 7200 });
      }
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      });
    },
  });
  const timedOut = await timeoutAdapter.execute(
    request('feishu.bitable.record.list', { resource: 'sales.pipeline' }, { idempotencyKey: null }),
  );
  assert.equal(timedOut.status, 504);
  assert.equal(timedOut.body.code, 'TIMEOUT');
  assert.equal(timedOut.body.retryable, true);
});

test('Feishu authentication, permission, not-found and conflict errors map to closed codes', async () => {
  const cases = [
    { status: 401, providerCode: 99991663, expected: 'UPSTREAM_AUTHENTICATION_FAILED', retryable: false },
    { status: 403, providerCode: 1254302, expected: 'BACKEND_UNAUTHORIZED', retryable: false },
    { status: 404, providerCode: 1254043, expected: 'NOT_FOUND', retryable: false },
    { status: 200, providerCode: 1254291, expected: 'CONFLICT', retryable: true },
  ];
  for (const item of cases) {
    const { adapter } = makeHarness(({ url }) => {
      if (!url.pathname.endsWith('/records/rec-missing')) throw new Error(`unexpected path ${url.pathname}`);
      return json({ code: item.providerCode, msg: 'provider detail must not leak' }, item.status);
    });
    const response = await adapter.execute(
      request(
        'feishu.bitable.record.get',
        { resource: 'sales.pipeline', recordId: 'rec-missing' },
        { idempotencyKey: null },
      ),
    );
    assert.equal(response.body.code, item.expected);
    assert.equal(response.body.retryable, item.retryable);
    assert.doesNotMatch(response.body.message, /provider detail/);
  }
});

test('best-effort batches preserve index alignment and report partial success', async () => {
  let createCalls = 0;
  const { adapter } = makeHarness(({ url, body }) => {
    if (!url.pathname.endsWith('/records')) throw new Error(`unexpected path ${url.pathname}`);
    createCalls += 1;
    return json({ code: 0, data: { record: { record_id: 'rec-ok', fields: body.fields } } });
  });

  const response = await adapter.execute(
    request(
      'feishu.bitable.record.batch_create',
      {
        resource: 'sales.pipeline',
        mode: 'best-effort',
        records: [{ fields: { Name: 'Valid' } }, { fields: { UnknownField: 'Rejected before provider' } }],
      },
      { idempotencyKey: 'batch-create-key' },
    ),
  );
  assert.equal(response.ok, true);
  assert.equal(response.result.ok, false);
  assert.equal(response.result.partial, true);
  assert.deepEqual(
    response.result.results.map((item) => item.index),
    [0, 1],
  );
  assert.equal(response.result.results[0].ok, true);
  assert.equal(response.result.results[1].error.code, 'VALIDATION_FAILED');
  assert.equal(createCalls, 1);

  const unsupportedAtomic = await adapter.execute(
    request(
      'feishu.bitable.record.batch_create',
      {
        resource: 'sales.pipeline',
        mode: 'atomic',
        records: [{ fields: { Name: 'Atomic requires explicit provider guarantee' } }],
      },
      { idempotencyKey: 'atomic-batch-key' },
    ),
  );
  assert.equal(unsupportedAtomic.body.code, 'VALIDATION_FAILED');
  assert.equal(createCalls, 1);
});
