import { randomUUID } from 'node:crypto';

import type { UserIdentity } from '../types.js';
import { getDb } from './connection.js';
import { recordEnterpriseAudit } from './enterprise-audit.js';

export interface UserIdentityKey {
  provider: string;
  providerScope: string;
  identifierType: string;
  externalSubject: string;
}

export interface CreateUserIdentityInput extends UserIdentityKey {
  userId: string;
  verifiedAt?: string;
  lastSeenAt?: string;
  actor?: string | null;
  auditEvent?: string;
}

export interface ResolveUserIdentityInput extends UserIdentityKey {
  legacyUserId: string;
  userKind: string;
  displayName?: string | null;
  verifiedAt?: string;
  seenAt?: string;
}

export class UserIdentityConflictError extends Error {
  constructor(
    readonly key: UserIdentityKey,
    readonly existingUserId: string,
    readonly requestedUserId: string,
  ) {
    super('External identity is already linked to a different canonical user');
    this.name = 'UserIdentityConflictError';
  }
}

function normalizeKey(key: UserIdentityKey): UserIdentityKey {
  const normalized = {
    provider: key.provider.trim(),
    providerScope: key.providerScope.trim(),
    identifierType: key.identifierType.trim(),
    externalSubject: key.externalSubject.trim(),
  };
  if (!normalized.provider || !normalized.providerScope || !normalized.identifierType || !normalized.externalSubject) {
    throw new Error('User identity provider, scope, identifier type and external subject are required');
  }
  return normalized;
}

export function getUserIdentity(key: UserIdentityKey): UserIdentity | undefined {
  const normalized = normalizeKey(key);
  return getDb()
    .prepare(
      `SELECT * FROM user_identities
       WHERE provider = ? AND provider_scope = ?
         AND identifier_type = ? AND external_subject = ?`,
    )
    .get(normalized.provider, normalized.providerScope, normalized.identifierType, normalized.externalSubject) as
    | UserIdentity
    | undefined;
}

export function getUserIdentityById(id: string): UserIdentity | undefined {
  return getDb().prepare('SELECT * FROM user_identities WHERE id = ?').get(id) as UserIdentity | undefined;
}

export function getUserIdentitiesForUser(userId: string): UserIdentity[] {
  return getDb()
    .prepare(
      `SELECT * FROM user_identities
       WHERE user_id = ?
       ORDER BY provider, provider_scope, identifier_type, created_at`,
    )
    .all(userId) as UserIdentity[];
}

export function touchUserIdentity(id: string, lastSeenAt: string = new Date().toISOString()): boolean {
  return getDb().prepare('UPDATE user_identities SET last_seen_at = ? WHERE id = ?').run(lastSeenAt, id).changes > 0;
}

/**
 * Link a verified external identity to a canonical user.
 *
 * Idempotent for the same canonical user. If the identity is already owned by
 * another user, fail closed rather than silently merging authorization state.
 */
export function createUserIdentity(input: CreateUserIdentityInput): UserIdentity {
  const key = normalizeKey(input);
  const db = getDb();
  const now = input.lastSeenAt ?? new Date().toISOString();
  const verifiedAt = input.verifiedAt ?? now;

  return db.transaction(() => {
    const existing = getUserIdentity(key);
    if (existing) {
      if (existing.user_id !== input.userId) {
        throw new UserIdentityConflictError(key, existing.user_id, input.userId);
      }
      touchUserIdentity(existing.id, now);
      return { ...existing, last_seen_at: now };
    }

    const row: UserIdentity = {
      id: `uid-${randomUUID()}`,
      user_id: input.userId,
      provider: key.provider,
      provider_scope: key.providerScope,
      identifier_type: key.identifierType,
      external_subject: key.externalSubject,
      verified_at: verifiedAt,
      created_at: now,
      last_seen_at: now,
    };
    db.prepare(
      `INSERT INTO user_identities
         (id, user_id, provider, provider_scope, identifier_type,
          external_subject, verified_at, created_at, last_seen_at)
       VALUES
         (@id, @user_id, @provider, @provider_scope, @identifier_type,
          @external_subject, @verified_at, @created_at, @last_seen_at)`,
    ).run(row);
    recordEnterpriseAudit({
      eventType: input.auditEvent ?? 'user_identity_linked',
      actor: input.actor ?? null,
      details: {
        identityId: row.id,
        userId: row.user_id,
        provider: row.provider,
        providerScope: row.provider_scope,
        identifierType: row.identifier_type,
      },
    });
    return row;
  })();
}

