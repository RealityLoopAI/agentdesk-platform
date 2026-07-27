import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb, initTestDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import {
  backfillLegacyFeishuOpenIds,
  createUserIdentity,
  getUserIdentitiesForUser,
  getUserIdentity,
  relinkUserIdentity,
  resolveOrCreateCanonicalUser,
  touchUserIdentity,
  UserIdentityConflictError,
} from './user-identities.js';

function seedUser(id: string, kind = 'feishu'): void {
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, ?)')
    .run(id, kind, '2026-01-01T00:00:00.000Z');
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('user identities', () => {
  it('keeps provider, scope and identifier type as separate identity axes', () => {
    seedUser('feishu:ou_alice');
    const base = {
      userId: 'feishu:ou_alice',
      externalSubject: 'ou_alice',
      verifiedAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    };

    createUserIdentity({
      ...base,
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
    });
    createUserIdentity({
      ...base,
      provider: 'feishu',
      providerScope: 'app-b',
      identifierType: 'open_id',
    });
    createUserIdentity({
      ...base,
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'union_id',
    });
    createUserIdentity({
      ...base,
      provider: 'example-idp',
      providerScope: 'app-a',
      identifierType: 'open_id',
    });

    expect(getUserIdentitiesForUser('feishu:ou_alice')).toHaveLength(4);
    const audit = JSON.stringify(
      getDb()
        .prepare("SELECT event_type, details FROM enterprise_audit WHERE event_type = 'user_identity_linked'")
        .all(),
    );
    expect(audit).not.toContain('externalSubject');
  });

  it('is idempotent for the same user, updates last seen and rejects cross-user conflicts', () => {
    seedUser('u-a');
    seedUser('u-b');
    const key = {
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_same',
    };
    const identity = createUserIdentity({
      ...key,
      userId: 'u-a',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    });
    const repeated = createUserIdentity({
      ...key,
      userId: 'u-a',
      lastSeenAt: '2026-02-01T00:00:00.000Z',
    });
    expect(repeated.id).toBe(identity.id);
    expect(repeated.last_seen_at).toBe('2026-02-01T00:00:00.000Z');

    expect(() => createUserIdentity({ ...key, userId: 'u-b' })).toThrow(UserIdentityConflictError);
    expect(getUserIdentity(key)?.user_id).toBe('u-a');

    expect(touchUserIdentity(identity.id, '2026-03-01T00:00:00.000Z')).toBe(true);
    expect(getUserIdentity(key)?.last_seen_at).toBe('2026-03-01T00:00:00.000Z');
  });

  it('resolves a verified identity to a canonical user and preserves a legacy user id', () => {
    seedUser('feishu:ou_existing');
    const userId = resolveOrCreateCanonicalUser({
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_existing',
      legacyUserId: 'feishu:ou_existing',
      userKind: 'feishu',
      displayName: 'Alice',
      seenAt: '2026-01-01T00:00:00.000Z',
    });
    expect(userId).toBe('feishu:ou_existing');
    expect(
      getUserIdentity({
        provider: 'feishu',
        providerScope: 'app-a',
        identifierType: 'open_id',
        externalSubject: 'ou_existing',
      })?.user_id,
    ).toBe('feishu:ou_existing');
    expect(getDb().prepare('SELECT display_name FROM users WHERE id = ?').get(userId)).toEqual({
      display_name: 'Alice',
    });
  });

  it('re-links only through the explicit audited path', () => {
    seedUser('u-old');
    seedUser('u-new');
    const identity = createUserIdentity({
      userId: 'u-old',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_move',
    });

    const moved = relinkUserIdentity({
      identityId: identity.id,
      expectedUserId: 'u-old',
      newUserId: 'u-new',
      actor: 'operator-1',
      reason: 'verified duplicate account',
      relinkedAt: '2026-02-01T00:00:00.000Z',
    });
    expect(moved.user_id).toBe('u-new');
    const audit = getDb()
      .prepare("SELECT actor, details FROM enterprise_audit WHERE event_type = 'user_identity_relinked'")
      .get() as { actor: string; details: string };
    expect(audit.actor).toBe('operator-1');
    expect(JSON.parse(audit.details)).toMatchObject({
      identityId: identity.id,
      previousUserId: 'u-old',
      newUserId: 'u-new',
      reason: 'verified duplicate account',
    });
  });

  it('backfills only unambiguous legacy Feishu open_id users without rewriting ids', () => {
    seedUser('feishu:ou_alice');
    seedUser('feishu:on_union');
    seedUser('feishu:ou_bad:extra');
    seedUser('telegram:ou_other', 'telegram');

    expect(backfillLegacyFeishuOpenIds('app-a')).toEqual({ linked: 1, alreadyLinked: 0 });
    expect(backfillLegacyFeishuOpenIds('app-a')).toEqual({ linked: 0, alreadyLinked: 1 });
    expect(getUserIdentitiesForUser('feishu:ou_alice')).toHaveLength(1);
    expect(getUserIdentitiesForUser('feishu:on_union')).toHaveLength(0);
    expect(getUserIdentitiesForUser('feishu:ou_bad:extra')).toHaveLength(0);
    expect(getUserIdentitiesForUser('telegram:ou_other')).toHaveLength(0);

    const ids = (getDb().prepare('SELECT id FROM users ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(ids).toEqual(['feishu:on_union', 'feishu:ou_alice', 'feishu:ou_bad:extra', 'telegram:ou_other']);
  });
});
