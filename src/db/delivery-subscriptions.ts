import { createHash, randomUUID } from 'node:crypto';

import { getDb } from './connection.js';
import { getConversationLane } from './conversation-lanes.js';
import { recordEnterpriseAudit } from './enterprise-audit.js';
import { crossChannelLoopSuppressedTotal } from '../metrics.js';
import { getUserIdentityById } from './user-identities.js';

const FEISHU_OPEN_ID = /^ou_[A-Za-z0-9_-]+$/;

export interface DeliverySubscription {
  id: string;
  lane_id: string;
  channel_type: 'feishu';
  delivery_kind: 'agent-reply-mirror';
  platform_id: string;
  external_identity_id: string;
  provider_scope: string;
  enabled_at: string;
  revoked_at: string | null;
}

export type CrossChannelDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'suppressed';

export interface CrossChannelDelivery {
  id: string;
  origin_id: string;
  subscription_id: string;
  lane_id: string;
  session_id: string;
  message_out_id: string;
  channel_type: 'feishu';
  platform_id: string;
  status: CrossChannelDeliveryStatus;
  attempts: number;
  next_retry_at: string | null;
  platform_message_id: string | null;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
  delivered_at: string | null;
}

export class DeliverySubscriptionError extends Error {
  constructor(readonly reason: string) {
    super(`Delivery subscription rejected: ${reason}`);
    this.name = 'DeliverySubscriptionError';
  }
}

function stableId(prefix: 'xco' | 'xcd', parts: string[]): string {
  return `${prefix}-${createHash('sha256').update(parts.join('\u001f')).digest('base64url')}`;
}

function verifiedFeishuOpenId(userId: string, providerScope: string) {
  return getDb()
    .prepare(
      `SELECT * FROM user_identities
       WHERE user_id = ?
         AND provider = 'feishu'
         AND provider_scope = ?
         AND identifier_type = 'open_id'
       ORDER BY verified_at DESC, id
       LIMIT 1`,
    )
    .get(userId, providerScope) as
    | {
        id: string;
        user_id: string;
        provider: string;
        provider_scope: string;
        identifier_type: string;
        external_subject: string;
      }
    | undefined;
}

