import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

import type { InboundEvent } from '../channels/adapter.js';
import { submitAuthenticatedWebInbound } from '../channels/web.js';
import { getAllAgentGroups, getAgentGroup } from '../db/agent-groups.js';
import {
  createConversationBinding,
  createConversationLane,
  getConversationLane,
  listConversationBindings,
  listConversationLanesForUser,
} from '../db/conversation-lanes.js';
import { getDb } from '../db/connection.js';
import {
  DeliverySubscriptionError,
  disableFeishuDeliverySubscription,
  enableFeishuDeliverySubscription,
  getFeishuDeliverySubscriptionState,
} from '../db/delivery-subscriptions.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../db/messaging-groups.js';
import { getSession } from '../db/sessions.js';
import {
  completeWebMessageReceipt,
  messageBaseIdFromReceipt,
  reserveWebMessageReceipt,
  type WebMessageReceipt,
} from '../db/web-message-receipts.js';
import { appendWebEvent } from '../db/web-events.js';
import { canAccessAgentGroup } from '../modules/permissions/access.js';
import { inboundDbPath, openInboundDb, openOutboundDb, outboundDbPath } from '../session-manager.js';
import type { ConversationLane } from '../types.js';

const CLIENT_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_HISTORY_PAGE = 100;

export class WebConversationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = 'WebConversationError';
  }
}

export interface WebConversationSummary {
  id: string;
  agentGroup: { id: string; name: string };
  sourceChannel: string;
  status: ConversationLane['status'];
  createdAt: string;
  archivedAt: string | null;
  lastActiveAt: string | null;
}

export interface WebHistoryMessage {
  id: string;
  sequence: number | null;
  direction: 'user' | 'agent';
  kind: string;
  timestamp: string;
  text: string;
  channel: {
    type: string | null;
    platformId: string | null;
    threadId: string | null;
  };
  status: string;
}

export interface WebDeliverySubscriptionState {
  channel: 'feishu';
  deliveryKind: 'agent-reply-mirror';
  enabled: boolean;
  available: boolean;
}

interface HistoryKey {
  timestamp: string;
  sequence: number;
  direction: number;
  id: string;
}

interface EncodedCursor {
  v: 1;
  before: HistoryKey;
}

export type SubmitWebInbound = (
  event: Omit<InboundEvent, 'channelType'> & { authenticatedUserId: string; conversationLaneId: string },
) => Promise<void>;

function assertAccessibleLane(userId: string, laneId: string, requireActive = false): ConversationLane {
  const lane = getConversationLane(laneId);
  // One generic error prevents callers from distinguishing "does not exist"
  // from "belongs to someone else".
  if (
    !lane ||
    lane.owner_user_id !== userId ||
    !canAccessAgentGroup(userId, lane.agent_group_id).allowed ||
    (requireActive && lane.status !== 'active')
  ) {
    throw new WebConversationError(403, 'conversation_unavailable');
  }
  return lane;
}

function laneSummary(lane: ConversationLane): WebConversationSummary {
  const group = getAgentGroup(lane.agent_group_id);
  if (!group) throw new WebConversationError(403, 'conversation_unavailable');
  const session = lane.root_session_id ? getSession(lane.root_session_id) : undefined;
  const sourceBinding = listConversationBindings(lane.id)[0];
  return {
    id: lane.id,
    agentGroup: { id: group.id, name: group.name },
    sourceChannel: sourceBinding?.channel_type ?? 'unknown',
    status: lane.status,
    createdAt: lane.created_at,
    archivedAt: lane.archived_at,
    lastActiveAt: session?.last_active ?? null,
  };
}

export function listWebConversations(userId: string): {
  conversations: WebConversationSummary[];
  availableAgentGroups: Array<{ id: string; name: string }>;
} {
  const conversations = listConversationLanesForUser(userId)
    .filter((lane) => canAccessAgentGroup(userId, lane.agent_group_id).allowed)
    .map(laneSummary);
  const availableAgentGroups = getAllAgentGroups()
    .filter((group) => canAccessAgentGroup(userId, group.id).allowed)
    .map((group) => ({ id: group.id, name: group.name }));
  return { conversations, availableAgentGroups };
}

