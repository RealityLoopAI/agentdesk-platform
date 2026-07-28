import { createHash } from 'node:crypto';

import {
  ConversationBindingConflictError,
  ConversationLaneConflictError,
  createConversationBinding,
  createConversationLane,
  findActiveConversationBinding,
  getConversationLane,
  linkLegacyFeishuSession,
  listLegacyFeishuSessionCandidates,
  type UserScopedSessionMode,
} from './db/conversation-lanes.js';
import { getDb } from './db/connection.js';
import { recordEnterpriseAudit } from './db/enterprise-audit.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { findSessionForAgentOwner } from './db/sessions.js';
import { getUserIdentityById } from './db/user-identities.js';
import { conversationReconciliationsTotal } from './metrics.js';

export type ConversationReconciliationTrigger = 'inbound' | 'sso' | 'web' | 'operator';

export interface ConversationReconciliationResult {
  scanned: number;
  linked: number;
  existing: number;
  dryRunEligible: number;
  skippedUnauthorized: number;
  skippedMode: number;
  conflicts: number;
  hasMore: boolean;
  nextCursor: string | null;
}

function metric(trigger: ConversationReconciliationTrigger, outcome: string): void {
  try {
    conversationReconciliationsTotal.inc({ trigger, outcome });
  } catch {
    // Observability must never affect identity or message routing.
  }
}

function scopedThreadId(mode: UserScopedSessionMode, threadId: string | null): string | null {
  return mode === 'per-user' ? null : threadId;
}

function inboundLaneId(args: {
  agentGroupId: string;
  ownerUserId: string;
  messagingGroupId: string;
  threadId: string | null;
  externalIdentityId: string;
}): string {
  const digest = createHash('sha256')
    .update(
      [
        'feishu-inbound-lane',
        args.agentGroupId,
        args.ownerUserId,
        args.messagingGroupId,
        args.threadId ?? '',
        args.externalIdentityId,
      ].join('\0'),
    )
    .digest('hex')
    .slice(0, 24);
  return `lane-feishu-${digest}`;
}

/**
 * Resolve or create the exact Feishu-owned Lane for a verified inbound turn.
 *
 * Callers must invoke this only after the Host access and sender-scope gates
 * have accepted the target Agent Group. All inputs are adapter/Host structural
 * fields; message text and message history are intentionally absent.
 */
export function ensureFeishuConversationLaneForInbound(args: {
  agentGroupId: string;
  ownerUserId: string;
  messagingGroupId: string;
  platformId: string;
  threadId: string | null;
  sourceSessionMode: UserScopedSessionMode;
  externalIdentityId: string;
  actor?: string | null;
  createIfMissing?: boolean;
}): string | null {
  const identity = getUserIdentityById(args.externalIdentityId);
  if (!identity || identity.provider !== 'feishu' || identity.user_id !== args.ownerUserId) {
    metric('inbound', 'conflict');
    throw new ConversationLaneConflictError('sender_identity_mismatch');
  }
  const group = getMessagingGroup(args.messagingGroupId);
  if (
    !group ||
    group.channel_type !== 'feishu' ||
    group.platform_id !== args.platformId
  ) {
    metric('inbound', 'conflict');
    throw new ConversationLaneConflictError('messaging_group_address_mismatch');
  }

  const threadId = scopedThreadId(args.sourceSessionMode, args.threadId);
  const bound = findActiveConversationBinding({
    channelType: 'feishu',
    platformId: args.platformId,
    threadId,
    threadFallback: false,
    externalIdentityId: identity.id,
    ownerUserId: args.ownerUserId,
    agentGroupId: args.agentGroupId,
  });
  if (bound) {
    metric('inbound', 'existing');
    return bound.lane.id;
  }
  if (args.createIfMissing === false) return null;

  return getDb().transaction(() => {
    const concurrent = findActiveConversationBinding({
      channelType: 'feishu',
      platformId: args.platformId,
      threadId,
      threadFallback: false,
      externalIdentityId: identity.id,
      ownerUserId: args.ownerUserId,
      agentGroupId: args.agentGroupId,
    });
    if (concurrent) {
      metric('inbound', 'existing');
      return concurrent.lane.id;
    }

    const legacySession = findSessionForAgentOwner(
      args.agentGroupId,
      args.messagingGroupId,
      args.ownerUserId,
      threadId,
    );
    if (legacySession) {
      const lane = linkLegacyFeishuSession({
        sessionId: legacySession.id,
        sourceSessionMode: args.sourceSessionMode,
        externalIdentityId: identity.id,
        actor: args.actor ?? args.ownerUserId,
      });
      metric('inbound', 'linked');
      return lane.id;
    }

    const laneId = inboundLaneId({
      agentGroupId: args.agentGroupId,
      ownerUserId: args.ownerUserId,
      messagingGroupId: args.messagingGroupId,
      threadId,
      externalIdentityId: identity.id,
    });
    const lane =
      getConversationLane(laneId) ??
      createConversationLane({
        id: laneId,
        agentGroupId: args.agentGroupId,
        ownerUserId: args.ownerUserId,
        actor: args.actor ?? args.ownerUserId,
      });
    createConversationBinding({
      laneId: lane.id,
      channelType: 'feishu',
      messagingGroupId: args.messagingGroupId,
      platformId: args.platformId,
      threadId,
      externalIdentityId: identity.id,
      deliveryMode: 'source-reply',
      actor: args.actor ?? args.ownerUserId,
      verifiedAt: identity.verified_at,
    });
    metric('inbound', 'linked');
    return lane.id;
  })();
}