export function getActiveDeliverySubscription(laneId: string): DeliverySubscription | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM delivery_subscriptions
       WHERE lane_id = ?
         AND channel_type = 'feishu'
         AND delivery_kind = 'agent-reply-mirror'
         AND revoked_at IS NULL
       LIMIT 1`,
    )
    .get(laneId) as DeliverySubscription | undefined;
}

export function listActiveDeliverySubscriptions(laneId: string): DeliverySubscription[] {
  return getDb()
    .prepare(
      `SELECT s.*
       FROM delivery_subscriptions s
       JOIN conversation_lanes l ON l.id = s.lane_id
       JOIN user_identities i ON i.id = s.external_identity_id
       WHERE s.lane_id = ?
         AND s.revoked_at IS NULL
         AND s.channel_type = 'feishu'
         AND s.delivery_kind = 'agent-reply-mirror'
         AND l.status = 'active'
         AND i.user_id = l.owner_user_id
         AND i.provider = 'feishu'
         AND i.provider_scope = s.provider_scope
         AND i.identifier_type = 'open_id'
       ORDER BY s.enabled_at, s.id`,
    )
    .all(laneId) as DeliverySubscription[];
}

export function getFeishuDeliverySubscriptionState(args: { userId: string; laneId: string; providerScope: string }): {
  enabled: boolean;
  available: boolean;
  subscriptionId: string | null;
} {
  const lane = getConversationLane(args.laneId);
  if (!lane || lane.owner_user_id !== args.userId) {
    throw new DeliverySubscriptionError('lane_owner_mismatch');
  }
  const identity = verifiedFeishuOpenId(args.userId, args.providerScope);
  const active = getActiveDeliverySubscription(lane.id);
  return {
    enabled: Boolean(active && identity && active.external_identity_id === identity.id),
    available: Boolean(identity && FEISHU_OPEN_ID.test(identity.external_subject)),
    subscriptionId: active?.id ?? null,
  };
}

export function enableFeishuDeliverySubscription(args: {
  userId: string;
  laneId: string;
  providerScope: string;
  enabledAt?: string;
}): DeliverySubscription {
  const db = getDb();
  return db.transaction(() => {
    const lane = getConversationLane(args.laneId);
    if (!lane || lane.status !== 'active' || lane.owner_user_id !== args.userId) {
      throw new DeliverySubscriptionError('lane_unavailable');
    }
    const identity = verifiedFeishuOpenId(args.userId, args.providerScope);
    if (!identity || !FEISHU_OPEN_ID.test(identity.external_subject)) {
      throw new DeliverySubscriptionError('verified_feishu_open_id_required');
    }
    const existing = getActiveDeliverySubscription(lane.id);
    if (existing) {
      if (
        existing.external_identity_id !== identity.id ||
        existing.provider_scope !== identity.provider_scope ||
        existing.platform_id !== `feishu:p2p:${identity.external_subject}`
      ) {
        throw new DeliverySubscriptionError('active_subscription_conflict');
      }
      return existing;
    }

    const enabledAt = args.enabledAt ?? new Date().toISOString();
    const row: DeliverySubscription = {
      id: `delivery-sub-${randomUUID()}`,
      lane_id: lane.id,
      channel_type: 'feishu',
      delivery_kind: 'agent-reply-mirror',
      platform_id: `feishu:p2p:${identity.external_subject}`,
      external_identity_id: identity.id,
      provider_scope: identity.provider_scope,
      enabled_at: enabledAt,
      revoked_at: null,
    };
    db.prepare(
      `INSERT INTO delivery_subscriptions
         (id, lane_id, channel_type, delivery_kind, platform_id,
          external_identity_id, provider_scope, enabled_at, revoked_at)
       VALUES
         (@id, @lane_id, @channel_type, @delivery_kind, @platform_id,
          @external_identity_id, @provider_scope, @enabled_at, @revoked_at)`,
    ).run(row);
    recordEnterpriseAudit({
      eventType: 'delivery_subscription_enabled',
      agentGroupId: lane.agent_group_id,
      actor: args.userId,
      details: {
        subscriptionId: row.id,
        laneId: row.lane_id,
        channelType: row.channel_type,
        deliveryKind: row.delivery_kind,
        externalIdentityId: row.external_identity_id,
      },
    });
    return row;
  })();
}

export function disableFeishuDeliverySubscription(args: {
  userId: string;
  laneId: string;
  revokedAt?: string;
}): boolean {
  const db = getDb();
  return db.transaction(() => {
    const lane = getConversationLane(args.laneId);
    if (!lane || lane.owner_user_id !== args.userId) {
      throw new DeliverySubscriptionError('lane_unavailable');
    }
    const active = getActiveDeliverySubscription(lane.id);
    if (!active) return false;
    const revokedAt = args.revokedAt ?? new Date().toISOString();
    const changed = db
      .prepare('UPDATE delivery_subscriptions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(revokedAt, active.id).changes;
    if (changed > 0) {
      recordEnterpriseAudit({
        eventType: 'delivery_subscription_disabled',
        agentGroupId: lane.agent_group_id,
        actor: args.userId,
        details: {
          subscriptionId: active.id,
          laneId: lane.id,
          channelType: active.channel_type,
          deliveryKind: active.delivery_kind,
        },
      });
    }
    return changed > 0;
  })();
}

export function reserveCrossChannelDelivery(args: {
  subscription: DeliverySubscription;
  laneId: string;
  sessionId: string;
  messageOutId: string;
  createdAt?: string;
}): CrossChannelDelivery {
  if (args.subscription.lane_id !== args.laneId || args.subscription.revoked_at !== null) {
    throw new DeliverySubscriptionError('subscription_unavailable');
  }
  const originId = stableId('xco', [args.sessionId, args.messageOutId]);
  const id = stableId('xcd', [originId, args.subscription.id]);
  const now = args.createdAt ?? new Date().toISOString();
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO cross_channel_deliveries
         (id, origin_id, subscription_id, lane_id, session_id, message_out_id,
          channel_type, platform_id, status, attempts, next_retry_at,
          platform_message_id, failure_code, created_at, updated_at, delivered_at)
       VALUES
         (?, ?, ?, ?, ?, ?, 'feishu', ?, 'pending', 0, NULL, NULL, NULL, ?, ?, NULL)`,
    )
    .run(
      id,
      originId,
      args.subscription.id,
      args.laneId,
      args.sessionId,
      args.messageOutId,
      args.subscription.platform_id,
      now,
      now,
    );
  return getCrossChannelDelivery(id)!;
}

