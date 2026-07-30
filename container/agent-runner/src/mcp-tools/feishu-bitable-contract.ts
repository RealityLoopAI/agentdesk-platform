/**
 * Feishu Bitable operations exposed through the generic Backend Gateway.
 *
 * This module is intentionally credentials-free. It describes the logical
 * operation names and their machine-verifiable input/output shapes; the actual
 * app_id/app_secret, tenant_access_token, app_token and table_id belong only in
 * the operator-owned Gateway process (ADR-0063).
 *
 * Security boundary:
 * - Agents submit `resource` aliases only. A Gateway resolves those aliases
 *   through an operator whitelist and MUST reject unknown aliases.
 * - Raw Feishu resource identifiers are not part of any input schema.
 * - Organization is not an input. Host-side organization isolation and
 *   Gateway-side business authorization stay separate (ADR-0052).
 */
import { z } from 'zod';

import { gatewayErrorSchema } from './gateway-contract.js';

/** Agent-facing bounds. Feishu currently permits larger record pages/batches. */
export const BITABLE_DEFAULT_PAGE_SIZE = 20;
export const BITABLE_MAX_PAGE_SIZE = 100;
export const BITABLE_MAX_BATCH_RECORDS = 100;
export const BITABLE_MAX_QUERY_CONDITIONS = 10;
export const BITABLE_MAX_ORDER_BY = 3;

export const FEISHU_BITABLE_OPERATION_NAMES = [
  'feishu.bitable.app.get',
  'feishu.bitable.table.list',
  'feishu.bitable.field.list',
  'feishu.bitable.record.list',
  'feishu.bitable.record.get',
  'feishu.bitable.record.create',
  'feishu.bitable.record.update',
  'feishu.bitable.record.delete',
  'feishu.bitable.record.batch_create',
  'feishu.bitable.record.batch_update',
  'feishu.bitable.record.batch_delete',
] as const;

export type FeishuBitableOperationName = (typeof FEISHU_BITABLE_OPERATION_NAMES)[number];

export const BITABLE_WRITE_OPERATIONS = new Set<FeishuBitableOperationName>([
  'feishu.bitable.record.create',
  'feishu.bitable.record.update',
  'feishu.bitable.record.delete',
  'feishu.bitable.record.batch_create',
  'feishu.bitable.record.batch_update',
  'feishu.bitable.record.batch_delete',
]);

export const BITABLE_DESTRUCTIVE_OPERATIONS = new Set<FeishuBitableOperationName>([
  'feishu.bitable.record.delete',
  'feishu.bitable.record.batch_delete',
]);

const resourceAliasSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, 'resource must be a configured logical alias');
const recordIdSchema = z.string().min(1).max(128);
const cursorSchema = z.string().min(1).max(4096);
const confirmationSchema = z.string().min(1).max(4096);
const fieldsSchema = z.record(z.string().min(1).max(256), z.unknown());
const pageSizeSchema = z.number().int().min(1).max(BITABLE_MAX_PAGE_SIZE);
const sha256Schema = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const bitableRecordFingerprintSchema = sha256Schema;

export const bitableQueryOperatorSchema = z.enum([
  'eq',
  'ne',
  'isEmpty',
  'isNotEmpty',
  'contains',
  'notContains',
  'startsWith',
  'gt',
  'gte',
  'lt',
  'lte',
]);
export type BitableQueryOperator = z.infer<typeof bitableQueryOperatorSchema>;

export const bitableQueryConditionSchema = z
  .object({
    field: z.string().min(1).max(256),
    operator: bitableQueryOperatorSchema,
    value: z.unknown().optional(),
  })
  .strict()
  .superRefine((condition, context) => {
    const valueRequired = condition.operator !== 'isEmpty' && condition.operator !== 'isNotEmpty';
    if (valueRequired && condition.value === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `value is required for ${condition.operator}`,
      });
    }
    if (!valueRequired && condition.value !== undefined) {
      context.addIssue({
        code: 'custom',
        path: ['value'],
        message: `value must be omitted for ${condition.operator}`,
      });
    }
  });

