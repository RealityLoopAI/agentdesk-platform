const LOGICAL_RESOURCE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FEISHU_BITABLE_PREFIX = 'feishu.bitable.';

export function validateGatewayLogicalResource(value: unknown): string | null {
  return typeof value === 'string' && LOGICAL_RESOURCE_ALIAS.test(value) ? value : null;
}

function extractFromOperation(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const operation = value as { operation?: unknown; input?: unknown };
  if (typeof operation.operation !== 'string' || !operation.operation.startsWith(FEISHU_BITABLE_PREFIX)) return null;
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
  if (typeof operation !== 'string' || !operation.startsWith(FEISHU_BITABLE_PREFIX)) return null;
  return validateGatewayLogicalResource(value);
}
