import { createHash, randomUUID } from 'node:crypto';

import type { ConversationBinding, ConversationDeliveryMode, ConversationLane, Session } from '../types.js';
import { getDb } from './connection.js';
import { recordEnterpriseAudit } from './enterprise-audit.js';
import { getMessagingGroup } from './messaging-groups.js';
import { createSession, getSession } from './sessions.js';
import { getUserIdentityById } from './user-identities.js';

export type UserScopedSessionMode = 'per-user' | 'per-user-per-thread';
export type AnySessionMode = 'shared' | 'per-thread' | 'agent-shared' | UserScopedSessionMode;

export class ConversationLaneConflictError extends Error {
  constructor(readonly reason: string) {
    super(`Conversation lane operation rejected: ${reason}`);
    this.name = 'ConversationLaneConflictError';
  }
}

export class ConversationBindingConflictError extends Error {
  constructor() {
    super('The verified channel address is already bound to another active conversation lane');
    this.name = 'ConversationBindingConflictError';
  }
}

function requireText(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function isUserScopedMode(mode: AnySessionMode): mode is UserScopedSessionMode {
  return mode === 'per-user' || mode === 'per-user-per-thread';
}

export function getConversationLane(id: string): ConversationLane | undefined {
  return getDb().prepare('SELECT * FROM conversation_lanes WHERE id = ?').get(id) as ConversationLane | undefined;
}

export function listConversationLanesForUser(userId: string): ConversationLane[] {
  return getDb()
    .prepare(
      `SELECT * FROM conversation_lanes
       WHERE owner_user_id = ?
       ORDER BY status = 'active' DESC, created_at DESC, id DESC`,
    )
    .all(userId) as ConversationLane[];
}

export function createConversationLane(args: {
  agentGroupId: string;
  ownerUserId: string;
  id?: string;
  actor?: string | null;
  createdAt?: string;
}): ConversationLane {
  const now = args.createdAt ?? new Date().toISOString();
  const lane: ConversationLane = {
    id: args.id ?? `lane-${randomUUID()}`,
    agent_group_id: requireText('agentGroupId', args.agentGroupId),
    owner_user_id: requireText('ownerUserId', args.ownerUserId),
    root_session_id: null,
    status: 'active',
    created_at: now,
    archived_at: null,
  };
  getDb().transaction(() => {
    getDb()
      .prepare(
        `INSERT INTO conversation_lanes
           (id, agent_group_id, owner_user_id, root_session_id, status, created_at, archived_at)
         VALUES
           (@id, @agent_group_id, @owner_user_id, @root_session_id, @status, @created_at, @archived_at)`,
      )
      .run(lane);
    recordEnterpriseAudit({
      eventType: 'conversation_lane_created',
      agentGroupId: lane.agent_group_id,
      actor: args.actor ?? lane.owner_user_id,
      details: { laneId: lane.id, ownerUserId: lane.owner_user_id },
    });
  })();
  return lane;
}

export function linkSessionToConversationLane(args: {
  laneId: string;
  sessionId: string;
  sourceSessionMode: AnySessionMode;
  actor?: string | null;
}): ConversationLane {
  if (!isUserScopedMode(args.sourceSessionMode)) {
    throw new ConversationLaneConflictError('shared_session_mode');
  }
  const db = getDb();
  return db.transaction(() => {
    const lane = getConversationLane(args.laneId);
    const session = getSession(args.sessionId);
    if (!lane || lane.status !== 'active') {
      throw new ConversationLaneConflictError('lane_unavailable');
    }
    if (!session || session.status !== 'active') {
      throw new ConversationLaneConflictError('session_unavailable');
    }
    if (session.root_session_id && session.root_session_id !== session.id) {
      throw new ConversationLaneConflictError('worker_session');
    }
    if (session.owner_user_id !== lane.owner_user_id) {
      throw new ConversationLaneConflictError('owner_mismatch');
    }
    if (session.agent_group_id !== lane.agent_group_id) {
      throw new ConversationLaneConflictError('agent_group_mismatch');
    }
    if (session.conversation_lane_id && session.conversation_lane_id !== lane.id) {
      throw new ConversationLaneConflictError('session_already_linked');
    }
    if (lane.root_session_id && lane.root_session_id !== session.id) {
      throw new ConversationLaneConflictError('lane_already_has_root');
    }

    db.prepare('UPDATE sessions SET conversation_lane_id = ? WHERE id = ?').run(lane.id, session.id);
    db.prepare('UPDATE conversation_lanes SET root_session_id = ? WHERE id = ?').run(session.id, lane.id);
    if (!lane.root_session_id || !session.conversation_lane_id) {
      recordEnterpriseAudit({
        eventType: 'conversation_lane_session_linked',
        agentGroupId: lane.agent_group_id,
        actor: args.actor ?? lane.owner_user_id,
        details: {
          laneId: lane.id,
          sessionId: session.id,
          ownerUserId: lane.owner_user_id,
          sourceSessionMode: args.sourceSessionMode,
        },
      });
    }
    return { ...lane, root_session_id: session.id };
  })();
}

/**
 * Atomically create and attach a new Lane root in the Host-owned central DB.
 * Session folders are provisioned only after this transaction commits.
 */
export function createConversationLaneRootSession(args: {
  laneId: string;
  session: Session;
  sourceSessionMode: UserScopedSessionMode;
  actor?: string | null;
}): ConversationLane {
  return getDb().transaction(() => {
    createSession(args.session);
    return linkSessionToConversationLane({
      laneId: args.laneId,
      sessionId: args.session.id,
      sourceSessionMode: args.sourceSessionMode,
      actor: args.actor,
    });
  })();
}

export function getConversationBinding(id: string): ConversationBinding | undefined {
  return getDb().prepare('SELECT * FROM conversation_bindings WHERE id = ?').get(id) as ConversationBinding | undefined;
}

export function listConversationBindings(laneId: string): ConversationBinding[] {
  return getDb()
    .prepare(
      `SELECT * FROM conversation_bindings
       WHERE lane_id = ?
       ORDER BY revoked_at IS NULL DESC, verified_at, id`,
    )
    .all(laneId) as ConversationBinding[];
}

function validateBindingOwnership(lane: ConversationLane, externalIdentityId: string | null): void {
  if (!externalIdentityId) return;
  const identity = getUserIdentityById(externalIdentityId);
  if (!identity || identity.user_id !== lane.owner_user_id) {
    throw new ConversationLaneConflictError('external_identity_owner_mismatch');
  }
}

export function createConversationBinding(args: {
  laneId: string;
  channelType: string;
  messagingGroupId?: string | null;
  platformId: string;
  threadId?: string | null;
  externalIdentityId?: string | null;
  deliveryMode: ConversationDeliveryMode;
  actor?: string | null;
  verifiedAt?: string;
}): ConversationBinding {
  const lane = getConversationLane(args.laneId);
  if (!lane || lane.status !== 'active') {
    throw new ConversationLaneConflictError('lane_unavailable');
  }
  const channelType = requireText('channelType', args.channelType);
  const platformId = requireText('platformId', args.platformId);
  const messagingGroupId = args.messagingGroupId ?? null;
  const threadId = args.threadId?.trim() || null;
  const externalIdentityId = args.externalIdentityId ?? null;
  validateBindingOwnership(lane, externalIdentityId);

  if (messagingGroupId) {
    const group = getMessagingGroup(messagingGroupId);
    if (!group || group.channel_type !== channelType || group.platform_id !== platformId) {
      throw new ConversationLaneConflictError('messaging_group_address_mismatch');
    }
  }
  if (
    args.deliveryMode === 'mirror-dm' &&
    (channelType !== 'feishu' || !/^feishu:p2p:ou_/.test(platformId) || !externalIdentityId)
  ) {
    throw new ConversationLaneConflictError('unsafe_mirror_destination');
  }

  const binding: ConversationBinding = {
    id: `binding-${randomUUID()}`,
    lane_id: lane.id,
    channel_type: channelType,
    messaging_group_id: messagingGroupId,
    platform_id: platformId,
    thread_id: threadId,
    external_identity_id: externalIdentityId,
    delivery_mode: args.deliveryMode,
    verified_at: args.verifiedAt ?? new Date().toISOString(),
    revoked_at: null,
  };
  try {
    getDb().transaction(() => {
      getDb()
        .prepare(
          `INSERT INTO conversation_bindings
             (id, lane_id, channel_type, messaging_group_id, platform_id, thread_id,
              external_identity_id, delivery_mode, verified_at, revoked_at)
           VALUES
             (@id, @lane_id, @channel_type, @messaging_group_id, @platform_id, @thread_id,
              @external_identity_id, @delivery_mode, @verified_at, @revoked_at)`,
        )
        .run(binding);
      recordEnterpriseAudit({
        eventType: 'conversation_binding_created',
        agentGroupId: lane.agent_group_id,
        messagingGroupId,
        actor: args.actor ?? lane.owner_user_id,
        details: {
          bindingId: binding.id,
          laneId: lane.id,
          channelType,
          deliveryMode: binding.delivery_mode,
          hasThread: Boolean(threadId),
          hasExternalIdentity: Boolean(externalIdentityId),
        },
      });
    })();
  } catch (error) {
    if (error instanceof ConversationLaneConflictError) throw error;
    if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
      throw new ConversationBindingConflictError();
    }
    throw error;
  }
  return binding;
}