export const bitableRecordQuerySchema = z
  .object({
    conjunction: z.enum(['and', 'or']),
    conditions: z.array(bitableQueryConditionSchema).min(1).max(BITABLE_MAX_QUERY_CONDITIONS),
  })
  .strict();
export type BitableRecordQuery = z.infer<typeof bitableRecordQuerySchema>;

export const bitableOrderByItemSchema = z
  .object({
    field: z.string().min(1).max(256),
    direction: z.enum(['asc', 'desc']),
  })
  .strict();

export const bitableOrderBySchema = z.array(bitableOrderByItemSchema).min(1).max(BITABLE_MAX_ORDER_BY);
export type BitableOrderBy = z.infer<typeof bitableOrderBySchema>;

/**
 * Gateway-owned binding for a single-record Update confirmation (ADR-0073).
 * Hash fields never contain cell plaintext; `exp` is Unix epoch milliseconds.
 */
export const bitableUpdateConfirmationBindingSchema = z
  .object({
    v: z.literal(2),
    requesterUserId: z.string().min(1),
    agentGroupId: z.string().min(1),
    operation: z.literal('feishu.bitable.record.update'),
    resource: resourceAliasSchema,
    recordId: recordIdSchema,
    patchHash: sha256Schema,
    expectedRecordFingerprint: sha256Schema,
    exp: z.number().int().positive(),
    nonce: z.string().min(1).max(256),
  })
  .strict();
export type BitableUpdateConfirmationBinding = z.infer<typeof bitableUpdateConfirmationBindingSchema>;

/** Gateway-owned binding for a single-record Delete confirmation (ADR-0075). */
export const bitableDeleteConfirmationBindingSchema = z
  .object({
    v: z.literal(2),
    requesterUserId: z.string().min(1),
    agentGroupId: z.string().min(1),
    operation: z.literal('feishu.bitable.record.delete'),
    resource: resourceAliasSchema,
    recordId: recordIdSchema,
    expectedRecordFingerprint: sha256Schema,
    exp: z.number().int().positive(),
    nonce: z.string().min(1).max(256),
  })
  .strict();
export type BitableDeleteConfirmationBinding = z.infer<typeof bitableDeleteConfirmationBindingSchema>;

const resourceInputSchema = z.object({ resource: resourceAliasSchema }).strict();
const paginatedResourceInputSchema = z
  .object({
    resource: resourceAliasSchema,
    pageSize: pageSizeSchema.optional(),
    cursor: cursorSchema.optional(),
  })
  .strict();

const recordListInputSchema = z
  .object({
    resource: resourceAliasSchema,
    pageSize: pageSizeSchema.optional(),
    cursor: cursorSchema.optional(),
    /**
     * These are policy aliases, not raw Feishu filter/view/sort expressions.
     * The Gateway maps each alias through the resource's allowlist.
     */
    viewAlias: z.string().min(1).max(128).optional(),
    filterAlias: z.string().min(1).max(128).optional(),
    sortAlias: z.string().min(1).max(128).optional(),
    fields: z.array(z.string().min(1).max(256)).max(200).optional(),
    query: bitableRecordQuerySchema.optional(),
    orderBy: bitableOrderBySchema.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if ((input.filterAlias !== undefined || input.sortAlias !== undefined) && (input.query || input.orderBy)) {
      context.addIssue({
        code: 'custom',
        path: ['query'],
        message: 'filterAlias/sortAlias cannot be combined with structured query/orderBy',
      });
    }
  });

const recordGetInputSchema = z
  .object({
    resource: resourceAliasSchema,
    recordId: recordIdSchema,
  })
  .strict();

const recordCreateInputSchema = z
  .object({
    resource: resourceAliasSchema,
    fields: fieldsSchema,
  })
  .strict();

