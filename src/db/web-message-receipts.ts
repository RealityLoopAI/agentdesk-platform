import { createHash, randomUUID } from 'node:crypto';

import { getDb } from './connection.js';

export type WebMessageReceiptStatus = 'routing' | 'accepted' | 'failed';

export interface WebMessageReceipt {
  id: string;
  user_id: string;
  lane_id: string;
  client_message_id: string;
  server_message_id: string;
  status: WebMessageReceiptStatus;
  created_at: string;
  completed_at: string | null;
  failure_code: string | null;
}

function stableServerMessageBase(userId: string, laneId: string, clientMessageId: string): string {
  const digest = createHash('sha256')
    .update(`web-message\0${userId}\0${laneId}\0${clientMessageId}`)
    .digest('hex')
    .slice(0, 32);
  return `web-${digest}`;
}

/**
 * Reserve one browser retry key. The unique database key makes concurrent
 * requests converge on the same receipt and the same server message id.
 */
export function reserveWebMessageReceipt(args: {
  userId: string;
  laneId: string;
  clientMessageId: string;
  agentGroupId: string;
  createdAt?: string;
}): { receipt: WebMessageReceipt; created: boolean } {
  const createdAt = args.createdAt ?? new Date().toISOString();
  const baseId = stableServerMessageBase(args.userId, args.laneId, args.clientMessageId);
  const receipt: WebMessageReceipt = {
    id: `web-receipt-${randomUUID()}`,
    user_id: args.userId,
    lane_id: args.laneId,
    client_message_id: args.clientMessageId,
    // Router namespaces all channel inbound ids by Agent Group.
    server_message_id: `${baseId}:${args.agentGroupId}`,
    status: 'routing',
    created_at: createdAt,
    completed_at: null,
    failure_code: null,
  };
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO web_message_receipts
         (id, user_id, lane_id, client_message_id, server_message_id, status,
          created_at, completed_at, failure_code)
       VALUES
         (@id, @user_id, @lane_id, @client_message_id, @server_message_id, @status,
          @created_at, @completed_at, @failure_code)`,
    )
    .run(receipt);
  if (result.changes > 0) return { receipt, created: true };
  const existing = getWebMessageReceipt(args.userId, args.laneId, args.clientMessageId);
  if (!existing) throw new Error('web message receipt uniqueness conflict without an existing row');
  return { receipt: existing, created: false };
}

export function getWebMessageReceipt(
  userId: string,
  laneId: string,
  clientMessageId: string,
): WebMessageReceipt | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM web_message_receipts
       WHERE user_id = ? AND lane_id = ? AND client_message_id = ?`,
    )
    .get(userId, laneId, clientMessageId) as WebMessageReceipt | undefined;
}

export function completeWebMessageReceipt(
  receiptId: string,
  status: Extract<WebMessageReceiptStatus, 'accepted' | 'failed'>,
  failureCode: string | null = null,
  completedAt = new Date().toISOString(),
): WebMessageReceipt {
  getDb()
    .prepare(
      `UPDATE web_message_receipts
       SET status = ?, completed_at = ?, failure_code = ?
       WHERE id = ? AND status = 'routing'`,
    )
    .run(status, completedAt, failureCode, receiptId);
  const row = getDb().prepare('SELECT * FROM web_message_receipts WHERE id = ?').get(receiptId) as
    WebMessageReceipt | undefined;
  if (!row) throw new Error('web message receipt disappeared');
  return row;
}

export function messageBaseIdFromReceipt(receipt: WebMessageReceipt): string {
  const suffix = receipt.server_message_id.lastIndexOf(':');
  if (suffix <= 0) throw new Error('invalid web server message id');
  return receipt.server_message_id.slice(0, suffix);
}
