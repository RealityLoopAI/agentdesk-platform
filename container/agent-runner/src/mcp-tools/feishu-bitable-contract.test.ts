import { describe, expect, it } from 'bun:test';

import {
  BITABLE_MAX_BATCH_RECORDS,
  BITABLE_MAX_ORDER_BY,
  BITABLE_MAX_PAGE_SIZE,
  BITABLE_MAX_QUERY_CONDITIONS,
  FEISHU_BITABLE_CONFORMANCE_FIXTURES,
  FEISHU_BITABLE_INPUT_SCHEMAS,
  FEISHU_BITABLE_OPERATION_DESCRIPTORS,
  FEISHU_BITABLE_OPERATION_NAMES,
  FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES,
  bitableBatchResultSchema,
  bitableDeleteConfirmationBindingSchema,
  bitableDeletePreviewDisplaySchema,
  bitableDeletePreviewSchema,
  bitableDeleteResultSchema,
  bitableOrderBySchema,
  bitableRecordQuerySchema,
  bitableUpdateConfirmationBindingSchema,
  bitableUpdatePreviewDisplaySchema,
  bitableUpdatePreviewSchema,
  parseFeishuBitableInput,
} from './feishu-bitable-contract.js';
import { operationDescriptorSchema } from './gateway-contract.js';