const recordUpdateInputSchema = z
  .object({
    resource: resourceAliasSchema,
    recordId: recordIdSchema,
    fields: fieldsSchema,
    expectedRecordFingerprint: bitableRecordFingerprintSchema.optional(),
    confirmation: confirmationSchema.optional(),
  })
  .strict();

const recordDeleteInputSchema = z
  .object({
    resource: resourceAliasSchema,
    recordId: recordIdSchema,
    expectedRecordFingerprint: bitableRecordFingerprintSchema.optional(),
    confirmation: confirmationSchema.optional(),
  })
  .strict();

export const bitableBatchModeSchema = z.enum(['atomic', 'best-effort']);
export type BitableBatchMode = z.infer<typeof bitableBatchModeSchema>;

const batchCreateInputSchema = z
  .object({
    resource: resourceAliasSchema,
    mode: bitableBatchModeSchema,
    records: z
      .array(z.object({ fields: fieldsSchema }).strict())
      .min(1)
      .max(BITABLE_MAX_BATCH_RECORDS),
  })
  .strict();

const batchUpdateInputSchema = z
  .object({
    resource: resourceAliasSchema,
    mode: bitableBatchModeSchema,
    records: z
      .array(
        z
          .object({
            recordId: recordIdSchema,
            fields: fieldsSchema,
          })
          .strict(),
      )
      .min(1)
      .max(BITABLE_MAX_BATCH_RECORDS),
    confirmation: confirmationSchema.optional(),
  })
  .strict();

const batchDeleteInputSchema = z
  .object({
    resource: resourceAliasSchema,
    mode: bitableBatchModeSchema,
    recordIds: z.array(recordIdSchema).min(1).max(BITABLE_MAX_BATCH_RECORDS),
    confirmation: confirmationSchema.optional(),
  })
  .strict();

export const FEISHU_BITABLE_INPUT_SCHEMAS = {
  'feishu.bitable.app.get': resourceInputSchema,
  'feishu.bitable.table.list': paginatedResourceInputSchema,
  'feishu.bitable.field.list': paginatedResourceInputSchema,
  'feishu.bitable.record.list': recordListInputSchema,
  'feishu.bitable.record.get': recordGetInputSchema,
  'feishu.bitable.record.create': recordCreateInputSchema,
  'feishu.bitable.record.update': recordUpdateInputSchema,
  'feishu.bitable.record.delete': recordDeleteInputSchema,
  'feishu.bitable.record.batch_create': batchCreateInputSchema,
  'feishu.bitable.record.batch_update': batchUpdateInputSchema,
  'feishu.bitable.record.batch_delete': batchDeleteInputSchema,
} as const satisfies Record<FeishuBitableOperationName, z.ZodType>;

