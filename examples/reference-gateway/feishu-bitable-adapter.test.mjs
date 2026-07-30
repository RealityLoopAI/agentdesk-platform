import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeFeishuBitableRecordFingerprint,
  createFeishuBitableAdapter,
  loadFeishuBitableConfigFromEnv,
} from './feishu-bitable-adapter.mjs';

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
        { field_id: 'fld-amount', field_name: 'Amount', type: 2, ui_type: 'Number', property: null },
        { field_id: 'fld-due', field_name: 'DueDate', type: 5, ui_type: 'DateTime', property: null },
        { field_id: 'fld-done', field_name: 'Done', type: 7, ui_type: 'Checkbox', property: null },
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
    readEnabled: true,
    writeEnabled: true,
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
    agent: { agentGroupId: 'bitable-worker' },
    requesterSource: 'session',
    dryRun: false,
    idempotencyKey: operation.includes('.record.') ? `idem-${operation}-${JSON.stringify(input)}` : null,
    ...overrides,
  };
}

function confirmationDisplay(preview) {
  return {
    recordId: preview.recordId,
    diff: preview.diff,
    expectedRecordFingerprint: preview.expectedRecordFingerprint,
    expiresAt: preview.expiresAt,
    highImpactFields: preview.highImpactFields,
  };
}

async function previewAndIssue(adapter, input, overrides = {}) {
  const previewResponse = await adapter.execute(
    request('feishu.bitable.record.update', input, {
      dryRun: true,
      idempotencyKey: null,
      ...overrides,
    }),
  );
  assert.equal(previewResponse.ok, true);
  const issued = await adapter.issueConfirmationRequest({
    requester: overrides.requester ?? { userId: ALICE },
    agent: overrides.agent ?? { agentGroupId: 'bitable-worker' },
    requesterSource: overrides.requesterSource ?? 'session',
    confirmationRequest: previewResponse.preview.confirmationRequest,
    display: confirmationDisplay(previewResponse.preview),
    context: {},
  });
  assert.equal(issued.ok, true);
  assert.equal(issued.bindingHash, previewResponse.preview.bindingHash);
  return { previewResponse, issued };
}

test('record fingerprint is stable across field order and changes with content or provider metadata', () => {
  const first = computeFeishuBitableRecordFingerprint({
    recordId: 'rec-1',
    fields: { Status: 'Open', Name: 'Alpha' },
    revision: '7',
    updatedAt: '2026-07-30T08:00:00.000Z',
  });
  const reordered = computeFeishuBitableRecordFingerprint({
    updatedAt: '2026-07-30T08:00:00.000Z',
    revision: '7',
    fields: { Name: 'Alpha', Status: 'Open' },
    recordId: 'rec-1',
  });
  assert.match(first, /^sha256:[a-f0-9]{64}$/);
  assert.equal(reordered, first);
  assert.notEqual(
    computeFeishuBitableRecordFingerprint({
      recordId: 'rec-1',
      fields: { Name: 'Alpha', Status: 'Closed' },
      revision: '7',
      updatedAt: '2026-07-30T08:00:00.000Z',
    }),
    first,
  );
  assert.notEqual(
    computeFeishuBitableRecordFingerprint({
      recordId: 'rec-1',
      fields: { Name: 'Alpha', Status: 'Open' },
      revision: '8',
      updatedAt: '2026-07-30T08:00:00.000Z',
    }),
    first,
  );
});

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

test('read and write release gates independently control discovery and execution', async () => {
  const { adapter, calls } = makeHarness(
    () => {
      throw new Error('disabled operation must not reach Feishu');
    },
    { readEnabled: true, writeEnabled: false },
  );

  const descriptors = adapter.describeOperations();
  assert.equal(descriptors.length, 5);
  assert.ok(descriptors.every((descriptor) => descriptor.mutating === false));
  assert.equal(adapter.isOperation('feishu.bitable.record.list'), true);
  assert.equal(adapter.isOperation('feishu.bitable.record.create'), false);

  const disabledWrite = await adapter.execute(
    request('feishu.bitable.record.create', {
      resource: 'sales.pipeline',
      fields: { Name: 'must stay disabled' },
    }),
  );
  assert.equal(disabledWrite.status, 404);
  assert.equal(disabledWrite.body.code, 'OPERATION_NOT_FOUND');
  assert.equal(calls.length, 0);

  const writeOnly = makeHarness(
    () => {
      throw new Error('test only inspects discovery');
    },
    { readEnabled: false, writeEnabled: true },
  ).adapter;
  assert.ok(writeOnly.describeOperations().every((descriptor) => descriptor.mutating === true));
  assert.equal(writeOnly.describeOperations().length, 6);

  const allDisabledHarness = makeHarness(
    () => {
      throw new Error('disabled operation must not reach Feishu');
    },
    { readEnabled: false, writeEnabled: false },
  );
  assert.deepEqual(allDisabledHarness.adapter.describeOperations(), []);
  const disabledRead = await allDisabledHarness.adapter.execute(
    request('feishu.bitable.record.list', { resource: 'sales.pipeline' }, { idempotencyKey: null }),
  );
  assert.equal(disabledRead.status, 404);
  assert.equal(disabledRead.body.code, 'OPERATION_NOT_FOUND');
  assert.equal(allDisabledHarness.calls.length, 0);
});

