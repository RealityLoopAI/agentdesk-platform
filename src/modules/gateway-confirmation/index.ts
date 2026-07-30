/**
 * Host-mediated Gateway confirmation broker (ADR-0073).
 *
 * Trust boundaries:
 * - the outbound intent is untrusted container data;
 * - actor and delivery route are re-derived from Host-written inbound rows;
 * - only the Host signing proxy may call /confirmation/issue;
 * - bearer confirmation tokens go only to the waiting Worker system response.
 */
import type Database from 'better-sqlite3';

import { approverExpectedUserId, normalizeOptions } from '../../channels/ask-question.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { wakeContainer } from '../../container-runner.js';
import {
  claimGatewayConfirmation,
  createPendingGatewayConfirmation,
  expireDueGatewayConfirmations,
  finalizeGatewayConfirmation,
  findTextResolvableGatewayConfirmations,
  getPendingGatewayConfirmation,
} from '../../db/gateway-confirmations.js';
import { recordEnterpriseAudit } from '../../db/enterprise-audit.js';
import { appendWebEvent } from '../../db/web-events.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter, registerDeliveryAction } from '../../delivery.js';
import { processHostGatewayConfirmationRequest } from '../../gateway-signing-proxy.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { resolveSender, setMessageInterceptor } from '../../router.js';
import { openInboundDb, writeSessionMessage } from '../../session-manager.js';
import type { PendingGatewayConfirmation, Session } from '../../types.js';
import {
  emitGatewayConfirmationDelivered,
  emitGatewayConfirmationResolved,
  type GatewayConfirmationResolution,
} from './events.js';

const MAX_PENDING_MS = 15 * 60_000;
const SHA256 = /^sha256:[a-f0-9]{64}$/;

interface UpdateDiff {
  field: string;
  before: unknown;
  after: unknown;
  highImpact: boolean;
}

interface UpdatePreview {
  recordId: string;
  diff: UpdateDiff[];
  expectedRecordFingerprint: string;
  bindingHash: string;
  confirmationRequest: string;
  expiresAt: number;
  auditId: string;
  highImpactFields: string[];
}

interface CreatePreview {
  operation: 'feishu.bitable.record.create';
  resource: string;
  fields: Record<string, unknown>;
  expiresAt: number;
  correlationId?: string;
}

interface DeletePreview {
  recordId: string;
  fields: Record<string, unknown>;
  expectedRecordFingerprint: string;
  bindingHash: string;
  confirmationRequest: string;
  expiresAt: number;
  auditId: string;
}

type ConfirmationIntent =
  | { action: 'gateway_confirmation_request'; kind: 'update'; title?: string; preview: UpdatePreview }
  | { action: 'gateway_confirmation_request'; kind: 'delete'; title?: string; preview: DeletePreview }
  | { action: 'gateway_confirmation_request'; kind: 'create'; title?: string; preview: CreatePreview };

interface IssuedConfirmation {
  ok: true;
  confirmation: string;
  expiresAt: number;
  bindingHash: string;
  auditId: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validTitle(value: unknown): value is string | undefined {
  return value === undefined || boundedString(value, 120);
}

function isJsonValue(value: unknown, depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth >= 10) return false;
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, depth + 1));
  return isObject(value) && Object.values(value).every((item) => isJsonValue(item, depth + 1));
}

