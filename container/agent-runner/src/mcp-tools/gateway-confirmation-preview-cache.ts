/**
 * Session-private cache for Gateway-owned Bitable confirmation previews.
 *
 * The opaque `confirmationRequest` is a bearer capability signed by the
 * Gateway. It must never be copied through an external model: models can
 * rewrite an otherwise parseable string and invalidate its signature. The
 * gateway tool stores the exact validated preview here, redacts the opaque
 * field before returning to the model, and the confirmation tool resolves the
 * original preview only after the model-visible fields match exactly.
 */
import { isDeepStrictEqual } from 'node:util';

import {
  bitableDeletePreviewDisplaySchema,
  bitableDeletePreviewSchema,
  bitableUpdatePreviewDisplaySchema,
  bitableUpdatePreviewSchema,
  type BitableDeletePreview,
  type BitableDeletePreviewDisplay,
  type BitableUpdatePreview,
  type BitableUpdatePreviewDisplay,
} from './feishu-bitable-contract.js';

export type BitableConfirmationKind = 'update' | 'delete';
export type BitableConfirmationPreview = BitableUpdatePreview | BitableDeletePreview;
export type BitableConfirmationPreviewDisplay = BitableUpdatePreviewDisplay | BitableDeletePreviewDisplay;

const MAX_CACHED_PREVIEWS = 32;
const previews = new Map<string, BitableConfirmationPreview>();

function key(kind: BitableConfirmationKind, bindingHash: string): string {
  return `${kind}:${bindingHash}`;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function prune(now = Date.now()): void {
  for (const [cacheKey, preview] of previews) {
    if (preview.expiresAt <= now) previews.delete(cacheKey);
  }
  while (previews.size >= MAX_CACHED_PREVIEWS) {
    const oldest = previews.keys().next().value as string | undefined;
    if (!oldest) break;
    previews.delete(oldest);
  }
}

function displayPreview(
  kind: BitableConfirmationKind,
  preview: BitableConfirmationPreview,
): BitableConfirmationPreviewDisplay {
  const { confirmationRequest: _opaque, ...display } = preview;
  return kind === 'update'
    ? bitableUpdatePreviewDisplaySchema.parse(display)
    : bitableDeletePreviewDisplaySchema.parse(display);
}

/**
 * Validate and remember the exact Gateway response. Returns the redacted
 * preview that is safe to expose to the model.
 */
export function rememberGatewayConfirmationPreview(
  kind: BitableConfirmationKind,
  value: unknown,
): BitableConfirmationPreviewDisplay | null {
  const parsed =
    kind === 'update' ? bitableUpdatePreviewSchema.safeParse(value) : bitableDeletePreviewSchema.safeParse(value);
  if (!parsed.success || parsed.data.expiresAt <= Date.now()) return null;
  prune();
  previews.set(key(kind, parsed.data.bindingHash), clone(parsed.data));
  return clone(displayPreview(kind, parsed.data));
}

/**
 * Resolve the exact cached Gateway preview after checking every model-visible
 * field. A missing, expired, or altered preview fails closed.
 */
export function resolveGatewayConfirmationPreview(
  kind: BitableConfirmationKind,
  value: unknown,
): BitableConfirmationPreview | null {
  prune();
  const parsed =
    kind === 'update'
      ? bitableUpdatePreviewDisplaySchema.safeParse(value)
      : bitableDeletePreviewDisplaySchema.safeParse(value);
  if (!parsed.success) return null;
  const cached = previews.get(key(kind, parsed.data.bindingHash));
  if (!cached || cached.expiresAt <= Date.now()) return null;
  if (!isDeepStrictEqual(displayPreview(kind, cached), parsed.data)) return null;
  return clone(cached);
}

/** Test isolation only; runtime callers should let TTL/size pruning manage entries. */
export function clearGatewayConfirmationPreviewCache(): void {
  previews.clear();
}
