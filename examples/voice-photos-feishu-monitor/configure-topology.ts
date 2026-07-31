import fs from 'node:fs';
import path from 'node:path';

import { readContainerConfig, writeContainerConfig } from '../../src/container-config.js';
import { DATA_DIR, GROUPS_DIR } from '../../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { initDb } from '../../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
  updateMessagingGroupAgent,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { initGroupFilesystem } from '../../src/group-init.js';
import { addMember } from '../../src/modules/permissions/db/agent-group-members.js';
import { getUser } from '../../src/modules/permissions/db/users.js';
import type { AgentGroup, MessagingGroup } from '../../src/types.js';
import { VOICE_PHOTO_JSON_CHANNEL_TYPE } from './json-adapter.js';

function id(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index >= 0 ? process.argv[index + 1]?.trim() : fallback;
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function main(): void {
  const platformId = argument('platform-id', 'voice-photo-json:realityloop');
  const userId = argument('user-id');
  const folder = argument('folder', 'voice-photo-json-bitable-worker');
  const gatewayTemplateFolder = argument('gateway-template-folder', 'agentdesk-bitable-worker');
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);
  if (!getUser(userId)) throw new Error(`canonical user does not exist: ${userId}`);
  const now = new Date().toISOString();
  let agent: AgentGroup | undefined = getAgentGroupByFolder(folder);
  if (!agent) {
    createAgentGroup({
      id: id('ag'),
      name: 'Voice Photo JSON Bitable Worker',
      folder,
      agent_provider: null,
      created_at: now,
    });
    agent = getAgentGroupByFolder(folder)!;
  }
  const instructions = fs.readFileSync(new URL('./agent-group/AGENTS.md', import.meta.url), 'utf8');
  initGroupFilesystem(agent, { instructions });
  fs.writeFileSync(path.join(GROUPS_DIR, agent.folder, 'CLAUDE.local.md'), `${instructions.trimEnd()}\n`);
  const gatewayTemplate = readContainerConfig(gatewayTemplateFolder);
  if (!gatewayTemplate.backendGateway) {
    throw new Error(`gateway template group has no Backend Gateway configuration: ${gatewayTemplateFolder}`);
  }
  const workerConfig = readContainerConfig(agent.folder);
  writeContainerConfig(agent.folder, {
    ...workerConfig,
    provider: gatewayTemplate.provider ?? 'openai',
    model: gatewayTemplate.model,
    backendGateway: gatewayTemplate.backendGateway,
    memoryMode: 'gateway',
    agentGroupId: agent.id,
    groupName: agent.name,
    assistantName: agent.name,
  });
  addMember({
    user_id: userId,
    agent_group_id: agent.id,
    added_by: userId,
    added_at: now,
  });

  let messagingGroup: MessagingGroup | undefined = getMessagingGroupByPlatform(
    VOICE_PHOTO_JSON_CHANNEL_TYPE,
    platformId,
  );
  if (!messagingGroup) {
    messagingGroup = {
      id: id('mg'),
      channel_type: VOICE_PHOTO_JSON_CHANNEL_TYPE,
      platform_id: platformId,
      name: 'Voice Photo JSON machine ingress',
      is_group: 0,
      unknown_sender_policy: 'deny',
      created_at: now,
    };
    createMessagingGroup(messagingGroup);
  }
  const existingWiring = getMessagingGroupAgentByPair(messagingGroup.id, agent.id);
  if (!existingWiring) {
    createMessagingGroupAgent({
      id: id('mga'),
      messaging_group_id: messagingGroup.id,
      agent_group_id: agent.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-user-per-thread',
      priority: 0,
      created_at: now,
    });
  } else {
    updateMessagingGroupAgent(existingWiring.id, {
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-user-per-thread',
      priority: 0,
    });
  }
  console.log(
    JSON.stringify({ ok: true, userId, platformId, agentGroupId: agent.id, messagingGroupId: messagingGroup.id }),
  );
}

main();