function parseIntent(value: Record<string, unknown>): ConfirmationIntent | null {
  if (
    value.action !== 'gateway_confirmation_request' ||
    !validTitle(value.title) ||
    !hasOnlyKeys(value, ['action', 'kind', 'title', 'preview']) ||
    !isObject(value.preview)
  ) {
    return null;
  }
  const preview = value.preview;
  if (value.kind === 'update') {
    if (
      !hasOnlyKeys(preview, [
        'recordId',
        'diff',
        'expectedRecordFingerprint',
        'bindingHash',
        'confirmationRequest',
        'expiresAt',
        'auditId',
        'highImpactFields',
      ]) ||
      !boundedString(preview.recordId, 128) ||
      typeof preview.expectedRecordFingerprint !== 'string' ||
      !SHA256.test(preview.expectedRecordFingerprint) ||
      typeof preview.bindingHash !== 'string' ||
      !SHA256.test(preview.bindingHash) ||
      !boundedString(preview.confirmationRequest, 16_384) ||
      !Number.isSafeInteger(preview.expiresAt) ||
      (preview.expiresAt as number) <= 0 ||
      !boundedString(preview.auditId, 512) ||
      !Array.isArray(preview.diff) ||
      preview.diff.length < 1 ||
      preview.diff.length > 200 ||
      (preview.highImpactFields !== undefined && !Array.isArray(preview.highImpactFields)) ||
      (Array.isArray(preview.highImpactFields) && preview.highImpactFields.length > 200) ||
      (Array.isArray(preview.highImpactFields) && preview.highImpactFields.some((field) => !boundedString(field, 256)))
    ) {
      return null;
    }
    const diff: UpdateDiff[] = [];
    for (const item of preview.diff) {
      if (
        !isObject(item) ||
        !hasOnlyKeys(item, ['field', 'before', 'after', 'highImpact']) ||
        !boundedString(item.field, 256) ||
        (item.highImpact !== undefined && typeof item.highImpact !== 'boolean') ||
        !Object.prototype.hasOwnProperty.call(item, 'before') ||
        !Object.prototype.hasOwnProperty.call(item, 'after')
      ) {
        return null;
      }
      diff.push({
        field: item.field,
        before: item.before,
        after: item.after,
        highImpact: item.highImpact ?? false,
      });
    }
    return {
      action: 'gateway_confirmation_request',
      kind: 'update',
      ...(value.title ? { title: value.title } : {}),
      preview: {
        recordId: preview.recordId,
        diff,
        expectedRecordFingerprint: preview.expectedRecordFingerprint,
        bindingHash: preview.bindingHash,
        confirmationRequest: preview.confirmationRequest,
        expiresAt: preview.expiresAt as number,
        auditId: preview.auditId,
        highImpactFields: (preview.highImpactFields as string[] | undefined) ?? [],
      },
    };
  }
  if (value.kind === 'delete') {
    if (
      !hasOnlyKeys(preview, [
        'recordId',
        'fields',
        'expectedRecordFingerprint',
        'bindingHash',
        'confirmationRequest',
        'expiresAt',
        'auditId',
      ]) ||
      !boundedString(preview.recordId, 128) ||
      !isObject(preview.fields) ||
      Object.keys(preview.fields).length > 200 ||
      Object.keys(preview.fields).some((field) => !boundedString(field, 256)) ||
      !Object.values(preview.fields).every((field) => isJsonValue(field)) ||
      typeof preview.expectedRecordFingerprint !== 'string' ||
      !SHA256.test(preview.expectedRecordFingerprint) ||
      typeof preview.bindingHash !== 'string' ||
      !SHA256.test(preview.bindingHash) ||
      !boundedString(preview.confirmationRequest, 16_384) ||
      !Number.isSafeInteger(preview.expiresAt) ||
      (preview.expiresAt as number) <= 0 ||
      !boundedString(preview.auditId, 512)
    ) {
      return null;
    }
    return {
      action: 'gateway_confirmation_request',
      kind: 'delete',
      ...(value.title ? { title: value.title } : {}),
      preview: {
        recordId: preview.recordId,
        fields: preview.fields,
        expectedRecordFingerprint: preview.expectedRecordFingerprint,
        bindingHash: preview.bindingHash,
        confirmationRequest: preview.confirmationRequest,
        expiresAt: preview.expiresAt as number,
        auditId: preview.auditId,
      },
    };
  }
  if (
    value.kind !== 'create' ||
    !hasOnlyKeys(preview, ['operation', 'resource', 'fields', 'expiresAt', 'correlationId']) ||
    preview.operation !== 'feishu.bitable.record.create' ||
    !boundedString(preview.resource, 256) ||
    (preview.correlationId !== undefined && !boundedString(preview.correlationId, 128)) ||
    !isObject(preview.fields) ||
    Object.keys(preview.fields).length > 200 ||
    Object.keys(preview.fields).some((field) => !boundedString(field, 256)) ||
    !Number.isSafeInteger(preview.expiresAt) ||
    (preview.expiresAt as number) <= 0
  ) {
    return null;
  }
  return {
    action: 'gateway_confirmation_request',
    kind: 'create',
    ...(value.title ? { title: value.title } : {}),
    preview: {
      operation: 'feishu.bitable.record.create',
      resource: preview.resource,
      fields: preview.fields,
      expiresAt: preview.expiresAt as number,
      ...(preview.correlationId === undefined ? {} : { correlationId: preview.correlationId }),
    },
  };
}