export function createWebConversation(userId: string, agentGroupId: string): WebConversationSummary {
  const normalizedAgentGroupId = agentGroupId.trim();
  if (!normalizedAgentGroupId) throw new WebConversationError(400, 'invalid_agent_group');
  if (!getAgentGroup(normalizedAgentGroupId) || !canAccessAgentGroup(userId, normalizedAgentGroupId).allowed) {
    throw new WebConversationError(403, 'agent_group_unavailable');
  }

  const db = getDb();
  const lane = db.transaction(() => {
    // Re-run inside the transaction so a concurrent revocation cannot be
    // replaced by browser-provided routing context.
    if (!canAccessAgentGroup(userId, normalizedAgentGroupId).allowed) {
      throw new WebConversationError(403, 'agent_group_unavailable');
    }
    const created = createConversationLane({
      agentGroupId: normalizedAgentGroupId,
      ownerUserId: userId,
      actor: userId,
    });
    ensureActiveWebBinding(created, userId);
    return created;
  })();
  return laneSummary(lane);
}

export function getWebDeliverySubscription(args: {
  userId: string;
  laneId: string;
  feishuProviderScope: string;
}): WebDeliverySubscriptionState {
  assertAccessibleLane(args.userId, args.laneId, true);
  try {
    const state = getFeishuDeliverySubscriptionState({
      userId: args.userId,
      laneId: args.laneId,
      providerScope: args.feishuProviderScope,
    });
    return {
      channel: 'feishu',
      deliveryKind: 'agent-reply-mirror',
      enabled: state.enabled,
      available: state.available,
    };
  } catch (error) {
    if (error instanceof DeliverySubscriptionError) {
      throw new WebConversationError(403, 'conversation_unavailable');
    }
    throw error;
  }
}

export function setWebDeliverySubscription(args: {
  userId: string;
  laneId: string;
  feishuProviderScope: string;
  enabled: boolean;
}): WebDeliverySubscriptionState {
  assertAccessibleLane(args.userId, args.laneId, true);
  try {
    if (args.enabled) {
      enableFeishuDeliverySubscription({
        userId: args.userId,
        laneId: args.laneId,
        providerScope: args.feishuProviderScope,
      });
    } else {
      disableFeishuDeliverySubscription({ userId: args.userId, laneId: args.laneId });
    }
    return getWebDeliverySubscription(args);
  } catch (error) {
    if (error instanceof DeliverySubscriptionError) {
      if (error.reason === 'verified_feishu_open_id_required') {
        throw new WebConversationError(409, 'verified_feishu_identity_required');
      }
      throw new WebConversationError(403, 'conversation_unavailable');
    }
    throw error;
  }
}

function decodeCursor(raw: string | null): EncodedCursor | null {
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Partial<EncodedCursor>;
    if (
      decoded.v !== 1 ||
      !decoded.before ||
      typeof decoded.before.timestamp !== 'string' ||
      !Number.isSafeInteger(decoded.before.sequence) ||
      !Number.isSafeInteger(decoded.before.direction) ||
      typeof decoded.before.id !== 'string'
    ) {
      throw new Error('invalid cursor shape');
    }
    return decoded as EncodedCursor;
  } catch {
    throw new WebConversationError(400, 'invalid_cursor');
  }
}

function encodeCursor(key: HistoryKey): string {
  return Buffer.from(JSON.stringify({ v: 1, before: key } satisfies EncodedCursor)).toString('base64url');
}

function historyKey(message: WebHistoryMessage): HistoryKey {
  return {
    timestamp: message.timestamp,
    sequence: message.sequence ?? -1,
    direction: message.direction === 'user' ? 0 : 1,
    id: message.id,
  };
}

function compareKey(left: HistoryKey, right: HistoryKey): number {
  return (
    left.timestamp.localeCompare(right.timestamp) ||
    left.sequence - right.sequence ||
    left.direction - right.direction ||
    left.id.localeCompare(right.id)
  );
}

function messageText(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text : raw;
  } catch {
    return raw;
  }
}

function legacyInboundOwner(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return typeof parsed.senderId === 'string'
      ? parsed.senderId
      : typeof parsed.sender === 'string'
        ? parsed.sender
        : null;
  } catch {
    return null;
  }
}