export function revokeConversationBinding(args: {
  bindingId: string;
  actor: string;
  reason: string;
  revokedAt?: string;
}): boolean {
  if (!args.actor.trim() || !args.reason.trim()) {
    throw new Error('Binding revocation requires an actor and reason');
  }
  const binding = getConversationBinding(args.bindingId);
  if (!binding) return false;
  const lane = getConversationLane(binding.lane_id);
  const revokedAt = args.revokedAt ?? new Date().toISOString();
  const result = getDb()
    .prepare('UPDATE conversation_bindings SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(revokedAt, binding.id);
  if (result.changes > 0) {
    recordEnterpriseAudit({
      eventType: 'conversation_binding_revoked',
      agentGroupId: lane?.agent_group_id ?? null,
      messagingGroupId: binding.messaging_group_id,
      actor: args.actor,
      details: { bindingId: binding.id, laneId: binding.lane_id, reason: args.reason },
    });
  }
  return result.changes > 0;
}

export function findActiveConversationBinding(args: {
  channelType: string;
  platformId: string;
  threadId?: string | null;
  externalIdentityId?: string | null;
  ownerUserId: string;
  agentGroupId: string;
}): { binding: ConversationBinding; lane: ConversationLane } | undefined {
  const db = getDb();
  const identityClause = args.externalIdentityId
    ? 'b.external_identity_id = @externalIdentityId'
    : 'b.external_identity_id IS NULL';
  const base = `
    SELECT
      b.id AS b_id, b.lane_id AS b_lane_id, b.channel_type AS b_channel_type,
      b.messaging_group_id AS b_messaging_group_id, b.platform_id AS b_platform_id,
      b.thread_id AS b_thread_id, b.external_identity_id AS b_external_identity_id,
      b.delivery_mode AS b_delivery_mode, b.verified_at AS b_verified_at,
      b.revoked_at AS b_revoked_at,
      l.id AS l_id, l.agent_group_id AS l_agent_group_id,
      l.owner_user_id AS l_owner_user_id, l.root_session_id AS l_root_session_id,
      l.status AS l_status, l.created_at AS l_created_at, l.archived_at AS l_archived_at
    FROM conversation_bindings b
    JOIN conversation_lanes l ON l.id = b.lane_id
    WHERE b.channel_type = @channelType AND b.platform_id = @platformId
      AND ${identityClause}
      AND b.revoked_at IS NULL AND l.status = 'active'
      AND l.owner_user_id = @ownerUserId AND l.agent_group_id = @agentGroupId`;
  const params = {
    channelType: args.channelType,
    platformId: args.platformId,
    externalIdentityId: args.externalIdentityId ?? null,
    ownerUserId: args.ownerUserId,
    agentGroupId: args.agentGroupId,
  };
  type Joined = Record<string, string | null>;
  let row: Joined | undefined;
  if (args.threadId) {
    row = db.prepare(`${base} AND b.thread_id = @threadId LIMIT 1`).get({
      ...params,
      threadId: args.threadId,
    }) as Joined | undefined;
  }
  row ??= db.prepare(`${base} AND b.thread_id IS NULL LIMIT 1`).get(params) as Joined | undefined;
  if (!row) return undefined;
  return {
    binding: {
      id: row.b_id!,
      lane_id: row.b_lane_id!,
      channel_type: row.b_channel_type!,
      messaging_group_id: row.b_messaging_group_id,
      platform_id: row.b_platform_id!,
      thread_id: row.b_thread_id,
      external_identity_id: row.b_external_identity_id,
      delivery_mode: row.b_delivery_mode as ConversationDeliveryMode,
      verified_at: row.b_verified_at!,
      revoked_at: row.b_revoked_at,
    },
    lane: {
      id: row.l_id!,
      agent_group_id: row.l_agent_group_id!,
      owner_user_id: row.l_owner_user_id!,
      root_session_id: row.l_root_session_id,
      status: row.l_status as ConversationLane['status'],
      created_at: row.l_created_at!,
      archived_at: row.l_archived_at,
    },
  };
}

export function archiveConversationLane(args: {
  laneId: string;
  actor: string;
  reason: string;
  archivedAt?: string;
}): boolean {
  if (!args.actor.trim() || !args.reason.trim()) {
    throw new Error('Lane archival requires an actor and reason');
  }
  const db = getDb();
  return db.transaction(() => {
    const lane = getConversationLane(args.laneId);
    if (!lane || lane.status === 'archived') return false;
    const archivedAt = args.archivedAt ?? new Date().toISOString();
    db.prepare("UPDATE conversation_lanes SET status = 'archived', archived_at = ? WHERE id = ?").run(
      archivedAt,
      lane.id,
    );
    db.prepare('UPDATE conversation_bindings SET revoked_at = ? WHERE lane_id = ? AND revoked_at IS NULL').run(
      archivedAt,
      lane.id,
    );
    recordEnterpriseAudit({
      eventType: 'conversation_lane_archived',
      agentGroupId: lane.agent_group_id,
      actor: args.actor,
      details: { laneId: lane.id, ownerUserId: lane.owner_user_id, reason: args.reason },
    });
    return true;
  })();
}

/**
 * Explicit, deterministic compatibility bridge for a verified legacy Feishu
 * user-scoped session. It never scans or merges histories: the operator must
 * provide the exact session and verified identity.
 */
export function linkLegacyFeishuSession(args: {
  sessionId: string;
  sourceSessionMode: UserScopedSessionMode;
  externalIdentityId: string;
  actor: string;
}): ConversationLane {
  const session = getSession(args.sessionId);
  if (!session?.owner_user_id || !session.messaging_group_id) {
    throw new ConversationLaneConflictError('legacy_session_not_user_scoped');
  }
  if (session.conversation_lane_id) {
    const existing = getConversationLane(session.conversation_lane_id);
    if (!existing) throw new ConversationLaneConflictError('linked_lane_missing');
    return existing;
  }
  const identity = getUserIdentityById(args.externalIdentityId);
  if (!identity || identity.provider !== 'feishu' || identity.user_id !== session.owner_user_id) {
    throw new ConversationLaneConflictError('legacy_identity_mismatch');
  }
  const group = getMessagingGroup(session.messaging_group_id);
  if (!group || group.channel_type !== 'feishu') {
    throw new ConversationLaneConflictError('legacy_channel_not_feishu');
  }
  const digest = createHash('sha256').update(`legacy-lane\0${session.id}`).digest('hex').slice(0, 24);
  const laneId = `lane-legacy-${digest}`;
  return getDb().transaction(() => {
    const lane =
      getConversationLane(laneId) ??
      createConversationLane({
        id: laneId,
        agentGroupId: session.agent_group_id,
        ownerUserId: session.owner_user_id!,
        actor: args.actor,
        createdAt: session.created_at,
      });
    const linked = linkSessionToConversationLane({
      laneId: lane.id,
      sessionId: session.id,
      sourceSessionMode: args.sourceSessionMode,
      actor: args.actor,
    });
    createConversationBinding({
      laneId: lane.id,
      channelType: group.channel_type,
      messagingGroupId: group.id,
      platformId: group.platform_id,
      threadId: session.thread_id,
      externalIdentityId: identity.id,
      deliveryMode: 'source-reply',
      actor: args.actor,
      verifiedAt: identity.verified_at,
    });
    return linked;
  })();
}

export function sessionForConversationLane(lane: ConversationLane): Session | undefined {
  return lane.root_session_id ? getSession(lane.root_session_id) : undefined;
}