function parseIssuedConfirmation(value: unknown): IssuedConfirmation | null {
  if (!isObject(value)) return null;
  if (
    value.ok !== true ||
    !boundedString(value.confirmation, 16_384) ||
    !Number.isSafeInteger(value.expiresAt) ||
    (value.expiresAt as number) <= 0 ||
    typeof value.bindingHash !== 'string' ||
    !SHA256.test(value.bindingHash) ||
    !boundedString(value.auditId, 2048)
  ) {
    return null;
  }
  return {
    ok: true,
    confirmation: value.confirmation,
    expiresAt: value.expiresAt as number,
    bindingHash: value.bindingHash,
    auditId: value.auditId,
  };
}

interface TrustedInboundRow {
  id: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  source_session_id: string | null;
  origin_user_id: string | null;
  conversation_thread_id: string | null;
}

interface TrustedConfirmationOrigin {
  requesterUserId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  conversationLaneId: string | null;
}

function readTrustedInbound(db: Database.Database, id: string): TrustedInboundRow | undefined {
  return db
    .prepare(
      `SELECT id, channel_type, platform_id, thread_id, source_session_id,
              origin_user_id, conversation_thread_id
       FROM messages_in
       WHERE id = ? AND kind IN ('chat', 'chat-sdk')`,
    )
    .get(id) as TrustedInboundRow | undefined;
}

function findRootChannelOrigin(root: Session, requesterUserId: string): TrustedInboundRow | undefined {
  const db = openInboundDb(root.agent_group_id, root.id);
  try {
    return db
      .prepare(
        `SELECT id, channel_type, platform_id, thread_id, source_session_id,
                origin_user_id, conversation_thread_id
         FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
           AND channel_type IS NOT NULL AND channel_type <> 'agent'
           AND origin_user_id = ?
         ORDER BY seq DESC, timestamp DESC LIMIT 1`,
      )
      .get(requesterUserId) as TrustedInboundRow | undefined;
  } finally {
    db.close();
  }
}

function resolveTrustedOrigin(
  session: Session,
  inDb: Database.Database,
  inReplyTo: string | null,
): TrustedConfirmationOrigin | null {
  if (!inReplyTo) return null;
  const trigger = readTrustedInbound(inDb, inReplyTo);
  if (!trigger) return null;
  const requesterUserId = trigger.origin_user_id ?? session.owner_user_id;
  if (!requesterUserId) return null;

  let route = trigger;
  let laneId = session.conversation_lane_id ?? null;
  if (trigger.channel_type === 'agent') {
    const root = getSession(session.root_session_id ?? trigger.source_session_id ?? '');
    if (!root) return null;
    // conversation_thread_id is correlation-only (ADR-0039), never a lookup
    // key. Resolve the trusted channel structurally from the root session and
    // canonical actor instead.
    route = findRootChannelOrigin(root, requesterUserId) ?? trigger;
    laneId = root.conversation_lane_id ?? laneId;
  }
  if (!route.channel_type || route.channel_type === 'agent' || !route.platform_id) return null;
  return {
    requesterUserId,
    channelType: route.channel_type,
    platformId: route.platform_id,
    threadId: route.thread_id,
    conversationLaneId: laneId,
  };
}