export function getWebConversationHistory(args: {
  userId: string;
  laneId: string;
  cursor?: string | null;
  limit?: number;
}): { messages: WebHistoryMessage[]; nextCursor: string | null } {
  const lane = assertAccessibleLane(args.userId, args.laneId);
  const cursor = decodeCursor(args.cursor ?? null);
  const limit = Math.max(1, Math.min(args.limit ?? 50, MAX_HISTORY_PAGE));
  if (!lane.root_session_id) return { messages: [], nextCursor: null };
  const session = getSession(lane.root_session_id);
  if (
    !session ||
    session.owner_user_id !== args.userId ||
    session.agent_group_id !== lane.agent_group_id ||
    session.conversation_lane_id !== lane.id
  ) {
    throw new WebConversationError(403, 'conversation_unavailable');
  }

  const inboundPath = inboundDbPath(session.agent_group_id, session.id);
  const outboundPath = outboundDbPath(session.agent_group_id, session.id);
  if (!fs.existsSync(inboundPath) || !fs.existsSync(outboundPath)) {
    throw new WebConversationError(409, 'conversation_history_unavailable');
  }

  const inbound = openInboundDb(session.agent_group_id, session.id);
  const outbound = openOutboundDb(session.agent_group_id, session.id);
  try {
    const incoming = inbound
      .prepare(
        `SELECT id, seq, kind, timestamp, platform_id, channel_type, thread_id,
                content, status, origin_user_id
         FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')`,
      )
      .all() as Array<{
      id: string;
      seq: number | null;
      kind: string;
      timestamp: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
      status: string;
      origin_user_id: string | null;
    }>;
    const outgoing = outbound
      .prepare(
        `SELECT id, seq, kind, timestamp, platform_id, channel_type, thread_id, content, in_reply_to
         FROM messages_out
         WHERE kind NOT IN ('system', 'llm-usage') AND channel_type IS NOT 'agent'`,
      )
      .all() as Array<{
      id: string;
      seq: number | null;
      kind: string;
      timestamp: string;
      platform_id: string | null;
      channel_type: string | null;
      thread_id: string | null;
      content: string;
      in_reply_to: string | null;
    }>;
    const deliveryRows = inbound.prepare('SELECT message_out_id, status FROM delivered').all() as Array<{
      message_out_id: string;
      status: string;
    }>;
    const deliveries = new Map(deliveryRows.map((row) => [row.message_out_id, row.status]));
    const trustedRoutes = new Map(
      incoming
        .filter(
          (row) =>
            row.origin_user_id === args.userId ||
            (row.origin_user_id === null && legacyInboundOwner(row.content) === args.userId),
        )
        .map((row) => [row.id, { type: row.channel_type, platformId: row.platform_id, threadId: row.thread_id }]),
    );

    const messages: WebHistoryMessage[] = [
      ...incoming
        .filter(
          (row) =>
            row.origin_user_id === args.userId ||
            (row.origin_user_id === null && legacyInboundOwner(row.content) === args.userId),
        )
        .map((row) => ({
          id: row.id,
          sequence: row.seq,
          direction: 'user' as const,
          kind: row.kind,
          timestamp: row.timestamp,
          text: messageText(row.content),
          channel: { type: row.channel_type, platformId: row.platform_id, threadId: row.thread_id },
          status: row.status === 'failed' ? 'failed' : 'accepted',
        })),
      ...outgoing
        // For Lane replies, the Host-written inbound source is the same
        // trusted routing authority used by delivery.ts. Container-written
        // address columns may be null (bare model reply) or forged.
        .filter((row) => !row.in_reply_to || trustedRoutes.has(row.in_reply_to))
        .map((row) => ({
          id: row.id,
          sequence: row.seq,
          direction: 'agent' as const,
          kind: row.kind,
          timestamp: row.timestamp,
          text: messageText(row.content),
          channel: (row.in_reply_to ? trustedRoutes.get(row.in_reply_to) : undefined) ?? {
            type: row.channel_type,
            platformId: row.platform_id,
            threadId: row.thread_id,
          },
          status: deliveries.get(row.id) ?? 'pending',
        })),
    ].sort((left, right) => compareKey(historyKey(left), historyKey(right)));

    const eligible = cursor
      ? messages.filter((message) => compareKey(historyKey(message), cursor.before) < 0)
      : messages;
    const page = eligible.slice(Math.max(0, eligible.length - limit));
    const hasMore = eligible.length > page.length;
    return {
      messages: page,
      nextCursor: hasMore && page[0] ? encodeCursor(historyKey(page[0])) : null,
    };
  } finally {
    outbound.close();
    inbound.close();
  }
}

function findActiveWebBinding(lane: ConversationLane): { platformId: string; messagingGroupId: string } | null {
  const binding = listConversationBindings(lane.id).find(
    (candidate) =>
      candidate.revoked_at === null &&
      candidate.channel_type === 'web' &&
      candidate.delivery_mode === 'source-reply' &&
      candidate.messaging_group_id !== null,
  );
  if (!binding?.messaging_group_id) return null;
  const group = getMessagingGroup(binding.messaging_group_id);
  if (!group || group.channel_type !== 'web' || group.platform_id !== binding.platform_id || group.is_group !== 0) {
    throw new WebConversationError(409, 'conversation_binding_unavailable');
  }
  return { platformId: binding.platform_id, messagingGroupId: group.id };
}