test('Bitable feature flags are opt-in and fail closed on invalid or missing configuration', () => {
  const credentials = {
    FEISHU_BITABLE_APP_ID: 'cli-app-id',
    FEISHU_BITABLE_APP_SECRET: 'gateway-only-app-secret',
    FEISHU_BITABLE_RESOURCES_JSON: JSON.stringify({
      sales: { appToken: APP_TOKEN, readers: [ALICE], writers: [ALICE] },
    }),
    FEISHU_BITABLE_CURSOR_SECRET: 'cursor-secret-at-least-32-characters-long',
    FEISHU_BITABLE_CONFIRMATION_SECRET: 'confirmation-secret-at-least-32-characters',
  };

  assert.deepEqual(
    {
      readEnabled: loadFeishuBitableConfigFromEnv(credentials).readEnabled,
      writeEnabled: loadFeishuBitableConfigFromEnv(credentials).writeEnabled,
    },
    { readEnabled: false, writeEnabled: false },
  );
  assert.equal(
    loadFeishuBitableConfigFromEnv({
      ...credentials,
      FEISHU_BITABLE_READ_ENABLED: 'true',
    }).readEnabled,
    true,
  );
  assert.throws(
    () => loadFeishuBitableConfigFromEnv({ FEISHU_BITABLE_WRITE_ENABLED: 'true' }),
    /credentials\/resources/,
  );
  assert.throws(
    () => loadFeishuBitableConfigFromEnv({ FEISHU_BITABLE_READ_ENABLED: 'enabled' }),
    /FEISHU_BITABLE_READ_ENABLED/,
  );
});

test('query-create-update pilot exposes only the intended operation subset to every trusted canonical user', async () => {
  let createCalls = 0;
  const { adapter, calls } = makeHarness(
    ({ url, body }) => {
      if (url.pathname.endsWith('/records/search')) {
        return json({
          code: 0,
          data: { items: [{ record_id: 'rec-existing', fields: { Name: 'Existing' } }], has_more: false },
        });
      }
      if (url.pathname.endsWith('/records')) {
        createCalls += 1;
        return json({ code: 0, data: { record: { record_id: 'rec-created', fields: body.fields } } });
      }
      throw new Error(`unexpected path ${url.pathname}`);
    },
    {
      resources: {
        'pilot.records': {
          appToken: APP_TOKEN,
          tableId: TABLE_ID,
          readers: ['*'],
          writers: ['*'],
          requiredFields: ['Name'],
          allowedOperations: [
            'feishu.bitable.field.list',
            'feishu.bitable.record.list',
            'feishu.bitable.record.get',
            'feishu.bitable.record.create',
            'feishu.bitable.record.update',
          ],
        },
      },
    },
  );

  assert.deepEqual(
    adapter.describeOperations().map((item) => item.name),
    [
      'feishu.bitable.field.list',
      'feishu.bitable.record.list',
      'feishu.bitable.record.get',
      'feishu.bitable.record.create',
      'feishu.bitable.record.update',
    ],
  );

  const readAsBob = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      { resource: 'pilot.records' },
      { requester: { userId: BOB }, idempotencyKey: null },
    ),
  );
  assert.equal(readAsBob.ok, true);

  const missingRequired = await adapter.execute(
    request(
      'feishu.bitable.record.create',
      { resource: 'pilot.records', fields: { Status: 'Open' } },
      { requester: { userId: BOB }, idempotencyKey: 'pilot-missing-required' },
    ),
  );
  assert.equal(missingRequired.body.code, 'VALIDATION_FAILED');

  const unknownField = await adapter.execute(
    request(
      'feishu.bitable.record.create',
      { resource: 'pilot.records', fields: { Name: 'Blocked', SecretColumn: 'no' } },
      { requester: { userId: BOB }, idempotencyKey: 'pilot-unknown-field' },
    ),
  );
  assert.equal(unknownField.body.code, 'VALIDATION_FAILED');

  for (const operation of [
    'feishu.bitable.record.delete',
    'feishu.bitable.record.batch_create',
    'feishu.bitable.record.batch_update',
    'feishu.bitable.record.batch_delete',
  ]) {
    const denied = await adapter.execute(
      request(
        operation,
        operation.includes('batch_')
          ? { resource: 'pilot.records', mode: 'best-effort', records: [] }
          : operation.endsWith('.delete')
            ? { resource: 'pilot.records', recordId: 'rec-existing' }
            : { resource: 'pilot.records', recordId: 'rec-existing', fields: { Name: 'no' } },
        { requester: { userId: BOB }, idempotencyKey: `pilot-denied-${operation}` },
      ),
    );
    assert.ok(['RESOURCE_NOT_ALLOWED', 'VALIDATION_FAILED'].includes(denied.body.code));
  }

  const anonymous = await adapter.execute(
    request(
      'feishu.bitable.record.create',
      { resource: 'pilot.records', fields: { Name: 'Anonymous' } },
      { requester: { userId: '' }, idempotencyKey: 'pilot-anonymous' },
    ),
  );
  assert.equal(anonymous.body.code, 'BACKEND_UNAUTHORIZED');

  const asserted = await adapter.execute(
    request(
      'feishu.bitable.record.create',
      { resource: 'pilot.records', fields: { Name: 'Asserted' } },
      { requester: { userId: BOB }, requesterSource: 'agent-asserted', idempotencyKey: 'pilot-asserted' },
    ),
  );
  assert.equal(asserted.body.code, 'BACKEND_UNAUTHORIZED');

  const createRequest = request(
    'feishu.bitable.record.create',
    { resource: 'pilot.records', fields: { Name: 'Exactly once' } },
    { requester: { userId: BOB }, idempotencyKey: 'pilot-stable-create' },
  );
  const created = await adapter.execute(createRequest);
  const replay = await adapter.execute(createRequest);
  assert.equal(created.result.recordId, 'rec-created');
  assert.equal(replay.result.recordId, 'rec-created');
  assert.equal(replay.replayed, true);
  assert.equal(createCalls, 1);
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

