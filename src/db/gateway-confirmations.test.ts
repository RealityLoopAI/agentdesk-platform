import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAgentGroup } from './agent-groups.js';
import { closeDb, getDb, initTestDb } from './connection.js';
import {
  claimGatewayConfirmation,
  createPendingGatewayConfirmation,
  expireDueGatewayConfirmations,
  getPendingGatewayConfirmation,
  resetIssuingGatewayConfirmationsAfterRestart,
} from './gateway-confirmations.js';
import { runMigrations } from './migrations/index.js';
import { createSession } from './sessions.js';

const now = new Date('2026-07-30T08:00:00.000Z');

function seed(): void {
  createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now.toISOString(),
  });
  getDb()
    .prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
    .run('feishu:ou_requester', 'feishu', 'Requester', now.toISOString());
  createSession({
    id: 'session-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    owner_user_id: 'feishu:ou_requester',
    root_session_id: 'session-1',
    conversation_lane_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'idle',
    last_active: now.toISOString(),
    created_at: now.toISOString(),
  });
}

function insert(expiresAt = new Date(now.getTime() + 60_000)): void {
  createPendingGatewayConfirmation({
    confirmationId: 'confirm-1',
    sessionId: 'session-1',
    messageOutId: 'confirm-1',
    kind: 'update',
    requesterUserId: 'feishu:ou_requester',
    agentGroupId: 'ag-1',
    conversationLaneId: null,
    channelType: 'feishu',
    platformId: 'feishu:p2p:ou_requester',
    threadId: null,
    confirmationRequest: 'opaque',
    displayJson: '{"recordId":"rec-1"}',
    title: 'Confirm',
    optionsJson: '[]',
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
  });
}

beforeEach(() => {
  runMigrations(initTestDb());
  seed();
});

afterEach(() => closeDb());

describe('Host-owned Gateway confirmation state', () => {
  it('persists the trusted actor/route and deduplicates the outbound intent', () => {
    insert();
    expect(getPendingGatewayConfirmation('confirm-1')).toMatchObject({
      requester_user_id: 'feishu:ou_requester',
      agent_group_id: 'ag-1',
      channel_type: 'feishu',
      status: 'pending',
    });
    expect(
      createPendingGatewayConfirmation({
        confirmationId: 'confirm-1',
        sessionId: 'session-1',
        messageOutId: 'confirm-1',
        kind: 'update',
        requesterUserId: 'feishu:ou_requester',
        agentGroupId: 'ag-1',
        conversationLaneId: null,
        channelType: 'feishu',
        platformId: 'forged-other-route',
        threadId: null,
        confirmationRequest: 'changed',
        displayJson: '{}',
        title: 'Changed',
        optionsJson: '[]',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + 60_000).toISOString(),
      }),
    ).toBe(false);
    expect(getPendingGatewayConfirmation('confirm-1')?.platform_id).toBe('feishu:p2p:ou_requester');
  });

  it('rejects cross-user and duplicate claims atomically', () => {
    insert();
    expect(claimGatewayConfirmation('confirm-1', 'feishu:ou_other', 'approve', now)).toEqual({
      ok: false,
      reason: 'actor_mismatch',
    });
    expect(claimGatewayConfirmation('confirm-1', 'feishu:ou_requester', 'approve', now).ok).toBe(true);
    expect(claimGatewayConfirmation('confirm-1', 'feishu:ou_requester', 'approve', now)).toEqual({
      ok: false,
      reason: 'already_resolved',
    });
  });

  it('expires due rows and recovers interrupted issuance after restart', () => {
    insert();
    expect(claimGatewayConfirmation('confirm-1', 'feishu:ou_requester', 'approve', now).ok).toBe(true);
    expect(resetIssuingGatewayConfirmationsAfterRestart(new Date(now.getTime() + 1_000))).toBe(1);
    expect(getPendingGatewayConfirmation('confirm-1')?.status).toBe('pending');
    expect(expireDueGatewayConfirmations(new Date(now.getTime() + 61_000))).toHaveLength(1);
    expect(getPendingGatewayConfirmation('confirm-1')?.status).toBe('expired');
  });
});