/**
 * Feishu-first Lanes do not initially have a Web address. Provision that
 * private ingress lazily on the first authenticated Web send, after repeating
 * the Host access gate inside the transaction. The deterministic platform ID
 * and serialized central-DB transaction make retries converge without
 * granting any new Role or Membership.
 */
function ensureActiveWebBinding(
  lane: ConversationLane,
  userId: string,
): {
  platformId: string;
  messagingGroupId: string;
} {
  return getDb().transaction(() => {
    const currentLane = assertAccessibleLane(userId, lane.id, true);
    const active = findActiveWebBinding(currentLane);
    if (active) return active;

    const platformId = `web:${currentLane.id}`;
    let group = getMessagingGroupByPlatform('web', platformId);
    const now = new Date().toISOString();
    if (!group) {
      createMessagingGroup({
        id: `mg-web-${randomUUID()}`,
        channel_type: 'web',
        platform_id: platformId,
        name: `Web ${currentLane.id.slice(-8)}`,
        is_group: 0,
        unknown_sender_policy: 'strict',
        denied_at: null,
        created_at: now,
      });
      group = getMessagingGroupByPlatform('web', platformId);
    }
    if (!group || group.is_group !== 0) {
      throw new WebConversationError(409, 'conversation_binding_unavailable');
    }
    if (!getMessagingGroupAgentByPair(group.id, currentLane.agent_group_id)) {
      createMessagingGroupAgent({
        id: `mga-web-${randomUUID()}`,
        messaging_group_id: group.id,
        agent_group_id: currentLane.agent_group_id,
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        ignored_message_policy: 'drop',
        session_mode: 'per-user',
        priority: 0,
        created_at: now,
      });
    }
    createConversationBinding({
      laneId: currentLane.id,
      channelType: 'web',
      messagingGroupId: group.id,
      platformId,
      deliveryMode: 'source-reply',
      actor: userId,
      verifiedAt: now,
    });
    return { platformId, messagingGroupId: group.id };
  })();
}

function receiptResponse(
  receipt: WebMessageReceipt,
  replayed: boolean,
): {
  clientMessageId: string;
  messageId: string;
  status: WebMessageReceipt['status'];
  replayed: boolean;
} {
  return {
    clientMessageId: receipt.client_message_id,
    messageId: receipt.server_message_id,
    status: receipt.status,
    replayed,
  };
}

export async function submitWebConversationMessage(args: {
  userId: string;
  laneId: string;
  clientMessageId: string;
  text: string;
  submitInbound?: SubmitWebInbound;
}): Promise<ReturnType<typeof receiptResponse>> {
  const lane = assertAccessibleLane(args.userId, args.laneId, true);
  const clientMessageId = args.clientMessageId.trim();
  if (!CLIENT_MESSAGE_ID.test(clientMessageId)) {
    throw new WebConversationError(400, 'invalid_client_message_id');
  }
  if (!args.text.trim()) throw new WebConversationError(400, 'message_text_required');
  const binding = ensureActiveWebBinding(lane, args.userId);
  const reserved = reserveWebMessageReceipt({
    userId: args.userId,
    laneId: lane.id,
    clientMessageId,
    agentGroupId: lane.agent_group_id,
  });
  if (!reserved.created) return receiptResponse(reserved.receipt, true);

  const user = getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(args.userId) as
    | { display_name: string | null }
    | undefined;
  if (!user) {
    completeWebMessageReceipt(reserved.receipt.id, 'failed', 'authentication_required');
    throw new WebConversationError(401, 'authentication_required');
  }

  try {
    await (args.submitInbound ?? submitAuthenticatedWebInbound)({
      platformId: binding.platformId,
      threadId: null,
      conversationLaneId: lane.id,
      authenticatedUserId: args.userId,
      message: {
        id: messageBaseIdFromReceipt(reserved.receipt),
        kind: 'chat',
        content: JSON.stringify({ text: args.text, sender: user.display_name ?? 'Web User' }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: false,
      },
    });
  } catch (error) {
    completeWebMessageReceipt(reserved.receipt.id, 'failed', 'route_failed');
    if (error instanceof WebConversationError) throw error;
    throw new WebConversationError(503, 'message_route_failed');
  }

  const accepted = completeWebMessageReceipt(reserved.receipt.id, 'accepted');
  appendWebEvent({
    userId: args.userId,
    laneId: lane.id,
    eventType: 'conversation.message.accepted',
    resourceId: accepted.server_message_id,
  });
  return receiptResponse(accepted, false);
}