test('structured query/order are schema-validated, provider-compiled and field-projected', async () => {
  let searchCalls = 0;
  const { adapter, calls } = makeHarness(({ url, body }) => {
    if (!url.pathname.endsWith('/records/search')) throw new Error(`unexpected path ${url.pathname}`);
    searchCalls += 1;
    assert.deepEqual(body.filter, {
      conjunction: 'and',
      conditions: [
        { field_name: 'Name', operator: 'contains', value: ['Qual'] },
        { field_name: 'Status', operator: 'is', value: ['Open'] },
        { field_name: 'Amount', operator: 'isGreaterEqual', value: ['100'] },
        { field_name: 'DueDate', operator: 'isLess', value: ['ExactDate', '1800000000001'] },
        { field_name: 'Done', operator: 'is', value: ['false'] },
      ],
    });
    assert.deepEqual(body.sort, [{ field_name: 'DueDate', desc: false }]);
    assert.deepEqual(body.field_names, ['Name', 'Status']);
    return json({
      code: 0,
      data: {
        items: [
          {
            record_id: 'rec-filtered',
            fields: { Name: 'Qualified', Status: 'Open', SecretColumn: 'must-not-leak' },
          },
        ],
        has_more: false,
      },
    });
  });

  const result = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      {
        resource: 'sales.pipeline',
        pageSize: 20,
        fields: ['Name', 'Status'],
        query: {
          conjunction: 'and',
          conditions: [
            { field: 'Name', operator: 'contains', value: 'Qual' },
            { field: 'Status', operator: 'eq', value: 'Open' },
            { field: 'Amount', operator: 'gte', value: 100 },
            { field: 'DueDate', operator: 'lte', value: 1_800_000_000_000 },
            { field: 'Done', operator: 'eq', value: false },
          ],
        },
        orderBy: [{ field: 'DueDate', direction: 'asc' }],
      },
      { idempotencyKey: null },
    ),
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.result.items[0].fields, { Name: 'Qualified', Status: 'Open' });
  assert.equal(searchCalls, 1);
  assert.equal(calls.filter((call) => call.url.includes('/fields')).length, 1);
});

test('invalid structured queries fail before record search and cannot mix aliases or raw provider fields', async () => {
  const { adapter, calls } = makeHarness(() => {
    throw new Error('invalid structured query must not reach record search');
  });
  const cases = [
    {
      query: { conjunction: 'and', conditions: [{ field: 'Missing', operator: 'eq', value: 'x' }] },
    },
    {
      query: { conjunction: 'and', conditions: [{ field: 'Status', operator: 'eq', value: 'Unknown' }] },
    },
    {
      query: { conjunction: 'and', conditions: [{ field: 'Amount', operator: 'contains', value: '1' }] },
    },
    {
      query: { conjunction: 'and', conditions: [{ field: 'Name', operator: 'startsWith', value: 'A' }] },
    },
    {
      filterAlias: 'active',
      query: { conjunction: 'and', conditions: [{ field: 'Status', operator: 'eq', value: 'Open' }] },
    },
    {
      filter: { conjunction: 'and', conditions: [] },
    },
  ];
  for (const item of cases) {
    const response = await adapter.execute(
      request('feishu.bitable.record.list', { resource: 'sales.pipeline', ...item }, { idempotencyKey: null }),
    );
    assert.equal(response.body.code, 'VALIDATION_FAILED');
  }
  assert.equal(calls.filter((call) => call.url.includes('/records/search')).length, 0);
});