export const bitableRecordSchema = z
  .object({
    recordId: recordIdSchema,
    fields: fieldsSchema,
    revision: z.string().optional(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .passthrough();

export const bitableUpdateDiffItemSchema = z
  .object({
    field: z.string().min(1).max(256),
    before: z.unknown(),
    after: z.unknown(),
    highImpact: z.boolean().optional(),
  })
  .strict();

/**
 * Dry-run preview generated by the Gateway after reading the current Record.
 * The Worker must render this Diff rather than calculating an alternative one.
 */
export const bitableUpdatePreviewSchema = z
  .object({
    recordId: recordIdSchema,
    diff: z.array(bitableUpdateDiffItemSchema).min(1).max(200),
    expectedRecordFingerprint: bitableRecordFingerprintSchema,
    bindingHash: sha256Schema,
    confirmationRequest: z.string().min(1).max(16_384),
    expiresAt: z.number().int().positive(),
    auditId: z.string().min(1),
    highImpactFields: z.array(z.string().min(1).max(256)).max(200).optional(),
  })
  .strict();
export type BitableUpdatePreview = z.infer<typeof bitableUpdatePreviewSchema>;

/**
 * Model-visible Update preview. The opaque confirmation request is retained
 * only inside the Runner process and never crosses the model boundary.
 */
export const bitableUpdatePreviewDisplaySchema = bitableUpdatePreviewSchema.omit({
  confirmationRequest: true,
});
export type BitableUpdatePreviewDisplay = z.infer<typeof bitableUpdatePreviewDisplaySchema>;

/** Gateway-owned, user-visible Delete preview (ADR-0075). */
export const bitableDeletePreviewSchema = z
  .object({
    recordId: recordIdSchema,
    fields: fieldsSchema.refine((fields) => Object.keys(fields).length <= 200, 'delete preview has too many fields'),
    expectedRecordFingerprint: bitableRecordFingerprintSchema,
    bindingHash: sha256Schema,
    confirmationRequest: z.string().min(1).max(16_384),
    expiresAt: z.number().int().positive(),
    auditId: z.string().min(1),
  })
  .strict();
export type BitableDeletePreview = z.infer<typeof bitableDeletePreviewSchema>;

/** Model-visible Delete preview; see bitableUpdatePreviewDisplaySchema. */
export const bitableDeletePreviewDisplaySchema = bitableDeletePreviewSchema.omit({
  confirmationRequest: true,
});
export type BitableDeletePreviewDisplay = z.infer<typeof bitableDeletePreviewDisplaySchema>;

export const bitableDeleteResultSchema = z
  .object({
    recordId: recordIdSchema,
    deleted: z.literal(true),
    verification: z
      .object({
        verified: z.literal(true),
        deleteAuditId: z.string().min(1),
        getAuditId: z.string().min(1),
      })
      .strict(),
  })
  .passthrough();

export const bitablePageSchema = <T extends z.ZodType>(itemSchema: T) =>
  z
    .object({
      items: z.array(itemSchema).max(BITABLE_MAX_PAGE_SIZE),
      hasMore: z.boolean(),
      nextCursor: cursorSchema.nullable().optional(),
    })
    .passthrough();

const appResultSchema = z
  .object({
    resource: resourceAliasSchema,
    name: z.string(),
    revision: z.string().optional(),
  })
  .passthrough();

const tableResultSchema = bitablePageSchema(
  z
    .object({
      resource: resourceAliasSchema,
      name: z.string(),
      revision: z.string().optional(),
    })
    .passthrough(),
);

export const bitableFieldSchema = z
  .object({
    name: z.string().min(1),
    type: z.string().min(1),
    required: z.boolean(),
    writable: z.boolean(),
    multiple: z.boolean().optional(),
    options: z.array(z.string()).optional(),
  })
  .passthrough();

const batchResultItemSchema = z
  .object({
    index: z.number().int().nonnegative(),
    ok: z.boolean(),
    record: bitableRecordSchema.optional(),
    recordId: recordIdSchema.optional(),
    error: gatewayErrorSchema.optional(),
  })
  .passthrough();

export const bitableBatchResultSchema = z
  .object({
    mode: bitableBatchModeSchema,
    ok: z.boolean(),
    partial: z.boolean(),
    results: z.array(batchResultItemSchema).min(1).max(BITABLE_MAX_BATCH_RECORDS),
  })
  .passthrough()
  .superRefine((value, context) => {
    value.results.forEach((item, index) => {
      if (item.index !== index) {
        context.addIssue({
          code: 'custom',
          path: ['results', index, 'index'],
          message: `batch result index must be ${index}`,
        });
      }
    });

    const anySuccess = value.results.some((item) => item.ok);
    const anyFailure = value.results.some((item) => !item.ok);
    if (value.ok !== !anyFailure) {
      context.addIssue({ code: 'custom', path: ['ok'], message: 'ok must be true only when every item succeeded' });
    }
    if (value.partial !== (anySuccess && anyFailure)) {
      context.addIssue({
        code: 'custom',
        path: ['partial'],
        message: 'partial must be true only when successful and failed items coexist',
      });
    }
    if (value.mode === 'atomic' && value.partial) {
      context.addIssue({ code: 'custom', path: ['partial'], message: 'atomic batches cannot partially commit' });
    }
  });

export const FEISHU_BITABLE_OUTPUT_SCHEMAS = {
  'feishu.bitable.app.get': appResultSchema,
  'feishu.bitable.table.list': tableResultSchema,
  'feishu.bitable.field.list': bitablePageSchema(bitableFieldSchema),
  'feishu.bitable.record.list': bitablePageSchema(bitableRecordSchema),
  'feishu.bitable.record.get': bitableRecordSchema,
  'feishu.bitable.record.create': bitableRecordSchema,
  'feishu.bitable.record.update': bitableRecordSchema,
  'feishu.bitable.record.delete': bitableDeleteResultSchema,
  'feishu.bitable.record.batch_create': bitableBatchResultSchema,
  'feishu.bitable.record.batch_update': bitableBatchResultSchema,
  'feishu.bitable.record.batch_delete': bitableBatchResultSchema,
} as const satisfies Record<FeishuBitableOperationName, z.ZodType>;

type JsonSchema = Record<string, unknown>;

const commonResourceProperty = {
  type: 'string',
  description: '运营者配置的逻辑资源别名；不得传 app_token 或 table_id。',
};
const fieldsProperty = {
  type: 'object',
  description: '按 field.list 返回的字段名提交；Gateway 会重新校验当前字段 Schema。',
  additionalProperties: true,
};
const recordIdProperty = { type: 'string', description: '飞书记录 ID；仅用于已获授权的逻辑资源。' };
const confirmationProperty = {
  type: 'string',
  description: 'Gateway 签发的短期确认凭据；绑定用户、资源、操作、Record 集合和有效期。',
};
const recordFingerprintProperty = {
  type: 'string',
  pattern: '^sha256:[a-f0-9]{64}$',
  description: 'Gateway dry-run 返回的完整记录指纹；提交 Update/Delete 时必须原样携带。',
};
const pageProperties = {
  pageSize: { type: 'integer', minimum: 1, maximum: BITABLE_MAX_PAGE_SIZE, default: BITABLE_DEFAULT_PAGE_SIZE },
  cursor: { type: 'string', description: 'Gateway 返回的不透明分页 Cursor，不是飞书 page_token。' },
};
const queryConditionProperty = objectSchema(
  {
    field: { type: 'string' },
    operator: {
      type: 'string',
      enum: ['eq', 'ne', 'isEmpty', 'isNotEmpty', 'contains', 'notContains', 'startsWith', 'gt', 'gte', 'lt', 'lte'],
    },
    value: {},
  },
  ['field', 'operator'],
);
const recordQueryProperty = objectSchema(
  {
    conjunction: { type: 'string', enum: ['and', 'or'] },
    conditions: {
      type: 'array',
      minItems: 1,
      maxItems: BITABLE_MAX_QUERY_CONDITIONS,
      items: queryConditionProperty,
    },
  },
  ['conjunction', 'conditions'],
);
const orderByProperty = {
  type: 'array',
  minItems: 1,
  maxItems: BITABLE_MAX_ORDER_BY,
  items: objectSchema(
    {
      field: { type: 'string' },
      direction: { type: 'string', enum: ['asc', 'desc'] },
    },
    ['field', 'direction'],
  ),
};

function objectSchema(properties: JsonSchema, required: string[]): JsonSchema {
  return { type: 'object', additionalProperties: false, properties, required };
}

/**
 * Discovery metadata returned by a Gateway's `/describe`.
 *
 * The executable zod schemas above remain authoritative for validation. These
 * JSON-schema-like descriptors are deliberately dependency-free so an
 * operator-owned Gateway can publish them directly.
 */
export const FEISHU_BITABLE_OPERATION_DESCRIPTORS = [
  {
    name: 'feishu.bitable.app.get',
    summary: '读取逻辑多维表格应用的元数据',
    mutating: false,
    requiredFields: ['resource'],
    schema: objectSchema({ resource: commonResourceProperty }, ['resource']),
    resultSchema: objectSchema(
      { resource: commonResourceProperty, name: { type: 'string' }, revision: { type: 'string' } },
      ['resource', 'name'],
    ),
  },
  {
    name: 'feishu.bitable.table.list',
    summary: '列出逻辑应用中已批准暴露的数据表',
    mutating: false,
    requiredFields: ['resource'],
    schema: objectSchema({ resource: commonResourceProperty, ...pageProperties }, ['resource']),
    pagination: { defaultPageSize: BITABLE_DEFAULT_PAGE_SIZE, maxPageSize: BITABLE_MAX_PAGE_SIZE, opaqueCursor: true },
  },
  {
    name: 'feishu.bitable.field.list',
    summary: '发现逻辑数据表的字段 Schema',
    mutating: false,
    requiredFields: ['resource'],
    schema: objectSchema({ resource: commonResourceProperty, ...pageProperties }, ['resource']),
    pagination: { defaultPageSize: BITABLE_DEFAULT_PAGE_SIZE, maxPageSize: BITABLE_MAX_PAGE_SIZE, opaqueCursor: true },
  },
  {
    name: 'feishu.bitable.record.list',
    summary: '按批准别名或 Schema 校验后的结构化条件分页读取记录',
    mutating: false,
    requiredFields: ['resource'],
    schema: objectSchema(
      {
        resource: commonResourceProperty,
        ...pageProperties,
        viewAlias: { type: 'string' },
        filterAlias: { type: 'string' },
        sortAlias: { type: 'string' },
        fields: { type: 'array', maxItems: 200, items: { type: 'string' } },
        query: recordQueryProperty,
        orderBy: orderByProperty,
      },
      ['resource'],
    ),
    pagination: { defaultPageSize: BITABLE_DEFAULT_PAGE_SIZE, maxPageSize: BITABLE_MAX_PAGE_SIZE, opaqueCursor: true },
  },
  {
    name: 'feishu.bitable.record.get',
    summary: '读取一条记录',
    mutating: false,
    requiredFields: ['resource', 'recordId'],
    schema: objectSchema({ resource: commonResourceProperty, recordId: recordIdProperty }, ['resource', 'recordId']),
  },
  {
    name: 'feishu.bitable.record.create',
    summary: '创建一条记录',
    mutating: true,
    approval: 'policy',
    requiredFields: ['resource', 'fields'],
    schema: objectSchema({ resource: commonResourceProperty, fields: fieldsProperty }, ['resource', 'fields']),
    idempotency: { required: true, replayReturnsFirstCommittedResult: true },
  },
  {
    name: 'feishu.bitable.record.update',
    summary: '预览或更新一条记录；所有提交都要求 Gateway 绑定的用户确认',
    mutating: true,
    approval: 'user-confirmation',
    requiredFields: ['resource', 'recordId', 'fields'],
    schema: objectSchema(
      {
        resource: commonResourceProperty,
        recordId: recordIdProperty,
        fields: fieldsProperty,
        expectedRecordFingerprint: recordFingerprintProperty,
        confirmation: confirmationProperty,
      },
      ['resource', 'recordId', 'fields'],
    ),
    idempotency: { required: true, replayReturnsFirstCommittedResult: true },
  },
  {
    name: 'feishu.bitable.record.delete',
    summary: '预览或删除一条记录；始终要求 Gateway 绑定的短期用户确认',
    mutating: true,
    approval: 'user-confirmation',
    requiredFields: ['resource', 'recordId'],
    schema: objectSchema(
      {
        resource: commonResourceProperty,
        recordId: recordIdProperty,
        expectedRecordFingerprint: recordFingerprintProperty,
        confirmation: confirmationProperty,
      },
      ['resource', 'recordId'],
    ),
    idempotency: { required: true, replayReturnsFirstCommittedResult: true },
  },
  {
    name: 'feishu.bitable.record.batch_create',
    summary: '批量创建记录',
    mutating: true,
    approval: 'policy',
    requiredFields: ['resource', 'mode', 'records'],
    schema: objectSchema(
      {
        resource: commonResourceProperty,
        mode: { type: 'string', enum: ['atomic', 'best-effort'] },
        records: {
          type: 'array',
          minItems: 1,
          maxItems: BITABLE_MAX_BATCH_RECORDS,
          items: objectSchema({ fields: fieldsProperty }, ['fields']),
        },
      },
      ['resource', 'mode', 'records'],
    ),
    batch: {
      maxRecords: BITABLE_MAX_BATCH_RECORDS,
      modes: ['atomic', 'best-effort'],
      indexAlignedResults: true,
      partialFlag: true,
    },
    idempotency: { required: true, replayReturnsFirstCommittedResult: true },
  },
  {
    name: 'feishu.bitable.record.batch_update',
    summary: '批量更新记录；命中高影响字段时要求整批确认',
    mutating: true,
    approval: 'policy-or-confirmation',
    requiredFields: ['resource', 'mode', 'records'],
    schema: objectSchema(
      {
        resource: commonResourceProperty,
        mode: { type: 'string', enum: ['atomic', 'best-effort'] },
        records: {
          type: 'array',
          minItems: 1,
          maxItems: BITABLE_MAX_BATCH_RECORDS,
          items: objectSchema({ recordId: recordIdProperty, fields: fieldsProperty }, ['recordId', 'fields']),
        },
        confirmation: confirmationProperty,
      },
      ['resource', 'mode', 'records'],
    ),
    batch: {
      maxRecords: BITABLE_MAX_BATCH_RECORDS,
      modes: ['atomic', 'best-effort'],
      indexAlignedResults: true,
      partialFlag: true,
    },
    idempotency: { required: true, replayReturnsFirstCommittedResult: true },
  },
  {
    name: 'feishu.bitable.record.batch_delete',
    summary: '批量删除记录；始终要求绑定整批 Record 集合的确认',
    mutating: true,
    approval: 'user-confirmation',
    requiredFields: ['resource', 'mode', 'recordIds'],
    schema: objectSchema(
      {
        resource: commonResourceProperty,
        mode: { type: 'string', enum: ['atomic', 'best-effort'] },
        recordIds: {
          type: 'array',
          minItems: 1,
          maxItems: BITABLE_MAX_BATCH_RECORDS,
          items: recordIdProperty,
        },
        confirmation: confirmationProperty,
      },
      ['resource', 'mode', 'recordIds'],
    ),
    batch: {
      maxRecords: BITABLE_MAX_BATCH_RECORDS,
      modes: ['atomic', 'best-effort'],
      indexAlignedResults: true,
      partialFlag: true,
    },
    idempotency: { required: true, replayReturnsFirstCommittedResult: true },
  },
] as const;

/** Safe sample inputs consumed by contract tests and Gateway fixtures. */
export const FEISHU_BITABLE_CONFORMANCE_FIXTURES: Record<FeishuBitableOperationName, Record<string, unknown>> = {
  'feishu.bitable.app.get': { resource: 'sales.pipeline' },
  'feishu.bitable.table.list': { resource: 'sales', pageSize: 20 },
  'feishu.bitable.field.list': { resource: 'sales.pipeline', pageSize: 20 },
  'feishu.bitable.record.list': {
    resource: 'sales.pipeline',
    pageSize: 20,
    fields: ['Name', 'Status'],
    query: { conjunction: 'and', conditions: [{ field: 'Status', operator: 'eq', value: 'Open' }] },
    orderBy: [{ field: 'Name', direction: 'asc' }],
  },
  'feishu.bitable.record.get': { resource: 'sales.pipeline', recordId: 'rec-conformance' },
  'feishu.bitable.record.create': { resource: 'sales.pipeline', fields: { Name: 'Conformance' } },
  'feishu.bitable.record.update': {
    resource: 'sales.pipeline',
    recordId: 'rec-conformance',
    fields: { Name: 'Updated' },
  },
  'feishu.bitable.record.delete': { resource: 'sales.pipeline', recordId: 'rec-conformance' },
  'feishu.bitable.record.batch_create': {
    resource: 'sales.pipeline',
    mode: 'best-effort',
    records: [{ fields: { Name: 'One' } }, { fields: { Name: 'Two' } }],
  },
  'feishu.bitable.record.batch_update': {
    resource: 'sales.pipeline',
    mode: 'atomic',
    records: [{ recordId: 'rec-conformance', fields: { Name: 'Updated' } }],
  },
  'feishu.bitable.record.batch_delete': {
    resource: 'sales.pipeline',
    mode: 'best-effort',
    recordIds: ['rec-conformance'],
  },
};

/** Fixtures for the security-bearing shapes that are not standalone operations. */
export const FEISHU_BITABLE_SECURE_CONTRACT_FIXTURES = {
  query: {
    conjunction: 'and',
    conditions: [
      { field: '是否已完成', operator: 'eq', value: false },
      { field: '优先级', operator: 'eq', value: 'P1' },
    ],
  },
  orderBy: [{ field: '截止日期', direction: 'asc' }],
  updateConfirmationBinding: {
    v: 2,
    requesterUserId: 'feishu:ou_alice',
    agentGroupId: 'bitable-worker',
    operation: 'feishu.bitable.record.update',
    resource: 'sales.pipeline',
    recordId: 'rec-conformance',
    patchHash: `sha256:${'a'.repeat(64)}`,
    expectedRecordFingerprint: `sha256:${'b'.repeat(64)}`,
    exp: 1_800_000_000_000,
    nonce: 'nonce-conformance',
  },
  updatePreview: {
    recordId: 'rec-conformance',
    diff: [{ field: '是否已完成', before: false, after: true, highImpact: false }],
    expectedRecordFingerprint: `sha256:${'b'.repeat(64)}`,
    bindingHash: `sha256:${'c'.repeat(64)}`,
    confirmationRequest: 'opaque-preview-request',
    expiresAt: 1_800_000_000_000,
    auditId: 'audit-preview-conformance',
    highImpactFields: [],
  },
  deleteConfirmationBinding: {
    v: 2,
    requesterUserId: 'feishu:ou_alice',
    agentGroupId: 'bitable-worker',
    operation: 'feishu.bitable.record.delete',
    resource: 'sales.pipeline',
    recordId: 'rec-conformance',
    expectedRecordFingerprint: `sha256:${'d'.repeat(64)}`,
    exp: 1_800_000_000_000,
    nonce: 'nonce-delete-conformance',
  },
  deletePreview: {
    recordId: 'rec-conformance',
    fields: { Name: 'Delete me', Status: 'Test' },
    expectedRecordFingerprint: `sha256:${'d'.repeat(64)}`,
    bindingHash: `sha256:${'e'.repeat(64)}`,
    confirmationRequest: 'opaque-delete-preview-request',
    expiresAt: 1_800_000_000_000,
    auditId: 'audit-delete-preview-conformance',
  },
} as const;

export function isFeishuBitableOperation(value: string): value is FeishuBitableOperationName {
  return (FEISHU_BITABLE_OPERATION_NAMES as readonly string[]).includes(value);
}

export function parseFeishuBitableInput(
  operation: FeishuBitableOperationName,
  input: unknown,
): Record<string, unknown> {
  return FEISHU_BITABLE_INPUT_SCHEMAS[operation].parse(input) as Record<string, unknown>;
}
