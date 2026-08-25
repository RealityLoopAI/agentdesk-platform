import { describe, expect, it } from 'vitest';

import {
  extractGatewayLogicalResource,
  validateGatewayLogicalResource,
  validateGatewayLogicalResourceForOperation,
} from './gateway-audit-resource.js';

describe('gateway audit logical resource', () => {
  it('extracts a bounded logical alias from one Bitable operation', () => {
    expect(
      extractGatewayLogicalResource({
        operation: 'feishu.bitable.record.list',
        input: { resource: 'sales.orders' },
      }),
    ).toBe('sales.orders');
  });

  it('attributes a bulk call only when every item targets the same alias', () => {
    const operation = (resource: string) => ({
      operation: 'feishu.bitable.record.update',
      input: { resource },
    });
    expect(extractGatewayLogicalResource({ operations: [operation('orders'), operation('orders')] })).toBe('orders');
    expect(extractGatewayLogicalResource({ operations: [operation('orders'), operation('customers')] })).toBeNull();
    expect(
      extractGatewayLogicalResource({
        operations: [operation('orders'), { operation: 'sales.order.update', input: { resource: 'orders' } }],
      }),
    ).toBeNull();
  });

  it('rejects unbounded, malformed and non-Bitable resource values', () => {
    expect(validateGatewayLogicalResource('ok_alias:1')).toBe('ok_alias:1');
    expect(validateGatewayLogicalResource('../raw/app/token')).toBeNull();
    expect(validateGatewayLogicalResource('x'.repeat(129))).toBeNull();
    expect(validateGatewayLogicalResourceForOperation('sales.order.read', 'orders')).toBeNull();
  });
});