test('structured cursors bind query, order, resource view and field projection', async () => {
  let recordCalls = 0;
  const { adapter } = makeHarness(({ url }) => {
    if (!url.pathname.endsWith('/records/search')) throw new Error(`unexpected path ${url.pathname}`);
    recordCalls += 1;
    return json({
      code: 0,
      data: {
        items: [{ record_id: `rec-${recordCalls}`, fields: { Name: 'Bound' } }],
        has_more: recordCalls === 1,
        page_token: recordCalls === 1 ? 'provider-page-2' : undefined,
      },
    });
  });
  const query = {
    conjunction: 'and',
    conditions: [{ field: 'Status', operator: 'eq', value: 'Open' }],
  };
  const first = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      { resource: 'sales.pipeline', query, fields: ['Name'], orderBy: [{ field: 'Name', direction: 'asc' }] },
      { idempotencyKey: null },
    ),
  );
  assert.equal(first.result.hasMore, true);

  for (const rebound of [
    { query: { conjunction: 'and', conditions: [{ field: 'Status', operator: 'eq', value: 'Closed' }] } },
    { orderBy: [{ field: 'Name', direction: 'desc' }] },
    { fields: ['Status'] },
  ]) {
    const response = await adapter.execute(
      request(
        'feishu.bitable.record.list',
        {
          resource: 'sales.pipeline',
          query,
          fields: ['Name'],
          orderBy: [{ field: 'Name', direction: 'asc' }],
          cursor: first.result.nextCursor,
          ...rebound,
        },
        { idempotencyKey: null },
      ),
    );
    assert.equal(response.body.code, 'VALIDATION_FAILED');
  }
  assert.equal(recordCalls, 1);
});

