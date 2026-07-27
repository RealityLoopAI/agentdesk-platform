const LOGICAL_RESOURCE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const FEISHU_BITABLE_AUDIT_OPERATIONS = [
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
const FEISHU_BITABLE_OPERATION_SET = new Set<string>(FEISHU_BITABLE_AUDIT_OPERATIONS);

export function normalizeFeishuBitableAuditOperation(value: unknown): string | null {
  return typeof value === 'string' && FEISHU_BITABLE_OPERATION_SET.has(value) ? value : null;
}

export function validateGatewayLogicalResource(value: unknown): string | null {
  return typeof value === 'string' && LOGICAL_RESOURCE_ALIAS.test(value) ? value : null;
}

function extractFromOperation(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const operation = value as { operation?: unknown; input?: unknown };
  if (!normalizeFeishuBitableAuditOperation(operation.operation)) return null;
  if (typeof operation.input !== 'object' || operation.input === null || Array.isArray(operation.input)) return null;
  return validateGatewayLogicalResource((operation.input as { resource?: unknown }).resource);
}

/**
 * Extract a safe logical alias from a canonical Gateway request.
 *
 * A bulk request is attributed only when every operation is a Bitable
 * operation against the same alias. Mixed operations/resources deliberately
 * produce NULL rather than an ambiguous audit value.
 */
export function extractGatewayLogicalResource(body: Record<string, unknown>): string | null {
  const direct = extractFromOperation(body);
  if (direct) return direct;

  if (!Array.isArray(body.operations) || body.operations.length === 0) return null;
  const resources = body.operations.map(extractFromOperation);
  if (resources.some((resource) => resource === null)) return null;
  return new Set(resources).size === 1 ? resources[0]! : null;
}

export function validateGatewayLogicalResourceForOperation(operation: unknown, value: unknown): string | null {
  if (!normalizeFeishuBitableAuditOperation(operation)) return null;
  return validateGatewayLogicalResource(value);
}