/**
 * Resolve an adapter-verified identity to its canonical user, creating the
 * legacy-compatible canonical row and mapping atomically on first sight.
 */
export function resolveOrCreateCanonicalUser(input: ResolveUserIdentityInput): string {
  const key = normalizeKey(input);
  const db = getDb();
  const seenAt = input.seenAt ?? new Date().toISOString();

  return db.transaction(() => {
    const existing = getUserIdentity(key);
    if (existing) {
      touchUserIdentity(existing.id, seenAt);
      if (input.displayName) {
        db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(input.displayName, existing.user_id);
      }
      return existing.user_id;
    }

    db.prepare(
      `INSERT INTO users (id, kind, display_name, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, users.display_name)`,
    ).run(input.legacyUserId, input.userKind, input.displayName ?? null, seenAt);

    createUserIdentity({
      userId: input.legacyUserId,
      ...key,
      verifiedAt: input.verifiedAt ?? seenAt,
      lastSeenAt: seenAt,
    });
    return input.legacyUserId;
  })();
}

/**
 * Move an existing identity to another canonical user.
 *
 * This is intentionally a separate, explicitly audited operator operation;
 * normal login/channel resolution must never call it to "fix" a conflict.
 */
export function relinkUserIdentity(args: {
  identityId: string;
  expectedUserId: string;
  newUserId: string;
  actor: string;
  reason: string;
  relinkedAt?: string;
}): UserIdentity {
  const db = getDb();
  return db.transaction(() => {
    const existing = getUserIdentityById(args.identityId);
    if (!existing) throw new Error('User identity does not exist');
    if (existing.user_id !== args.expectedUserId) {
      throw new Error('User identity owner changed; refusing stale re-link');
    }
    if (!args.actor.trim() || !args.reason.trim()) {
      throw new Error('Identity re-link requires an actor and reason');
    }
    if (existing.user_id === args.newUserId) return existing;

    const changedAt = args.relinkedAt ?? new Date().toISOString();
    db.prepare('UPDATE user_identities SET user_id = ?, verified_at = ?, last_seen_at = ? WHERE id = ?').run(
      args.newUserId,
      changedAt,
      changedAt,
      args.identityId,
    );
    recordEnterpriseAudit({
      eventType: 'user_identity_relinked',
      actor: args.actor,
      details: {
        identityId: args.identityId,
        previousUserId: existing.user_id,
        newUserId: args.newUserId,
        provider: existing.provider,
        providerScope: existing.provider_scope,
        identifierType: existing.identifier_type,
        reason: args.reason,
      },
    });
    return getUserIdentityById(args.identityId)!;
  })();
}

/**
 * Safe brownfield backfill for legacy deterministic Feishu users.
 *
 * Only `kind='feishu'` rows whose ids are unambiguously `feishu:ou_*`
 * (Feishu open_id form) are linked. Existing user ids and every foreign key
 * remain untouched.
 */
export function backfillLegacyFeishuOpenIds(
  providerScope: string,
  actor: string | null = null,
): { linked: number; alreadyLinked: number } {
  const scope = providerScope.trim();
  if (!scope) throw new Error('Feishu provider scope is required for identity backfill');

  const db = getDb();
  return db.transaction(() => {
    const users = db
      .prepare(
        `SELECT id FROM users
         WHERE kind = 'feishu'
           AND id GLOB 'feishu:ou_*'
           AND length(id) > length('feishu:ou_')
           AND instr(substr(id, length('feishu:') + 1), ':') = 0
         ORDER BY id`,
      )
      .all() as Array<{ id: string }>;

    let linked = 0;
    let alreadyLinked = 0;
    for (const user of users) {
      const externalSubject = user.id.slice('feishu:'.length);
      const existing = getUserIdentity({
        provider: 'feishu',
        providerScope: scope,
        identifierType: 'open_id',
        externalSubject,
      });
      if (existing) {
        if (existing.user_id !== user.id) {
          throw new UserIdentityConflictError(
            {
              provider: 'feishu',
              providerScope: scope,
              identifierType: 'open_id',
              externalSubject,
            },
            existing.user_id,
            user.id,
          );
        }
        alreadyLinked += 1;
        continue;
      }
      createUserIdentity({
        userId: user.id,
        provider: 'feishu',
        providerScope: scope,
        identifierType: 'open_id',
        externalSubject,
        actor,
        auditEvent: 'user_identity_backfilled',
      });
      linked += 1;
    }
    return { linked, alreadyLinked };
  })();
}