function displayValue(value: unknown): string {
  const raw = typeof value === 'string' ? value : JSON.stringify(value);
  const text = raw ?? String(value);
  const bounded = text.length <= 500 ? text : `${text.slice(0, 497)}…`;
  return bounded.replaceAll('\\', '\\\\').replaceAll('|', '\\|').replace(/\r?\n/g, '<br>');
}

function renderQuestion(kind: 'update' | 'create' | 'delete', display: Record<string, unknown>): string {
  if (kind === 'update') {
    const diff = display.diff as Array<{ field: string; before: unknown; after: unknown; highImpact: boolean }>;
    const rows = diff.map(
      (item) =>
        `| ${item.field}${item.highImpact ? ' ⚠️' : ''} | ${displayValue(item.before)} | ${displayValue(item.after)} |`,
    );
    return [
      `请确认是否修改记录 \`${String(display.recordId)}\`：`,
      '',
      '| 字段 | 修改前 | 修改后 |',
      '|---|---|---|',
      ...rows,
      '',
      '确认仅对本次显示的记录、字段和值有效；记录若已变化，提交会失败并要求重新预览。',
    ].join('\n');
  }
  if (kind === 'delete') {
    const fields = display.fields as Record<string, unknown>;
    return [
      `请确认是否删除记录 \`${String(display.recordId)}\`：`,
      '',
      '| 字段 | 当前值 |',
      '|---|---|',
      ...Object.entries(fields).map(([name, value]) => `| ${name} | ${displayValue(value)} |`),
      '',
      '删除仅对本次显示的记录及其当前版本有效；记录若已变化，提交会失败并要求重新预览。',
    ].join('\n');
  }
  const fields = display.fields as Record<string, unknown>;
  return [
    `请确认是否在资源 \`${String(display.resource)}\` 新增一条记录：`,
    '',
    '| 字段 | 值 |',
    '|---|---|',
    ...Object.entries(fields).map(([name, value]) => `| ${name} | ${displayValue(value)} |`),
  ].join('\n');
}

function updateDisplay(preview: UpdatePreview): Record<string, unknown> {
  return {
    recordId: preview.recordId,
    diff: preview.diff,
    expectedRecordFingerprint: preview.expectedRecordFingerprint,
    expiresAt: preview.expiresAt,
    highImpactFields: preview.highImpactFields,
  };
}

function deleteDisplay(preview: DeletePreview): Record<string, unknown> {
  return {
    recordId: preview.recordId,
    fields: preview.fields,
    expectedRecordFingerprint: preview.expectedRecordFingerprint,
    expiresAt: preview.expiresAt,
  };
}

function notifyWeb(row: PendingGatewayConfirmation, eventType: 'available' | 'resolved'): void {
  if (!row.conversation_lane_id) return;
  appendWebEvent({
    userId: row.requester_user_id,
    laneId: row.conversation_lane_id,
    eventType: `conversation.confirmation.${eventType}`,
    resourceId: row.confirmation_id,
  });
}

async function notifyResolved(
  row: PendingGatewayConfirmation,
  status: GatewayConfirmationResolution,
): Promise<void> {
  await emitGatewayConfirmationResolved({
    confirmationId: row.confirmation_id,
    kind: row.kind,
    status,
    requesterUserId: row.requester_user_id,
    channelType: row.channel_type,
    platformId: row.platform_id,
    threadId: row.thread_id,
  });
}