describe('Feishu Bitable Gateway operation contract', () => {
  it('publishes a descriptor and a valid fixture for every operation', () => {
    expect(FEISHU_BITABLE_OPERATION_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual(
      FEISHU_BITABLE_OPERATION_NAMES,
    );

    for (const operation of FEISHU_BITABLE_OPERATION_NAMES) {
      expect(() => parseFeishuBitableInput(operation, FEISHU_BITABLE_CONFORMANCE_FIXTURES[operation])).not.toThrow();
    }
    for (const descriptor of FEISHU_BITABLE_OPERATION_DESCRIPTORS) {
      expect(() => operationDescriptorSchema.parse(descriptor)).not.toThrow();
    }
  });

  it('rejects raw Feishu identifiers because they are not operation fields', () => {
    expect(() =>
      FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.get'].parse({
        resource: 'sales.pipeline',
        recordId: 'rec-1',
        app_token: 'app-secret-resource',
        table_id: 'tbl-secret-resource',
      }),
    ).toThrow();
  });

  it('bounds list pages for Agent context safety', () => {
    expect(() =>
      FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.list'].parse({
        resource: 'sales.pipeline',
        pageSize: BITABLE_MAX_PAGE_SIZE + 1,
      }),
    ).toThrow();
  });

  it('accepts bounded structured record queries and rejects alias ambiguity or provider payloads', () => {
    const parsed = FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.list'].parse({
      resource: 'sales.pipeline',
      query: FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.query,
      orderBy: FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.orderBy,
    });
    expect(parsed.query?.conditions).toHaveLength(2);

    expect(() =>
      FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.list'].parse({
        resource: 'sales.pipeline',
        filterAlias: 'active',
        query: FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.query,
      }),
    ).toThrow();
    expect(() =>
      FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.list'].parse({
        resource: 'sales.pipeline',
        filter: { conjunction: 'and', conditions: [] },
      }),
    ).toThrow();
  });

  it('bounds batch sizes and requires the caller to declare semantics', () => {
    const tooMany = Array.from({ length: BITABLE_MAX_BATCH_RECORDS + 1 }, (_, index) => ({
      fields: { Name: `Record ${index}` },
    }));
    const schema = FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.batch_create'];

    expect(() => schema.parse({ resource: 'sales.pipeline', mode: 'best-effort', records: tooMany })).toThrow();
    expect(() =>
      schema.parse({ resource: 'sales.pipeline', records: [{ fields: { Name: 'Missing mode' } }] }),
    ).toThrow();
  });

  it('requires batch results to report partial success honestly', () => {
    const parsed = bitableBatchResultSchema.parse({
      mode: 'best-effort',
      ok: false,
      partial: true,
      results: [
        { index: 0, ok: true, record: { recordId: 'rec-1', fields: { Name: 'Valid' } } },
        {
          index: 1,
          ok: false,
          error: { code: 'VALIDATION_FAILED', message: 'unknown field: Missing' },
        },
      ],
    });
    expect(parsed.results.map((item) => item.index)).toEqual([0, 1]);
    expect(parsed.partial).toBe(true);
    expect(parsed.ok).toBe(false);
  });

  it('rejects misaligned or dishonest batch results', () => {
    expect(() =>
      bitableBatchResultSchema.parse({
        mode: 'best-effort',
        ok: true,
        partial: false,
        results: [
          { index: 1, ok: true, recordId: 'rec-1' },
          { index: 0, ok: false, error: { code: 'CONFLICT', message: 'write conflict' } },
        ],
      }),
    ).toThrow();
  });

  it('publishes machine-verifiable Query, Order, Preview and Confirmation fixtures', () => {
    expect(() => bitableRecordQuerySchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.query)).not.toThrow();
    expect(() => bitableOrderBySchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.orderBy)).not.toThrow();
    expect(() =>
      bitableUpdateConfirmationBindingSchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.updateConfirmationBinding),
    ).not.toThrow();
    expect(() => bitableUpdatePreviewSchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.updatePreview)).not.toThrow();
    expect(() =>
      bitableDeleteConfirmationBindingSchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.deleteConfirmationBinding),
    ).not.toThrow();
    expect(() => bitableDeletePreviewSchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.deletePreview)).not.toThrow();
    expect(() =>
      bitableDeleteResultSchema.parse({
        recordId: 'rec-conformance',
        deleted: true,
        verification: {
          verified: true,
          deleteAuditId: 'audit-delete',
          getAuditId: 'audit-get',
        },
      }),
    ).not.toThrow();
  });

  it('requires Delete commit fingerprint and bounds the Gateway-owned preview', () => {
    const parsed = FEISHU_BITABLE_INPUT_SCHEMAS['feishu.bitable.record.delete'].parse({
      resource: 'sales.pipeline',
      recordId: 'rec-conformance',
      expectedRecordFingerprint: `sha256:${'d'.repeat(64)}`,
      confirmation: 'opaque-delete-confirmation',
    });
    expect(parsed.expectedRecordFingerprint).toBe(`sha256:${'d'.repeat(64)}`);
    expect(() =>
      bitableDeletePreviewSchema.parse({
        ...FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.deletePreview,
        fields: Object.fromEntries(Array.from({ length: 201 }, (_, index) => [`Field ${index}`, index])),
      }),
    ).toThrow();
  });

  it('defines model-visible confirmation previews that reject the opaque Gateway request', () => {
    const { confirmationRequest: _updateOpaque, ...updateDisplay } =
      FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.updatePreview;
    const { confirmationRequest: _deleteOpaque, ...deleteDisplay } =
      FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.deletePreview;

    expect(() => bitableUpdatePreviewDisplaySchema.parse(updateDisplay)).not.toThrow();
    expect(() => bitableDeletePreviewDisplaySchema.parse(deleteDisplay)).not.toThrow();
    expect(() =>
      bitableUpdatePreviewDisplaySchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.updatePreview),
    ).toThrow();
    expect(() =>
      bitableDeletePreviewDisplaySchema.parse(FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES.deletePreview),
    ).toThrow();
  });

  it('bounds flat structured queries and rejects operator/value ambiguity', () => {
    const tooMany = Array.from({ length: BITABLE_MAX_QUERY_CONDITIONS + 1 }, (_, index) => ({
      field: `Field ${index}`,
      operator: 'eq',
      value: index,
    }));
    expect(() => bitableRecordQuerySchema.parse({ conjunction: 'and', conditions: tooMany })).toThrow();
    expect(() =>
      bitableRecordQuerySchema.parse({
        conjunction: 'and',
        conditions: [{ field: 'Name', operator: 'isEmpty', value: true }],
      }),
    ).toThrow();
    expect(() =>
      bitableRecordQuerySchema.parse({
        conjunction: 'and',
        conditions: [{ field: 'Name', operator: 'contains' }],
      }),
    ).toThrow();
  });

  it('bounds ordering and rejects provider-native order fields', () => {
    expect(() =>
      bitableOrderBySchema.parse(
        Array.from({ length: BITABLE_MAX_ORDER_BY + 1 }, (_, index) => ({
          field: `Field ${index}`,
          direction: 'asc',
        })),
      ),
    ).toThrow();
    expect(() => bitableOrderBySchema.parse([{ field_name: 'Name', desc: true }])).toThrow();
  });
});
