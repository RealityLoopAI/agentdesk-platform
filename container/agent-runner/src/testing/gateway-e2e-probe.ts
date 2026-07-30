/**
 * Real-container Gateway probe used by scripts/e2e-container-a2a-gateway.ts.
 *
 * It runs inside the same image and mounts as an Agent Runner, reconstructs
 * RequestIdentity from the Host-written worker inbound row, then calls the
 * production Gateway MCP handlers. Those handlers write their normal
 * `gateway_audit` system messages to outbound.db for the Host to consume.
 */
import { loadConfig } from '../config.js';
import { openInboundDb } from '../db/connection.js';
import type { MessageInRow } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { handleGatewayDescribe, handleGatewayExecute } from '../mcp-tools/gateway.js';
import { setRequestIdentity } from '../request-context.js';
import { rowIdentity } from '../request-identity.js';

function fail(message: string): never {
  console.error(`gateway-e2e-probe: ${message}`);
  process.exit(1);
}

function toolJson(result: Awaited<ReturnType<typeof handleGatewayExecute>>): Record<string, unknown> {
  const item = result.content[0];
  if (!item || item.type !== 'text') fail('gateway tool did not return text');
  try {
    return JSON.parse(item.text) as Record<string, unknown>;
  } catch {
    return fail('gateway tool returned malformed JSON');
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.backendGateway) fail('container.json does not declare backendGateway');

  const inbound = openInboundDb();
  let row: MessageInRow | undefined;
  try {
    row = inbound
      .prepare(
        `SELECT * FROM messages_in
         WHERE kind IN ('chat', 'chat-sdk')
         ORDER BY seq DESC LIMIT 1`,
      )
      .get() as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
  if (!row) fail('worker inbound.db has no chat row');

  const identity = rowIdentity(row);
  if (identity.source !== 'session' || !identity.userId) {
    fail(`worker RequestIdentity is not Host-trusted: ${JSON.stringify(identity)}`);
  }
  setRequestIdentity(identity);

  const runtime = {
    assistantName: config.assistantName,
    groupName: config.groupName,
    agentGroupId: config.agentGroupId,
    backendGateway: config.backendGateway,
  };
  const described = await handleGatewayDescribe(runtime, {});
  if (described.isError) fail('gateway_describe returned an error');

  const createArgs = {
    operation: 'feishu.bitable.record.create',
    input: { resource: 'e2e.contacts', fields: { Name: 'Container A2A E2E' } },
    context: { purpose: 'container-a2a-gateway-e2e' },
    dryRun: false,
    idempotencyKey: 'container-a2a-stable-create',
  };
  const executed = await handleGatewayExecute(runtime, createArgs);
  if (executed.isError) fail('first gateway_execute returned an error');
  const replayed = await handleGatewayExecute(runtime, createArgs);
  if (replayed.isError) fail('replayed gateway_execute returned an error');

  const previewed = await handleGatewayExecute(runtime, {
    operation: 'feishu.bitable.record.update',
    input: {
      resource: 'e2e.contacts',
      recordId: 'rec-e2e-created',
      fields: { Status: 'Confirmed' },
    },
    context: { purpose: 'container-a2a-gateway-confirmation-e2e' },
    dryRun: true,
  });
  if (previewed.isError) fail('update dry-run returned an error');
  const previewBody = toolJson(previewed);
  const preview = previewBody.preview;
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) {
    fail('update dry-run omitted preview');
  }

  // The real gateway_request_confirmation tool writes this same system action
  // before blocking. This probe exits after enqueue so the outer Host harness
  // can consume, approve and assert the private response deterministically.
  writeMessageOut({
    id: 'container-a2a-update-confirmation',
    in_reply_to: row.id,
    kind: 'system',
    platform_id: row.platform_id,
    channel_type: row.channel_type,
    thread_id: row.thread_id,
    content: JSON.stringify({
      action: 'gateway_confirmation_request',
      kind: 'update',
      title: 'E2E update confirmation',
      preview,
    }),
  });

  const deletePreviewed = await handleGatewayExecute(runtime, {
    operation: 'feishu.bitable.record.delete',
    input: {
      resource: 'e2e.contacts',
      recordId: 'rec-e2e-created',
    },
    context: { purpose: 'container-a2a-gateway-delete-confirmation-e2e' },
    dryRun: true,
  });
  if (deletePreviewed.isError) fail('delete dry-run returned an error');
  const deletePreviewBody = toolJson(deletePreviewed);
  const deletePreview = deletePreviewBody.preview;
  if (!deletePreview || typeof deletePreview !== 'object' || Array.isArray(deletePreview)) {
    fail('delete dry-run omitted preview');
  }
  writeMessageOut({
    id: 'container-a2a-delete-confirmation',
    in_reply_to: row.id,
    kind: 'system',
    platform_id: row.platform_id,
    channel_type: row.channel_type,
    thread_id: row.thread_id,
    content: JSON.stringify({
      action: 'gateway_confirmation_request',
      kind: 'delete',
      title: 'E2E delete confirmation',
      preview: deletePreview,
    }),
  });

  console.log(
    `gateway-e2e-probe: trusted user ${identity.userId}; describe + idempotent create + update/delete previews completed`,
  );
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