test('pilot query-create-update lifecycle is bounded, idempotent, conflict-safe and Get-verified', async () => {
  let createCalls = 0;
  let updateCalls = 0;
  let searchCalls = 0;
  let revision = 1;
  const records = new Map([
    [
      'rec-seed-1',
      {
        record_id: 'rec-seed-1',
        fields: { Name: 'Seed one', Status: 'Open', Done: false },
        revision: '1',
        last_modified_time: 1_800_000_000_000,
      },
    ],
    [
      'rec-seed-2',
      {
        record_id: 'rec-seed-2',
        fields: { Name: 'Seed two', Status: 'Open', Done: false },
        revision: '1',
        last_modified_time: 1_800_000_000_000,
      },
    ],
  ]);
  const { adapter, audits } = makeHarness(
    ({ url, init, body }) => {
      if (url.pathname.endsWith('/records/search')) {
        searchCalls += 1;
        assert.deepEqual(body.filter, {
          conjunction: 'and',
          conditions: [
            { field_name: 'Status', operator: 'is', value: ['Open'] },
            { field_name: 'Done', operator: 'is', value: ['false'] },
          ],
        });
        assert.equal(url.searchParams.get('page_size'), '1');
        if (!url.searchParams.get('page_token')) {
          return json({
            code: 0,
            data: {
              items: [records.get('rec-seed-1')],
              has_more: true,
              page_token: 'provider-lifecycle-page-2',
            },
          });
        }
        assert.equal(url.searchParams.get('page_token'), 'provider-lifecycle-page-2');
        return json({
          code: 0,
          data: { items: [records.get('rec-seed-2')], has_more: false },
        });
      }
      if (url.pathname.endsWith('/records') && init.method === 'POST') {
        createCalls += 1;
        const record = {
          record_id: 'rec-created',
          fields: body.fields,
          revision: String(revision),
          last_modified_time: 1_800_000_000_000 + revision,
        };
        records.set(record.record_id, record);
        return json({ code: 0, data: { record } });
      }
      const match = url.pathname.match(/\/records\/([^/]+)$/);
      if (match && (init.method ?? 'GET') === 'GET') {
        const record = records.get(match[1]);
        if (!record) return json({ code: 1254043, msg: 'not found' }, 404);
        return json({ code: 0, data: { record } });
      }
      if (match && init.method === 'PUT') {
        updateCalls += 1;
        const current = records.get(match[1]);
        revision += 1;
        const updated = {
          ...current,
          fields: { ...current.fields, ...body.fields },
          revision: String(revision),
          last_modified_time: 1_800_000_000_000 + revision,
        };
        records.set(match[1], updated);
        return json({ code: 0, data: { record: updated } });
      }
      throw new Error(`unexpected provider request ${init.method ?? 'GET'} ${url.pathname}`);
    },
    {
      resources: {
        'pilot.records': {
          appToken: APP_TOKEN,
          tableId: TABLE_ID,
          readers: ['*'],
          writers: ['*'],
          requiredFields: ['Name'],
          highImpactFields: ['Status'],
          allowedOperations: [
            'feishu.bitable.field.list',
            'feishu.bitable.record.list',
            'feishu.bitable.record.get',
            'feishu.bitable.record.create',
            'feishu.bitable.record.update',
          ],
        },
      },
    },
  );

  const queryInput = {
    resource: 'pilot.records',
    pageSize: 1,
    fields: ['Name', 'Status', 'Done'],
    query: {
      conjunction: 'and',
      conditions: [
        { field: 'Status', operator: 'eq', value: 'Open' },
        { field: 'Done', operator: 'eq', value: false },
      ],
    },
  };
  const firstPage = await adapter.execute(request('feishu.bitable.record.list', queryInput, { idempotencyKey: null }));
  assert.equal(firstPage.result.hasMore, true);
  assert.doesNotMatch(firstPage.result.nextCursor, /provider-lifecycle-page-2/);
  const secondPage = await adapter.execute(
    request(
      'feishu.bitable.record.list',
      { ...queryInput, cursor: firstPage.result.nextCursor },
      { idempotencyKey: null },
    ),
  );
  assert.equal(secondPage.result.hasMore, false);
  assert.equal(searchCalls, 2);

  const createRequest = request(
    'feishu.bitable.record.create',
    {
      resource: 'pilot.records',
      fields: { Name: 'Lifecycle', Status: 'Open', Done: false },
    },
    { idempotencyKey: 'lifecycle-create' },
  );
  const created = await adapter.execute(createRequest);
  const createReplay = await adapter.execute(createRequest);
  assert.equal(created.result.recordId, 'rec-created');
  assert.equal(createReplay.replayed, true);
  assert.equal(createCalls, 1);

  const initialPreview = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { resource: 'pilot.records', recordId: 'rec-created', fields: { Status: 'Closed' } },
      { dryRun: true, idempotencyKey: null },
    ),
  );
  const initialIssued = await adapter.issueConfirmationRequest({
    requester: { userId: ALICE },
    agent: { agentGroupId: 'bitable-worker' },
    requesterSource: 'session',
    confirmationRequest: initialPreview.preview.confirmationRequest,
    display: confirmationDisplay(initialPreview.preview),
    context: {},
  });
  const externallyChanged = records.get('rec-created');
  revision += 1;
  records.set('rec-created', {
    ...externallyChanged,
    fields: { ...externallyChanged.fields, Name: 'Externally changed' },
    revision: String(revision),
    last_modified_time: 1_800_000_000_000 + revision,
  });
  const conflict = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      {
        resource: 'pilot.records',
        recordId: 'rec-created',
        fields: { Status: 'Closed' },
        expectedRecordFingerprint: initialPreview.preview.expectedRecordFingerprint,
        confirmation: initialIssued.confirmation,
      },
      { idempotencyKey: 'lifecycle-conflict' },
    ),
  );
  assert.equal(conflict.body.code, 'CONFLICT');
  assert.equal(updateCalls, 0);

  const { previewResponse, issued } = await previewAndIssue(adapter, {
    resource: 'pilot.records',
    recordId: 'rec-created',
    fields: { Status: 'Closed' },
  });
  const updateRequest = request(
    'feishu.bitable.record.update',
    {
      resource: 'pilot.records',
      recordId: 'rec-created',
      fields: { Status: 'Closed' },
      expectedRecordFingerprint: previewResponse.preview.expectedRecordFingerprint,
      confirmation: issued.confirmation,
    },
    { idempotencyKey: 'lifecycle-update' },
  );
  const updated = await adapter.execute(updateRequest);
  const updateReplay = await adapter.execute({
    ...updateRequest,
    input: { ...updateRequest.input, confirmation: 'replay-does-not-reuse-token' },
  });
  assert.equal(updated.result.fields.Status, 'Closed');
  assert.equal(updated.result.verification.verified, true);
  assert.ok(updated.result.verification.getAuditId);
  assert.equal(updateReplay.replayed, true);
  assert.equal(updateCalls, 1);
  assert.ok(audits.some((event) => event.phase === 'execute' && event.idempotencyKey === 'lifecycle-create'));
  assert.ok(audits.some((event) => event.phase === 'execute' && event.idempotencyKey === 'lifecycle-update'));
});

test('record search rejects provider pages larger than the requested bound', async () => {
  const { adapter } = makeHarness(({ url }) => {
    if (!url.pathname.endsWith('/records/search')) throw new Error(`unexpected path ${url.pathname}`);
    return json({
      code: 0,
      data: {
        items: [
          { record_id: 'rec-1', fields: { Name: 'One' } },
          { record_id: 'rec-2', fields: { Name: 'Two' } },
        ],
        has_more: false,
      },
    });
  });
  const response = await adapter.execute(
    request('feishu.bitable.record.list', { resource: 'sales.pipeline', pageSize: 1 }, { idempotencyKey: null }),
  );
  assert.equal(response.body.code, 'BACKEND_UNAVAILABLE');
});

