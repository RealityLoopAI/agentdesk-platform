/**
 * Bounded operator backfill for verified legacy Feishu user conversations.
 *
 * Dry-run is the default. Stop the Host before using --execute so the central
 * database keeps its single-writer invariant.
 *
 *   pnpm exec tsx scripts/reconcile-feishu-conversations.ts \
 *     --user feishu:ou_xxx --provider-scope cli_xxx --actor operator-id
 *
 *   pnpm exec tsx scripts/reconcile-feishu-conversations.ts \
 *     --user feishu:ou_xxx --provider-scope cli_xxx --actor operator-id \
 *     --agent-group ag_xxx --limit 100 --execute
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { reconcileFeishuConversationLanes } from '../src/conversation-reconciliation.js';
import { DATA_DIR } from '../src/config.js';
import { closeDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getUserIdentitiesForUser } from '../src/db/user-identities.js';

export interface ReconcileFeishuConversationOptions {
  userId: string;
  providerScope: string;
  agentGroupId: string | null;
  actor: string;
  cursor: string | null;
  limit: number;
  execute: boolean;
  dbPath: string;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseReconcileFeishuConversationArgs(
  args: string[],
  defaultDbPath = path.join(DATA_DIR, 'v2.db'),
): ReconcileFeishuConversationOptions {
  const userId = valueAfter(args, '--user')?.trim();
  const providerScope = valueAfter(args, '--provider-scope')?.trim();
  const actor = valueAfter(args, '--actor')?.trim();
  if (!userId) throw new Error('--user is required and must be a canonical user id');
  if (!providerScope) throw new Error('--provider-scope is required and must match the Feishu app id');
  if (!actor) throw new Error('--actor is required for the audit trail');
  const rawLimit = valueAfter(args, '--limit');
  const limit = rawLimit === undefined ? 100 : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new Error('--limit must be an integer between 1 and 500');
  }
  return {
    userId,
    providerScope,
    actor,
    agentGroupId: valueAfter(args, '--agent-group')?.trim() || null,
    cursor: valueAfter(args, '--cursor')?.trim() || null,
    limit,
    execute: args.includes('--execute'),
    dbPath: valueAfter(args, '--db')?.trim() || defaultDbPath,
  };
}

export function reconcileFeishuConversations(options: ReconcileFeishuConversationOptions) {
  const db = initDb(options.dbPath);
  try {
    runMigrations(db);
    const identities = getUserIdentitiesForUser(options.userId).filter(
      (identity) =>
        identity.provider === 'feishu' &&
        identity.provider_scope === options.providerScope &&
        identity.identifier_type === 'open_id',
    );
    if (identities.length !== 1) {
      throw new Error('expected exactly one verified Feishu open_id for the requested user and provider scope');
    }
    return {
      executed: options.execute,
      ...reconcileFeishuConversationLanes({
        userId: options.userId,
        externalIdentityId: identities[0]!.id,
        actor: options.actor,
        trigger: 'operator',
        cursor: options.cursor,
        limit: options.limit,
        dryRun: !options.execute,
        agentGroupId: options.agentGroupId,
      }),
    };
  } finally {
    closeDb();
  }
}

function main(): void {
  try {
    const result = reconcileFeishuConversations(parseReconcileFeishuConversationArgs(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
    if (!result.executed) {
      console.error('dry-run only; add --execute after checking the candidate and conflict counts');
    }
    // CLI boundary: return a concise error without leaking a stack or DB path.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