function responseAlreadyExists(row: PendingGatewayConfirmation): boolean {
  const db = openInboundDb(row.agent_group_id, row.session_id);
  try {
    return !!db
      .prepare(
        `SELECT 1 FROM messages_in
         WHERE kind = 'system'
           AND json_extract(content, '$.type') = 'gateway_confirmation_response'
           AND json_extract(content, '$.confirmationId') = ?
         LIMIT 1`,
      )
      .get(row.confirmation_id);
  } finally {
    db.close();
  }
}

async function sendWorkerResponse(
  row: PendingGatewayConfirmation,
  body: {
    status: 'approved' | 'rejected' | 'expired' | 'failed';
    confirmation?: string;
    expiresAt?: number;
    bindingHash?: string;
    auditId?: string;
    errorCode?: string;
  },
): Promise<void> {
  if (!responseAlreadyExists(row)) {
    writeSessionMessage(row.agent_group_id, row.session_id, {
      id: `gateway-confirmation-response-${row.confirmation_id}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      platformId: row.platform_id,
      channelType: row.channel_type,
      threadId: row.thread_id,
      content: JSON.stringify({
        type: 'gateway_confirmation_response',
        confirmationId: row.confirmation_id,
        ...body,
      }),
    });
  }
  const session = getSession(row.session_id);
  if (session) await wakeContainer(session);
}

function canonicalActor(row: PendingGatewayConfirmation, actor: string | null): string | null {
  if (!actor) return null;
  return actor === row.requester_user_id || approverExpectedUserId(row.requester_user_id) === actor
    ? row.requester_user_id
    : null;
}

export async function resolveGatewayConfirmationDecision(
  confirmationId: string,
  actorUserId: string | null,
  decision: 'approve' | 'reject',
): Promise<{ resolved: boolean; reason?: string }> {
  const existing = getPendingGatewayConfirmation(confirmationId);
  if (!existing) return { resolved: false, reason: 'not_found' };
  const actor = canonicalActor(existing, actorUserId);
  if (!actor) return { resolved: false, reason: 'actor_mismatch' };

  const claimed = claimGatewayConfirmation(confirmationId, actor, decision);
  if (!claimed.ok) {
    if (claimed.reason === 'expired') {
      await sendWorkerResponse(existing, { status: 'expired', errorCode: 'confirmation_expired' });
      notifyWeb(existing, 'resolved');
      await notifyResolved(existing, 'expired');
    }
    return { resolved: claimed.reason === 'expired', reason: claimed.reason };
  }
  const row = claimed.row;

  if (decision === 'reject') {
    await sendWorkerResponse(row, { status: 'rejected', errorCode: 'user_rejected' });
    notifyWeb(row, 'resolved');
    await notifyResolved(row, 'rejected');
    recordEnterpriseAudit({
      eventType: 'gateway_confirmation_rejected',
      agentGroupId: row.agent_group_id,
      actor,
      details: { confirmationId: row.confirmation_id, kind: row.kind },
    });
    return { resolved: true };
  }

  if (row.kind === 'create') {
    await sendWorkerResponse(row, { status: 'approved' });
    finalizeGatewayConfirmation(row.confirmation_id, 'approved');
    notifyWeb(row, 'resolved');
    await notifyResolved(row, 'approved');
    recordEnterpriseAudit({
      eventType: 'gateway_confirmation_approved',
      agentGroupId: row.agent_group_id,
      actor,
      details: { confirmationId: row.confirmation_id, kind: row.kind },
    });
    return { resolved: true };
  }

  let display: Record<string, unknown>;
  try {
    display = JSON.parse(row.display_json) as Record<string, unknown>;
  } catch {
    finalizeGatewayConfirmation(row.confirmation_id, 'failed', 'invalid_persisted_display');
    await sendWorkerResponse(row, { status: 'failed', errorCode: 'invalid_persisted_display' });
    notifyWeb(row, 'resolved');
    await notifyResolved(row, 'failed');
    return { resolved: true, reason: 'invalid_persisted_display' };
  }

  const proxyResult = await processHostGatewayConfirmationRequest({
    sessionId: row.session_id,
    agentGroupId: row.agent_group_id,
    body: {
      contractVersion: 1,
      agent: { agentGroupId: row.agent_group_id, groupName: null, assistantName: null },
      requester: {
        userId: row.requester_user_id,
        channelType: row.channel_type,
        platformId: row.platform_id,
        threadId: row.thread_id,
      },
      requesterSource: 'session',
      confirmationRequest: row.confirmation_request,
      display,
      context: { sessionId: row.session_id, confirmationId: row.confirmation_id },
    },
  });
  let issued: IssuedConfirmation | null = null;
  if (proxyResult.httpStatus >= 200 && proxyResult.httpStatus < 300) {
    try {
      issued = parseIssuedConfirmation(JSON.parse(proxyResult.body));
    } catch {
      issued = null;
    }
  }
  if (!issued) {
    const errorCode = proxyResult.httpStatus === 404 ? 'confirmation_issue_not_supported' : 'confirmation_issue_failed';
    finalizeGatewayConfirmation(row.confirmation_id, 'failed', errorCode);
    await sendWorkerResponse(row, { status: 'failed', errorCode });
    notifyWeb(row, 'resolved');
    await notifyResolved(row, 'failed');
    recordEnterpriseAudit({
      eventType: 'gateway_confirmation_failed',
      agentGroupId: row.agent_group_id,
      actor,
      details: { confirmationId: row.confirmation_id, kind: row.kind, errorCode },
    });
    return { resolved: true, reason: errorCode };
  }

  await sendWorkerResponse(row, {
    status: 'approved',
    confirmation: issued.confirmation,
    expiresAt: issued.expiresAt,
    bindingHash: issued.bindingHash,
    auditId: issued.auditId,
  });
  finalizeGatewayConfirmation(row.confirmation_id, 'approved');
  notifyWeb(row, 'resolved');
  await notifyResolved(row, 'approved');
  recordEnterpriseAudit({
    eventType: 'gateway_confirmation_approved',
    agentGroupId: row.agent_group_id,
    actor,
    details: {
      confirmationId: row.confirmation_id,
      kind: row.kind,
      bindingHash: issued.bindingHash,
      auditId: issued.auditId,
    },
  });
  return { resolved: true };
}

async function handleGatewayConfirmationIntent(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
  context?: { messageOutId: string; inReplyTo: string | null },
): Promise<void> {
  if (!context) throw new Error('Gateway confirmation delivery context is required');
  const intent = parseIntent(content);
  if (!intent) throw new Error('invalid Gateway confirmation intent');
  const origin = resolveTrustedOrigin(session, inDb, context.inReplyTo);
  if (!origin) throw new Error('Gateway confirmation has no trusted user origin');

  const now = Date.now();
  if (intent.preview.expiresAt <= now || intent.preview.expiresAt > now + MAX_PENDING_MS) {
    throw new Error('Gateway confirmation expiry is outside the allowed window');
  }
  const display =
    intent.kind === 'update'
      ? updateDisplay(intent.preview)
      : intent.kind === 'delete'
        ? deleteDisplay(intent.preview)
        : {
            operation: intent.preview.operation,
            resource: intent.preview.resource,
            fields: intent.preview.fields,
            expiresAt: intent.preview.expiresAt,
          };
  const approveLabel = intent.kind === 'update' ? '确认修改' : intent.kind === 'delete' ? '确认删除' : '确认新增';
  const options = normalizeOptions([
    { label: approveLabel, selectedLabel: '已确认', value: 'approve' },
    { label: '拒绝', selectedLabel: '已拒绝', value: 'reject' },
  ]);
  const title =
    intent.title ??
    (intent.kind === 'update'
      ? '确认修改多维表格记录'
      : intent.kind === 'delete'
        ? '确认删除多维表格记录'
        : '确认新增多维表格记录');
  const inserted = createPendingGatewayConfirmation({
    confirmationId: context.messageOutId,
    sessionId: session.id,
    messageOutId: context.messageOutId,
    kind: intent.kind,
    requesterUserId: origin.requesterUserId,
    agentGroupId: session.agent_group_id,
    conversationLaneId: origin.conversationLaneId,
    channelType: origin.channelType,
    platformId: origin.platformId,
    threadId: origin.threadId,
    confirmationRequest: intent.kind === 'create' ? null : intent.preview.confirmationRequest,
    displayJson: JSON.stringify(display),
    title,
    optionsJson: JSON.stringify(options),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(intent.preview.expiresAt).toISOString(),
  });
  const row = getPendingGatewayConfirmation(context.messageOutId);
  if (!row) throw new Error('Gateway confirmation persistence failed');

  if (inserted) {
    recordEnterpriseAudit({
      eventType: 'gateway_confirmation_requested',
      agentGroupId: row.agent_group_id,
      actor: row.requester_user_id,
      details: { confirmationId: row.confirmation_id, kind: row.kind },
    });
    notifyWeb(row, 'available');
  }

  // A delivery retry may repeat this card (at-least-once outbound contract).
  // The stable confirmationId keeps every click on the same Host row.
  if (origin.channelType !== 'web') {
    const adapter = getDeliveryAdapter();
    if (!adapter) throw new Error('delivery adapter unavailable for Gateway confirmation');
    await adapter.deliver(
      origin.channelType,
      origin.platformId,
      origin.threadId,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: row.confirmation_id,
        title: row.title,
        question: renderQuestion(row.kind, display),
        options,
        expectedUserId: approverExpectedUserId(row.requester_user_id),
      }),
    );
    await emitGatewayConfirmationDelivered({
      confirmationId: row.confirmation_id,
      kind: row.kind,
      requesterUserId: row.requester_user_id,
      channelType: origin.channelType,
      platformId: origin.platformId,
      threadId: origin.threadId,
      ...(intent.kind === 'create'
        ? {
            resource: intent.preview.resource,
            ...(intent.preview.correlationId === undefined
              ? {}
              : { correlationId: intent.preview.correlationId }),
          }
        : {}),
    });
  }
}

async function handleGatewayConfirmationResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingGatewayConfirmation(payload.questionId);
  if (!row) return false;
  if (payload.value !== 'approve' && payload.value !== 'reject') return true;
  await resolveGatewayConfirmationDecision(row.confirmation_id, payload.userId, payload.value);
  return true;
}

function readText(event: InboundEvent): string | undefined {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text.trim().toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const APPROVE_TEXT = new Set(['确认', '确认修改', '确认新增', '确认删除', 'approve', 'confirm']);
const REJECT_TEXT = new Set(['拒绝', '取消修改', '取消新增', '取消删除', 'reject']);

setMessageInterceptor(async (event): Promise<boolean> => {
  const text = readText(event);
  const decision = text && APPROVE_TEXT.has(text) ? 'approve' : text && REJECT_TEXT.has(text) ? 'reject' : null;
  if (!decision) return false;
  const requesterUserId = resolveSender(event);
  if (!requesterUserId) return false;
  const rows = findTextResolvableGatewayConfirmations({
    requesterUserId,
    channelType: event.channelType,
    platformId: event.platformId,
    threadId: event.threadId,
  });
  if (rows.length !== 1) return false;
  await resolveGatewayConfirmationDecision(rows[0].confirmation_id, requesterUserId, decision);
  return true;
});

export async function sweepExpiredGatewayConfirmations(now = new Date()): Promise<number> {
  const expired = expireDueGatewayConfirmations(now);
  for (const row of expired) {
    await sendWorkerResponse(row, { status: 'expired', errorCode: 'confirmation_expired' });
    notifyWeb(row, 'resolved');
    await notifyResolved(row, 'expired');
  }
  return expired.length;
}

registerDeliveryAction('gateway_confirmation_request', handleGatewayConfirmationIntent);
registerResponseHandler(handleGatewayConfirmationResponse);
