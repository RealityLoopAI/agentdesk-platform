import { getDb } from './connection.js';
import type { PendingGatewayConfirmation } from '../types.js';

export interface CreatePendingGatewayConfirmation {
  confirmationId: string;
  sessionId: string;
  messageOutId: string;
  kind: PendingGatewayConfirmation['kind'];
  requesterUserId: string;
  agentGroupId: string;
  conversationLaneId: string | null;
  channelType: string;
  platformId: string;
  threadId: string | null;
  confirmationRequest: string | null;
  displayJson: string;
  title: string;
  optionsJson: string;
  createdAt: string;
  expiresAt: string;
}

export function createPendingGatewayConfirmation(args: CreatePendingGatewayConfirmation): boolean {
  return (
    getDb()
      .prepare(
        `INSERT OR IGNORE INTO pending_gateway_confirmations
           (confirmation_id, session_id, message_out_id, kind, requester_user_id,
            agent_group_id, conversation_lane_id, channel_type, platform_id,
            thread_id, confirmation_request, display_json, title, options_json,
            created_at, expires_at, status)
         VALUES
           (@confirmationId, @sessionId, @messageOutId, @kind, @requesterUserId,
            @agentGroupId, @conversationLaneId, @channelType, @platformId,
            @threadId, @confirmationRequest, @displayJson, @title, @optionsJson,
            @createdAt, @expiresAt, 'pending')`,
      )
      .run(args).changes > 0
  );
}

export function getPendingGatewayConfirmation(id: string): PendingGatewayConfirmation | undefined {
  return getDb().prepare('SELECT * FROM pending_gateway_confirmations WHERE confirmation_id = ?').get(id) as
    | PendingGatewayConfirmation
    | undefined;
}

export function getGatewayConfirmationByMessageOutId(messageOutId: string): PendingGatewayConfirmation | undefined {
  return getDb().prepare('SELECT * FROM pending_gateway_confirmations WHERE message_out_id = ?').get(messageOutId) as
    | PendingGatewayConfirmation
    | undefined;
}

export type ClaimGatewayConfirmationResult =
  | { ok: true; row: PendingGatewayConfirmation; decision: 'approve' | 'reject' }
  | { ok: false; reason: 'not_found' | 'actor_mismatch' | 'expired' | 'already_resolved' };

export function claimGatewayConfirmation(
  id: string,
  actorUserId: string,
  decision: 'approve' | 'reject',
  now = new Date(),
): ClaimGatewayConfirmationResult {
  return getDb().transaction(() => {
    const row = getPendingGatewayConfirmation(id);
    if (!row) return { ok: false, reason: 'not_found' } as const;
    if (row.requester_user_id !== actorUserId) return { ok: false, reason: 'actor_mismatch' } as const;
    if (row.status !== 'pending') return { ok: false, reason: 'already_resolved' } as const;
    if (Date.parse(row.expires_at) <= now.getTime()) {
      getDb()
        .prepare(
          `UPDATE pending_gateway_confirmations
           SET status = 'expired', resolved_at = ?
           WHERE confirmation_id = ? AND status = 'pending'`,
        )
        .run(now.toISOString(), id);
      return { ok: false, reason: 'expired' } as const;
    }
    const status = decision === 'approve' ? 'issuing' : 'rejected';
    const changed = getDb()
      .prepare(
        `UPDATE pending_gateway_confirmations
         SET status = ?, resolved_at = ?
         WHERE confirmation_id = ? AND status = 'pending'`,
      )
      .run(status, now.toISOString(), id).changes;
    if (changed !== 1) return { ok: false, reason: 'already_resolved' } as const;
    return { ok: true, row: { ...row, status, resolved_at: now.toISOString() }, decision } as const;
  })();
}

export function finalizeGatewayConfirmation(
  id: string,
  status: 'approved' | 'failed',
  errorCode: string | null = null,
  now = new Date(),
): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE pending_gateway_confirmations
         SET status = ?, error_code = ?, resolved_at = ?
         WHERE confirmation_id = ? AND status = 'issuing'`,
      )
      .run(status, errorCode, now.toISOString(), id).changes === 1
  );
}

export function listPendingGatewayConfirmationsForLane(
  requesterUserId: string,
  laneId: string,
  now = new Date(),
): PendingGatewayConfirmation[] {
  return getDb()
    .prepare(
      `SELECT * FROM pending_gateway_confirmations
       WHERE requester_user_id = ? AND conversation_lane_id = ?
         AND status = 'pending' AND expires_at > ?
       ORDER BY created_at ASC`,
    )
    .all(requesterUserId, laneId, now.toISOString()) as PendingGatewayConfirmation[];
}

export function findTextResolvableGatewayConfirmations(args: {
  requesterUserId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  now?: Date;
}): PendingGatewayConfirmation[] {
  const now = args.now ?? new Date();
  return getDb()
    .prepare(
      `SELECT * FROM pending_gateway_confirmations
       WHERE requester_user_id = ?
         AND channel_type = ?
         AND platform_id = ?
         AND COALESCE(thread_id, '') = COALESCE(?, '')
         AND status = 'pending'
         AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 2`,
    )
    .all(
      args.requesterUserId,
      args.channelType,
      args.platformId,
      args.threadId,
      now.toISOString(),
    ) as PendingGatewayConfirmation[];
}

/** Recover the narrow crash window between claiming approval and resolving it. */
export function resetIssuingGatewayConfirmationsAfterRestart(now = new Date()): number {
  return getDb()
    .prepare(
      `UPDATE pending_gateway_confirmations
       SET status = 'pending', resolved_at = NULL, error_code = NULL
       WHERE status = 'issuing' AND expires_at > ?`,
    )
    .run(now.toISOString()).changes;
}

/**
 * Atomically expire due rows and return their trusted session routes so the
 * broker can unblock waiting Workers. No token or Preview plaintext is needed.
 */
export function expireDueGatewayConfirmations(now = new Date()): PendingGatewayConfirmation[] {
  return getDb().transaction(() => {
    const rows = getDb()
      .prepare(
        `SELECT * FROM pending_gateway_confirmations
         WHERE status IN ('pending', 'issuing') AND expires_at <= ?
         ORDER BY expires_at ASC`,
      )
      .all(now.toISOString()) as PendingGatewayConfirmation[];
    if (rows.length === 0) return rows;
    const update = getDb().prepare(
      `UPDATE pending_gateway_confirmations
       SET status = 'expired', resolved_at = ?
       WHERE confirmation_id = ? AND status IN ('pending', 'issuing')`,
    );
    for (const row of rows) update.run(now.toISOString(), row.confirmation_id);
    return rows;
  })();
}
