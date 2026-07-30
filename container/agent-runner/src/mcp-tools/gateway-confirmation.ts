/**
 * Host-mediated Gateway confirmation tool (ADR-0073).
 *
 * The MCP child writes only to container-owned outbound.db and then waits for
 * a Host-written system response in inbound.db. It never writes Central DB,
 * chooses the canonical actor, or calls /confirmation/issue itself.
 */
import { z } from 'zod';

import { getOutboundDb } from '../db/connection.js';
import { findGatewayConfirmationResponse, markCompleted } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { bitableUpdatePreviewSchema } from './feishu-bitable-contract.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAX_CONFIRMATION_WAIT_MS = 15 * 60_000;

const createPreviewSchema = z
  .object({
    operation: z.literal('feishu.bitable.record.create'),
    resource: z.string().min(1).max(256),
    fields: z.record(z.string().min(1).max(256), z.unknown()),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();

const requestSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('update'),
      title: z.string().min(1).max(120).optional(),
      preview: bitableUpdatePreviewSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('create'),
      title: z.string().min(1).max(120).optional(),
      preview: createPreviewSchema,
    })
    .strict(),
]);

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function currentInboundAnchor(): string | null {
  try {
    const rows = getOutboundDb()
      .prepare("SELECT message_id FROM processing_ack WHERE status = 'processing' ORDER BY message_id")
      .all() as Array<{ message_id: string }>;
    return rows[0]?.message_id ?? null;
  } catch {
    return null;
  }
}

function generateId(): string {
  return `gateway-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const gatewayRequestConfirmation: McpToolDefinition = {
  tool: {
    name: 'gateway_request_confirmation',
    description:
      'Ask the original user to confirm one Feishu Bitable record create or update. ' +
      'For update, pass the exact dryRun preview returned by the Gateway; never recalculate or edit its diff. ' +
      'This call blocks until the Host verifies the actor and returns approve/reject/expiry. ' +
      'Only an approved update response contains the short-lived confirmation token required by gateway_execute.',
    inputSchema: {
      type: 'object' as const,
      oneOf: [
        {
          properties: {
            kind: { const: 'update' },
            title: { type: 'string', maxLength: 120 },
            preview: { type: 'object' },
          },
          required: ['kind', 'preview'],
          additionalProperties: false,
        },
        {
          properties: {
            kind: { const: 'create' },
            title: { type: 'string', maxLength: 120 },
            preview: { type: 'object' },
          },
          required: ['kind', 'preview'],
          additionalProperties: false,
        },
      ],
    },
  },
  async handler(args) {
    const parsed = requestSchema.safeParse(args);
    if (!parsed.success) return err('invalid confirmation request');

    const inReplyTo = currentInboundAnchor();
    if (!inReplyTo) return err('no trusted processing message is available for confirmation');

    const confirmationId = generateId();
    const route = getSessionRouting();
    const expiresAt =
      parsed.data.kind === 'create'
        ? (parsed.data.preview.expiresAt ?? Date.now() + MAX_CONFIRMATION_WAIT_MS)
        : parsed.data.preview.expiresAt;
    if (expiresAt <= Date.now()) return err('confirmation preview has expired');
    const preview = { ...parsed.data.preview, expiresAt };

    writeMessageOut({
      id: confirmationId,
      in_reply_to: inReplyTo,
      kind: 'system',
      platform_id: route.platform_id,
      channel_type: route.channel_type,
      thread_id: route.thread_id,
      content: JSON.stringify({
        action: 'gateway_confirmation_request',
        kind: parsed.data.kind,
        title: parsed.data.title,
        preview,
      }),
    });

    // Never print preview contents or the eventual token. They may contain
    // business values / a bearer capability.
    console.error(`[mcp-tools] gateway confirmation requested: ${confirmationId} (${parsed.data.kind})`);

    const deadline = Math.min(expiresAt, Date.now() + MAX_CONFIRMATION_WAIT_MS);
    while (Date.now() < deadline) {
      const response = findGatewayConfirmationResponse(confirmationId);
      if (response) {
        markCompleted([response.id]);
        let body: Record<string, unknown>;
        try {
          body = JSON.parse(response.content) as Record<string, unknown>;
        } catch {
          return err('malformed Host confirmation response');
        }
        const status = body.status;
        console.error(`[mcp-tools] gateway confirmation resolved: ${confirmationId} (${String(status)})`);
        if (status !== 'approved') {
          const code = typeof body.errorCode === 'string' ? body.errorCode : String(status);
          return err(`confirmation ${code}`);
        }
        // JSON is intentionally returned only across the private MCP tool
        // result. Host UI/event/audit paths never receive `confirmation`.
        return ok(
          JSON.stringify({
            status: 'approved',
            confirmationId,
            confirmation:
              parsed.data.kind === 'update' && typeof body.confirmation === 'string' ? body.confirmation : undefined,
            expiresAt: body.expiresAt,
            bindingHash: body.bindingHash,
            auditId: body.auditId,
          }),
        );
      }
      await sleep(500);
    }
    return err('confirmation expired or timed out');
  },
};

registerTools([gatewayRequestConfirmation]);