test('record search enforces the configured response byte bound without fetching another page', async () => {
  let searchCalls = 0;
  const { adapter } = makeHarness(
    ({ url }) => {
      if (!url.pathname.endsWith('/records/search')) throw new Error(`unexpected path ${url.pathname}`);
      searchCalls += 1;
      return json({
        code: 0,
        data: {
          items: [{ record_id: 'rec-large', fields: { Name: 'x'.repeat(1_000) } }],
          has_more: true,
          page_token: 'provider-page-2',
        },
      });
    },
    { maxResponseBytes: 128 },
  );
  const response = await adapter.execute(
    request('feishu.bitable.record.list', { resource: 'sales.pipeline', pageSize: 1 }, { idempotencyKey: null }),
  );
  assert.equal(response.body.code, 'VALIDATION_FAILED');
  assert.equal(searchCalls, 1);
});

test('field schema cache refreshes once on drift and validates before Update preview', async () => {
  let fieldCalls = 0;
  let writeCalls = 0;
  const driftCalls = [];
  const driftAdapter = createFeishuBitableAdapter({
    appId: 'cli-app-id',
    appSecret: 'gateway-only-app-secret',
    cursorSecret: 'cursor-secret-at-least-32-characters-long',
    confirmationSecret: 'confirmation-secret-at-least-32-characters',
    readEnabled: true,
    writeEnabled: true,
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
      if (href.endsWith('/records') && init.method === 'POST') {
        writeCalls += 1;
        const body = JSON.parse(init.body);
        return json({ code: 0, data: { record: { record_id: 'rec-created', fields: body.fields } } });
      }
      if (href.endsWith('/records/rec-created') && (init.method ?? 'GET') === 'GET') {
        return json({
          code: 0,
          data: { record: { record_id: 'rec-created', fields: { Name: 'Initial', Priority: 1 } } },
        });
      }
      throw new Error(`unexpected provider request ${init.method ?? 'GET'} ${href}`);
    },
  });

  const created = await driftAdapter.execute(
    request('feishu.bitable.record.create', { resource: 'sales.pipeline', fields: { Name: 'Initial' } }),
  );
  assert.equal(created.ok, true);
  const updated = await driftAdapter.execute(
    request(
      'feishu.bitable.record.update',
      {
        resource: 'sales.pipeline',
        recordId: 'rec-created',
        fields: { Priority: 2 },
      },
      { dryRun: true, idempotencyKey: null },
    ),
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.preview.diff[0].field, 'Priority');
  assert.equal(fieldCalls, 2);
  assert.equal(writeCalls, 1);
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

test('delete keeps legacy confirmation while every Update uses Preview and Host-mediated confirmation', async () => {
  let deleteCalls = 0;
  let updateCalls = 0;
  let currentFields = { Name: 'Initial', Status: 'Open' };
  const { adapter } = makeHarness(({ url, init, body }) => {
    if (url.pathname.endsWith('/records/rec-1') && init.method === 'DELETE') {
      deleteCalls += 1;
      return json({ code: 0, data: {} });
    }
    if (url.pathname.endsWith('/records/rec-1') && (init.method ?? 'GET') === 'GET') {
      return json({ code: 0, data: { record: { record_id: 'rec-1', fields: currentFields } } });
    }
    if (url.pathname.endsWith('/records/rec-1') && init.method === 'PUT') {
      updateCalls += 1;
      currentFields = { ...currentFields, ...body.fields };
      return json({ code: 0, data: { record: { record_id: 'rec-1', fields: currentFields } } });
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

  const { previewResponse, issued } = await previewAndIssue(adapter, {
    resource: 'sales.pipeline',
    recordId: 'rec-1',
    fields: { Status: 'Closed' },
  });
  assert.deepEqual(previewResponse.preview.diff, [
    { field: 'Status', before: 'Open', after: 'Closed', highImpact: true },
  ]);
  assert.doesNotMatch(previewResponse.preview.confirmationRequest, /Open|Closed/);
  const highImpactCommitted = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      {
        resource: 'sales.pipeline',
        recordId: 'rec-1',
        fields: { Status: 'Closed' },
        expectedRecordFingerprint: previewResponse.preview.expectedRecordFingerprint,
        confirmation: issued.confirmation,
      },
      { idempotencyKey: 'high-impact-key' },
    ),
  );
  assert.equal(highImpactCommitted.result.fields.Status, 'Closed');
  assert.equal(highImpactCommitted.result.verification.verified, true);
  assert.equal(highImpactCommitted.result.verification.updateAuditId, highImpactCommitted.auditId);
  assert.ok(highImpactCommitted.result.verification.getAuditId);
  assert.equal(updateCalls, 1);
});

test('Update confirmation binds actor, group, record, patch, fingerprint, expiry, nonce and idempotency', async () => {
  let clock = 1_800_000_000_000;
  let updateCalls = 0;
  let current = {
    record_id: 'rec-secure',
    fields: { Name: 'Original', Status: 'Open', Done: false },
    revision: '1',
    last_modified_time: clock,
  };
  const { adapter, audits } = makeHarness(
    ({ url, init, body }) => {
      if (url.pathname.endsWith('/records/rec-secure') && (init.method ?? 'GET') === 'GET') {
        return json({ code: 0, data: { record: current } });
      }
      if (url.pathname.endsWith('/records/rec-other') && (init.method ?? 'GET') === 'GET') {
        return json({
          code: 0,
          data: {
            record: {
              record_id: 'rec-other',
              fields: { Name: 'Other', Status: 'Open', Done: false },
              revision: '1',
              last_modified_time: clock,
            },
          },
        });
      }
      if (url.pathname.endsWith('/records/rec-secure') && init.method === 'PUT') {
        updateCalls += 1;
        current = {
          ...current,
          fields: { ...current.fields, ...body.fields },
          revision: String(Number(current.revision) + 1),
          last_modified_time: clock + 1,
        };
        return json({ code: 0, data: { record: current } });
      }
      throw new Error(`unexpected path ${init.method ?? 'GET'} ${url.pathname}`);
    },
    {
      now: () => clock,
      confirmationTtlMs: 1_000,
      resources: {
        'sales.pipeline': {
          appToken: APP_TOKEN,
          tableId: TABLE_ID,
          readers: ['*'],
          writers: ['*'],
          requiredFields: ['Name'],
          highImpactFields: ['Status'],
          allowedOperations: [
            'feishu.bitable.field.list',
            'feishu.bitable.record.list',
            'feishu.bitable.record.get',
            'feishu.bitable.record.create',
            'feishu.bitable.record.update',
          ],
        },
      },
    },
  );

  const unconfirmed = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { resource: 'sales.pipeline', recordId: 'rec-secure', fields: { Done: true } },
      { idempotencyKey: 'update-unconfirmed' },
    ),
  );
  assert.equal(unconfirmed.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(updateCalls, 0);

  const noOp = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { resource: 'sales.pipeline', recordId: 'rec-secure', fields: { Done: false } },
      { dryRun: true, idempotencyKey: null },
    ),
  );
  assert.equal(noOp.body.code, 'VALIDATION_FAILED');

  const preview = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { resource: 'sales.pipeline', recordId: 'rec-secure', fields: { Done: true } },
      { dryRun: true, idempotencyKey: null },
    ),
  );
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.preview.diff, [{ field: 'Done', before: false, after: true, highImpact: false }]);
  assert.match(preview.preview.expectedRecordFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(preview.preview.bindingHash, /^sha256:[a-f0-9]{64}$/);
  assert.doesNotMatch(preview.preview.confirmationRequest, /Original|Done|false|true/);

  const wrongIssuer = await adapter.issueConfirmationRequest({
    requester: { userId: BOB },
    agent: { agentGroupId: 'bitable-worker' },
    requesterSource: 'session',
    confirmationRequest: preview.preview.confirmationRequest,
    display: confirmationDisplay(preview.preview),
    context: {},
  });
  assert.equal(wrongIssuer.body.code, 'BACKEND_UNAUTHORIZED');
  const wrongGroupIssuer = await adapter.issueConfirmationRequest({
    requester: { userId: ALICE },
    agent: { agentGroupId: 'other-worker' },
    requesterSource: 'session',
    confirmationRequest: preview.preview.confirmationRequest,
    display: confirmationDisplay(preview.preview),
    context: {},
  });
  assert.equal(wrongGroupIssuer.body.code, 'BACKEND_UNAUTHORIZED');
  const forgedDisplay = await adapter.issueConfirmationRequest({
    requester: { userId: ALICE },
    agent: { agentGroupId: 'bitable-worker' },
    requesterSource: 'session',
    confirmationRequest: preview.preview.confirmationRequest,
    display: {
      ...confirmationDisplay(preview.preview),
      diff: [{ field: 'Done', before: false, after: false, highImpact: false }],
    },
    context: {},
  });
  assert.equal(forgedDisplay.body.code, 'CONFIRMATION_REQUIRED');

  const issued = await adapter.issueConfirmationRequest({
    requester: { userId: ALICE },
    agent: { agentGroupId: 'bitable-worker' },
    requesterSource: 'session',
    confirmationRequest: preview.preview.confirmationRequest,
    display: confirmationDisplay(preview.preview),
    context: {},
  });
  assert.equal(issued.ok, true);

  const baseConfirmedInput = {
    resource: 'sales.pipeline',
    recordId: 'rec-secure',
    fields: { Done: true },
    expectedRecordFingerprint: preview.preview.expectedRecordFingerprint,
    confirmation: issued.confirmation,
  };
  const wrongActor = await adapter.execute(
    request('feishu.bitable.record.update', baseConfirmedInput, {
      requester: { userId: BOB },
      idempotencyKey: 'update-wrong-actor',
    }),
  );
  assert.equal(wrongActor.body.code, 'CONFIRMATION_REQUIRED');
  const wrongGroup = await adapter.execute(
    request('feishu.bitable.record.update', baseConfirmedInput, {
      agent: { agentGroupId: 'other-worker' },
      idempotencyKey: 'update-wrong-group',
    }),
  );
  assert.equal(wrongGroup.body.code, 'CONFIRMATION_REQUIRED');
  const wrongRecord = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { ...baseConfirmedInput, recordId: 'rec-other' },
      { idempotencyKey: 'update-wrong-record' },
    ),
  );
  assert.equal(wrongRecord.body.code, 'CONFIRMATION_REQUIRED');
  const wrongPatch = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { ...baseConfirmedInput, fields: { Done: false } },
      { idempotencyKey: 'update-wrong-patch' },
    ),
  );
  assert.equal(wrongPatch.body.code, 'CONFIRMATION_REQUIRED');
  const wrongFingerprint = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { ...baseConfirmedInput, expectedRecordFingerprint: `sha256:${'f'.repeat(64)}` },
      { idempotencyKey: 'update-wrong-fingerprint' },
    ),
  );
  assert.equal(wrongFingerprint.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(updateCalls, 0);

  clock += 1_001;
  const expired = await adapter.execute(
    request('feishu.bitable.record.update', baseConfirmedInput, {
      idempotencyKey: 'update-expired',
    }),
  );
  assert.equal(expired.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(updateCalls, 0);

  const conflictPreview = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      { resource: 'sales.pipeline', recordId: 'rec-secure', fields: { Done: true } },
      { dryRun: true, idempotencyKey: null },
    ),
  );
  const conflictIssued = await adapter.issueConfirmationRequest({
    requester: { userId: ALICE },
    agent: { agentGroupId: 'bitable-worker' },
    requesterSource: 'session',
    confirmationRequest: conflictPreview.preview.confirmationRequest,
    display: confirmationDisplay(conflictPreview.preview),
    context: {},
  });
  current = {
    ...current,
    fields: { ...current.fields, Name: 'External edit' },
    revision: '2',
    last_modified_time: clock + 1,
  };
  const conflicted = await adapter.execute(
    request(
      'feishu.bitable.record.update',
      {
        resource: 'sales.pipeline',
        recordId: 'rec-secure',
        fields: { Done: true },
        expectedRecordFingerprint: conflictPreview.preview.expectedRecordFingerprint,
        confirmation: conflictIssued.confirmation,
      },
      { idempotencyKey: 'update-fingerprint-conflict' },
    ),
  );
  assert.equal(conflicted.body.code, 'CONFLICT');
  assert.equal(updateCalls, 0);

  const { previewResponse: freshPreview, issued: freshIssued } = await previewAndIssue(adapter, {
    resource: 'sales.pipeline',
    recordId: 'rec-secure',
    fields: { Done: true },
  });
  const committedRequest = request(
    'feishu.bitable.record.update',
    {
      resource: 'sales.pipeline',
      recordId: 'rec-secure',
      fields: { Done: true },
      expectedRecordFingerprint: freshPreview.preview.expectedRecordFingerprint,
      confirmation: freshIssued.confirmation,
    },
    { idempotencyKey: 'update-stable-key' },
  );
  const committed = await adapter.execute(committedRequest);
  assert.equal(committed.ok, true);
  assert.equal(committed.result.fields.Done, true);
  assert.equal(committed.result.verification.verified, true);
  assert.equal(updateCalls, 1);

  const replay = await adapter.execute({
    ...committedRequest,
    input: { ...committedRequest.input, confirmation: 'malformed-but-ignored-on-replay' },
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.result.verification.updateAuditId, committed.auditId);
  assert.equal(updateCalls, 1);

  const rebound = await adapter.execute({
    ...committedRequest,
    input: {
      ...committedRequest.input,
      fields: { Status: 'Closed' },
      confirmation: 'malformed-but-conflict-precedes-confirmation',
    },
  });
  assert.equal(rebound.body.code, 'CONFLICT');
  assert.equal(updateCalls, 1);

  const reusedByOtherKey = await adapter.execute({
    ...committedRequest,
    idempotencyKey: 'update-other-key',
  });
  assert.equal(reusedByOtherKey.body.code, 'CONFIRMATION_REQUIRED');
  assert.equal(updateCalls, 1);

  assert.doesNotMatch(JSON.stringify(audits), /Original|External edit|Closed/);
  const successAudit = audits.find(
    (event) => event.phase === 'execute' && event.idempotencyKey === 'update-stable-key',
  );
  assert.equal(successAudit.fingerprintResult, 'match');
  assert.match(successAudit.confirmationBindingHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(successAudit.expectedRecordFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.match(successAudit.currentRecordFingerprint, /^sha256:[a-f0-9]{64}$/);
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
    readEnabled: true,
    writeEnabled: true,
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