export function getCrossChannelDelivery(id: string): CrossChannelDelivery | undefined {
  return getDb().prepare('SELECT * FROM cross_channel_deliveries WHERE id = ?').get(id) as
    | CrossChannelDelivery
    | undefined;
}

export function listDueCrossChannelDeliveries(
  sessionId: string,
  now: string = new Date().toISOString(),
): CrossChannelDelivery[] {
  return getDb()
    .prepare(
      `SELECT * FROM cross_channel_deliveries
       WHERE session_id = ?
         AND status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY created_at, id`,
    )
    .all(sessionId, now) as CrossChannelDelivery[];
}

export function markCrossChannelDeliveryDelivered(
  id: string,
  platformMessageId: string | null,
  deliveredAt: string = new Date().toISOString(),
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE cross_channel_deliveries
         SET status = 'delivered', attempts = attempts + 1,
             next_retry_at = NULL, platform_message_id = ?,
             failure_code = NULL, updated_at = ?, delivered_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(platformMessageId, deliveredAt, deliveredAt, id).changes > 0
  );
}

export function markCrossChannelDeliveryRetry(args: {
  id: string;
  nextRetryAt: string | null;
  permanent: boolean;
  failureCode: string;
  updatedAt?: string;
}): boolean {
  const updatedAt = args.updatedAt ?? new Date().toISOString();
  return (
    getDb()
      .prepare(
        `UPDATE cross_channel_deliveries
         SET status = ?, attempts = attempts + 1,
             next_retry_at = ?, failure_code = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(args.permanent ? 'failed' : 'pending', args.nextRetryAt, args.failureCode, updatedAt, args.id).changes > 0
  );
}

export function suppressCrossChannelDelivery(args: {
  id: string;
  reason: string;
  actor?: string | null;
  suppressedAt?: string;
}): boolean {
  const row = getCrossChannelDelivery(args.id);
  if (!row) return false;
  const suppressedAt = args.suppressedAt ?? new Date().toISOString();
  const changed = getDb()
    .prepare(
      `UPDATE cross_channel_deliveries
       SET status = 'suppressed', next_retry_at = NULL,
           failure_code = ?, updated_at = ?
       WHERE id = ? AND status = 'pending'`,
    )
    .run(args.reason, suppressedAt, row.id).changes;
  if (changed > 0) {
    const lane = getConversationLane(row.lane_id);
    recordEnterpriseAudit({
      eventType: 'cross_channel_delivery_suppressed',
      agentGroupId: lane?.agent_group_id ?? null,
      actor: args.actor ?? lane?.owner_user_id ?? null,
      details: {
        deliveryId: row.id,
        originId: row.origin_id,
        subscriptionId: row.subscription_id,
        laneId: row.lane_id,
        reason: args.reason,
      },
    });
    const metricReason = new Set([
      'source_message_unavailable',
      'source_route_untrusted',
      'source_not_eligible',
      'subscription_unavailable',
    ]).has(args.reason)
      ? args.reason
      : 'other';
    try {
      crossChannelLoopSuppressedTotal.labels(metricReason).inc();
    } catch {
      // Metrics are best-effort and never affect persisted suppression.
    }
  }
  return changed > 0;
}

export function validateCrossChannelDeliveryTarget(delivery: CrossChannelDelivery): DeliverySubscription | undefined {
  const subscription = getActiveDeliverySubscription(delivery.lane_id);
  if (
    !subscription ||
    subscription.id !== delivery.subscription_id ||
    subscription.platform_id !== delivery.platform_id
  ) {
    return undefined;
  }
  const lane = getConversationLane(delivery.lane_id);
  const identity = getUserIdentityById(subscription.external_identity_id);
  if (
    !lane ||
    lane.status !== 'active' ||
    lane.root_session_id !== delivery.session_id ||
    !identity ||
    identity.user_id !== lane.owner_user_id ||
    identity.provider !== 'feishu' ||
    identity.provider_scope !== subscription.provider_scope ||
    identity.identifier_type !== 'open_id' ||
    !FEISHU_OPEN_ID.test(identity.external_subject) ||
    delivery.platform_id !== `feishu:p2p:${identity.external_subject}`
  ) {
    return undefined;
  }
  return subscription;
}
