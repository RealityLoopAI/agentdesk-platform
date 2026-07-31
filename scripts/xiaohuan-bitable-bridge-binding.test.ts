import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { validateDeploymentBinding } from '../examples/xiaohuan-bitable-bridge/adapter.js';
import type { EnabledBridgeConfig } from '../examples/xiaohuan-bitable-bridge/config.js';
import { closeDb, getDb, initTestDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { createUserIdentity } from '../src/db/user-identities.js';

const NOW = '2026-07-31T00:00:00.000Z';

function bindingConfig(overrides: Partial<EnabledBridgeConfig> = {}): EnabledBridgeConfig {
  return {
    enabled: true,
    authenticatedUserId: 'canonical-alice',
    platformId: 'feishu:p2p:ou_alice',
    senderIdentity: {
      provider: 'feishu',
      providerScope: 'cli_app_a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    },
    feishuTranscriptMirrorEnabled: false,
    resource: 'pilot.records',
    fieldMap: { transcript: 'Transcript' },
    joinSeparator: ' | ',
    maxFieldValueBytes: 8_192,
    httpService: {
      bindHost: '127.0.0.1',
      port: 50_020,
      maxBodyBytes: 4 * 1024 * 1024,
      maxDurationMs: 20_000,
      expectedSampleRate: 16_000,
      maxQueue: 8,
      requestTimeoutMs: 10_000,
      keepUtterances: false,
    },
    audio: {
      ark: {
        baseUrl: 'https://ark.example.test/api/v3',
        apiKey: 'test-only-key',
        model: 'test-audio-model',
      },
      requestTimeoutMs: 60_000,
      maxWavBytes: 4 * 1024 * 1024,
      maxWavDurationMs: 20_000,
    },
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  db.exec(`
    INSERT INTO users (id, kind, display_name, created_at)
      VALUES
        ('canonical-alice', 'person', 'Alice', '${NOW}'),
        ('canonical-bob', 'person', 'Bob', '${NOW}');
    INSERT INTO agent_groups (id, name, folder, agent_provider, created_at, organization_id)
      VALUES ('ag-frontdesk', 'Frontdesk', 'frontdesk', NULL, '${NOW}', NULL);
    INSERT INTO messaging_groups
      (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
      VALUES
        ('mg-feishu-alice', 'feishu', 'feishu:p2p:ou_alice', 'Alice DM', 0, 'strict', '${NOW}');
    INSERT INTO messaging_group_agents
      (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
       sender_scope, ignored_message_policy, session_mode, priority, created_at)
      VALUES
        ('mga-frontdesk', 'mg-feishu-alice', 'ag-frontdesk', 'pattern', '.',
         'known', 'drop', 'per-user', 100, '${NOW}');
  `);
});

afterEach(() => {
  closeDb();
});

describe('Xiaohuan Bitable trusted deployment binding', () => {
  it('accepts only the exact Host-verified Feishu identity for the fixed P2P route', () => {
    createUserIdentity({
      userId: 'canonical-alice',
      provider: 'feishu',
      providerScope: 'cli_app_a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });

    expect(() => validateDeploymentBinding(bindingConfig())).not.toThrow();
  });

  it('fails closed when the identity is missing, belongs to another user, or does not match the route', () => {
    expect(() => validateDeploymentBinding(bindingConfig())).toThrowError(
      expect.objectContaining({ code: 'VERIFIED_FEISHU_IDENTITY_NOT_FOUND' }),
    );

    createUserIdentity({
      userId: 'canonical-bob',
      provider: 'feishu',
      providerScope: 'cli_app_a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    expect(() => validateDeploymentBinding(bindingConfig())).toThrowError(
      expect.objectContaining({ code: 'FEISHU_IDENTITY_USER_MISMATCH' }),
    );

    expect(() =>
      validateDeploymentBinding(
        bindingConfig({
          senderIdentity: {
            provider: 'feishu',
            providerScope: 'cli_app_a',
            identifierType: 'open_id',
            externalSubject: 'ou_other',
          },
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'FEISHU_IDENTITY_ROUTE_MISMATCH' }));
  });

  it('does not leak the verified external subject into audit details', () => {
    createUserIdentity({
      userId: 'canonical-alice',
      provider: 'feishu',
      providerScope: 'cli_app_a',
      identifierType: 'open_id',
      externalSubject: 'ou_alice',
    });
    validateDeploymentBinding(bindingConfig());

    const audit = getDb().prepare('SELECT details FROM enterprise_audit ORDER BY id').all() as Array<{
      details: string;
    }>;
    expect(JSON.stringify(audit)).not.toContain('ou_alice');
  });
});
