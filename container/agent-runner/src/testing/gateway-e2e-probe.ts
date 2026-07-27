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
import { handleGatewayDescribe, handleGatewayExecute } from '../mcp-tools/gateway.js';
import { setRequestIdentity } from '../request-context.js';
import { rowIdentity } from '../request-identity.js';

function fail(message: string): never {
  console.error(`gateway-e2e-probe: ${message}`);
  process.exit(1);
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

  const executed = await handleGatewayExecute(runtime, {
    operation: 'feishu.bitable.record.list',
    input: { resource: 'e2e.contacts', pageSize: 20 },
    context: { purpose: 'container-a2a-gateway-e2e' },
    dryRun: true,
  });
  if (executed.isError) fail('gateway_execute returned an error');

  console.log(`gateway-e2e-probe: trusted user ${identity.userId}; describe + execute completed`);
}

main().catch((error) => fail(error instanceof Error ? (error.stack ?? error.message) : String(error)));
