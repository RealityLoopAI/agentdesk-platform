/**
 * Audited Web-session revocation for offboarding and unified-messaging rollback.
 *
 * The command is dry-run unless --execute is present. Run it only while the
 * Host is stopped so the central DB keeps one active writer.
 *
 *   pnpm exec tsx scripts/revoke-web-sessions.ts \
 *     --all --actor operator-id --reason unified-messaging-rollback
 *
 *   pnpm exec tsx scripts/revoke-web-sessions.ts \
 *     --all --actor operator-id --reason unified-messaging-rollback --execute
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { DATA_DIR } from '../src/config.js';
import { closeDb, getDb, initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { revokeAllWebAuthSessionsForUser } from '../src/db/web-auth.js';

export interface RevokeWebSessionOptions {
  scope: { type: 'all' } | { type: 'user'; userId: string };
  actor: string;
  reason: string;
  execute: boolean;
  dbPath: string;
}

function valueAfter(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function parseRevokeWebSessionArgs(
  args: string[],
  defaultDbPath = path.join(DATA_DIR, 'v2.db'),
): RevokeWebSessionOptions {
  const all = args.includes('--all');
  const userId = valueAfter(args, '--user')?.trim();
  if (all === Boolean(userId)) {
    throw new Error('choose exactly one scope: --all or --user <canonical-user-id>');
  }
  const actor = valueAfter(args, '--actor')?.trim();
  const reason = valueAfter(args, '--reason')?.trim();
  if (!actor) throw new Error('--actor is required for the audit trail');
  if (!reason) throw new Error('--reason is required for the audit trail');
  const dbPath = valueAfter(args, '--db')?.trim() || defaultDbPath;
  return {
    scope: all ? { type: 'all' } : { type: 'user', userId: userId! },
    actor,
    reason,
    execute: args.includes('--execute'),
    dbPath,
  };
}

export function revokeWebSessions(options: RevokeWebSessionOptions): {
  candidateUsers: string[];
  revokedSessions: number;
  executed: boolean;
} {
  const db = initDb(options.dbPath);
  try {
    runMigrations(db);
    const candidateUsers =
      options.scope.type === 'all'
        ? (
            getDb()
              .prepare(
                `SELECT DISTINCT user_id
                 FROM web_auth_sessions
                 WHERE revoked_at IS NULL
                 ORDER BY user_id`,
              )
              .all() as Array<{ user_id: string }>
          ).map((row) => row.user_id)
        : [options.scope.userId];
    if (!options.execute) {
      return { candidateUsers, revokedSessions: 0, executed: false };
    }
    let revokedSessions = 0;
    for (const userId of candidateUsers) {
      revokedSessions += revokeAllWebAuthSessionsForUser({
        userId,
        actor: options.actor,
        reason: options.reason,
      });
    }
    return { candidateUsers, revokedSessions, executed: true };
  } finally {
    closeDb();
  }
}

function main(): void {
  try {
    const options = parseRevokeWebSessionArgs(process.argv.slice(2));
    const result = revokeWebSessions(options);
    console.log(JSON.stringify(result, null, 2));
    if (!result.executed) {
      console.error('dry-run only; add --execute after checking the candidate user list');
    }
    // CLI boundary: convert every validation/DB failure into a non-zero exit
    // without exposing an unhandled stack trace that may contain local paths.
    // eslint-disable-next-line no-catch-all/no-catch-all
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
