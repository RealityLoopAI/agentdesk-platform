import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createUserIdentity } from '../../db/user-identities.js';
import { extractAndUpsertUser } from './index.js';

function event(args: {
  senderId?: string;
  providerScope?: string;
  externalSubject?: string;
  identifierType?: string;
}): InboundEvent {
  return {
    channelType: 'feishu',
    platformId: 'oc_chat',
    threadId: null,
    message: {
      id: 'om_1',
      kind: 'chat',
      content: JSON.stringify({ senderId: args.senderId, senderName: 'Alice', text: 'hello' }),
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    senderIdentity:
      args.providerScope && args.externalSubject
        ? {
            provider: 'feishu',
            providerScope: args.providerScope,
            identifierType: args.identifierType ?? 'open_id',
            externalSubject: args.externalSubject,
          }
        : undefined,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('permissions sender resolver with federated identity', () => {
  it('uses adapter-trusted identity instead of a conflicting message-content senderId', () => {
    const resolved = extractAndUpsertUser(
      event({
        senderId: 'ou_forged_in_content',
        providerScope: 'app-a',
        externalSubject: 'ou_verified',
      }),
    );
    expect(resolved).toBe('feishu:ou_verified');
    expect(getDb().prepare('SELECT id FROM users ORDER BY id').all()).toEqual([{ id: 'feishu:ou_verified' }]);
  });

  it('resolves an existing identity to its canonical user even when that id is opaque', () => {
    getDb()
      .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, NULL, ?)')
      .run('usr-alice', 'person', '2026-01-01T00:00:00.000Z');
    createUserIdentity({
      userId: 'usr-alice',
      provider: 'feishu',
      providerScope: 'app-a',
      identifierType: 'open_id',
      externalSubject: 'ou_verified',
    });

    expect(
      extractAndUpsertUser(
        event({
          senderId: 'ou_verified',
          providerScope: 'app-a',
          externalSubject: 'ou_verified',
        }),
      ),
    ).toBe('usr-alice');
  });

  it('preserves the legacy content-based behavior for adapters without trusted identity metadata', () => {
    expect(extractAndUpsertUser(event({ senderId: 'ou_legacy' }))).toBe('feishu:ou_legacy');
  });
});