/**
 * Bounded, idempotent structural backfill for one canonical Feishu identity.
 * It creates one Lane per existing root session and never scans message data.
 */
export function reconcileFeishuConversationLanes(args: {
  userId: string;
  externalIdentityId: string;
  actor: string;
  trigger: Exclude<ConversationReconciliationTrigger, 'inbound'>;
  limit?: number;
  cursor?: string | null;
  dryRun?: boolean;
  agentGroupId?: string | null;
  authorizeAgentGroup?: (agentGroupId: string) => boolean;
  timeBudgetMs?: number;
}): ConversationReconciliationResult {
  const identity = getUserIdentityById(args.externalIdentityId);
  if (!identity || identity.provider !== 'feishu' || identity.user_id !== args.userId) {
    metric(args.trigger, 'conflict');
    throw new ConversationLaneConflictError('reconciliation_identity_mismatch');
  }
  const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
  const candidates = listLegacyFeishuSessionCandidates({
    ownerUserId: args.userId,
    afterSessionId: args.cursor,
    limit: limit + 1,
    agentGroupId: args.agentGroupId,
  });
  const hasMoreByCount = candidates.length > limit;
  const batch = candidates.slice(0, limit);
  const deadline = Date.now() + Math.min(Math.max(args.timeBudgetMs ?? 2_000, 50), 10_000);
  const result: ConversationReconciliationResult = {
    scanned: 0,
    linked: 0,
    existing: 0,
    dryRunEligible: 0,
    skippedUnauthorized: 0,
    skippedMode: 0,
    conflicts: 0,
    hasMore: hasMoreByCount,
    nextCursor: null,
  };

  for (const candidate of batch) {
    if (Date.now() >= deadline) {
      result.hasMore = true;
      break;
    }
    result.scanned += 1;
    result.nextCursor = candidate.session.id;
    if (
      candidate.configuredSessionMode !== 'per-user' &&
      candidate.configuredSessionMode !== 'per-user-per-thread'
    ) {
      result.skippedMode += 1;
      metric(args.trigger, 'skipped_mode');
      continue;
    }
    if (args.authorizeAgentGroup && !args.authorizeAgentGroup(candidate.session.agent_group_id)) {
      result.skippedUnauthorized += 1;
      metric(args.trigger, 'skipped_unauthorized');
      continue;
    }
    if (args.dryRun) {
      result.dryRunEligible += 1;
      metric(args.trigger, 'dry_run');
      continue;
    }
    const wasLinked = Boolean(candidate.session.conversation_lane_id);
    try {
      linkLegacyFeishuSession({
        sessionId: candidate.session.id,
        sourceSessionMode: candidate.configuredSessionMode,
        externalIdentityId: identity.id,
        actor: args.actor,
      });
      if (wasLinked) {
        result.existing += 1;
        metric(args.trigger, 'existing');
      } else {
        result.linked += 1;
        metric(args.trigger, 'linked');
      }
    } catch (error) {
      if (error instanceof ConversationLaneConflictError || error instanceof ConversationBindingConflictError) {
        result.conflicts += 1;
        metric(args.trigger, 'conflict');
        continue;
      }
      throw error;
    }
  }
  if (result.hasMore) metric(args.trigger, 'limit_reached');
  recordEnterpriseAudit({
    eventType: 'conversation_reconciliation_completed',
    actor: args.actor,
    details: {
      trigger: args.trigger,
      dryRun: Boolean(args.dryRun),
      scanned: result.scanned,
      linked: result.linked,
      existing: result.existing,
      dryRunEligible: result.dryRunEligible,
      skippedUnauthorized: result.skippedUnauthorized,
      skippedMode: result.skippedMode,
      conflicts: result.conflicts,
      hasMore: result.hasMore,
    },
  });
  return result;
}
