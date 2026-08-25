/**
 * Idempotently reconcile the optional Vision Archive pilot topology.
 * Business-specific prompts and topology remain under examples/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_FRONTDESK_FOLDER } from '../../src/branding.js';
import { GROUPS_DIR } from '../../src/config.js';
import { readContainerConfig, writeContainerConfig, type ContainerConfig } from '../../src/container-config.js';
import { getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { closeDb } from '../../src/db/connection.js';
import { getSessionsByAgentGroup } from '../../src/db/sessions.js';
import { readEnvFile } from '../../src/env.js';
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
} from '../../src/modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../../src/modules/agent-to-agent/write-destinations.js';
import { run as initEnterpriseTopology } from '../../scripts/init-enterprise-topology.js';

const WORKER_FOLDER = 'agentdesk-vision-archive-worker';
const GENERIC_WORKER_ALIAS = 'vision-archive-worker';
const PILOT_ALIAS = 'archive';
const MANAGED_START = '<!-- vision-archive-pilot:start -->';
const MANAGED_END = '<!-- vision-archive-pilot:end -->';

function gatewaySigningKey(workerFolder: string): string {
  const dotenv = readEnvFile(['GATEWAY_SIGNING_KEY']);
  const key = process.env.GATEWAY_SIGNING_KEY?.trim() || dotenv.GATEWAY_SIGNING_KEY?.trim();
  if (key) return key;
  const existing = readContainerConfig(workerFolder).backendGateway?.signingKey?.trim();
  if (existing) return existing;
  throw new Error('Vision Archive pilot requires a dedicated GATEWAY_SIGNING_KEY');
}

function applyPilotFiles(frontdeskFolder: string, workerFolder: string, workerId: string): void {
  const exampleDir = path.resolve(import.meta.dirname, 'agent-group');
  const workerDir = path.join(GROUPS_DIR, workerFolder);
  const workerPrompt = fs.readFileSync(path.join(exampleDir, 'CLAUDE.local.md'), 'utf8');
  const workerConfig = JSON.parse(fs.readFileSync(path.join(exampleDir, 'container.json'), 'utf8')) as ContainerConfig;
  const skillSource = path.join(exampleDir, 'skills', 'vision-archive-query');
  const skillTarget = path.join(workerDir, 'skills', 'vision-archive-query');
  fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
  fs.cpSync(skillSource, skillTarget, { recursive: true, force: true });
  workerConfig.agentGroupId = workerId;
  workerConfig.backendGateway = {
    ...workerConfig.backendGateway!,
    signingKey: gatewaySigningKey(workerFolder),
  };
  fs.writeFileSync(path.join(workerDir, 'CLAUDE.local.md'), workerPrompt);
  writeContainerConfig(workerFolder, workerConfig);

  const promptPath = path.join(GROUPS_DIR, frontdeskFolder, 'CLAUDE.local.md');
  const managed = `${MANAGED_START}
## Vision Archive pilot routing

- \`archive\`: read-only specialist for experiment archives, dates, key frames,
  key clips, professional reports, structured archive data, and file discovery.
- Classify the user's intent first. Delegate only archive-related requests to
  \`archive\`, with the minimum context needed for that request.
- Keep unrelated Bitable and other specialist requests on their existing
  destinations.
- Do not claim archive availability before the Worker completes Gateway
  discovery and authorization.
${MANAGED_END}`;
  const current = fs
    .readFileSync(promptPath, 'utf8')
    .replace(/^- `vision-archive-worker`:.*\n?/m, '')
    .replace(new RegExp(`${MANAGED_START}[\\s\\S]*?${MANAGED_END}\\n?`, 'g'), '')
    .trimEnd();
  fs.writeFileSync(promptPath, `${current}\n\n${managed}\n`);
}

function ensureDestination(sourceId: string, name: string, targetId: string): void {
  const existing = getDestinationByName(sourceId, name);
  if (existing && (existing.target_type !== 'agent' || existing.target_id !== targetId)) {
    throw new Error(`Destination "${name}" is already assigned to a different target`);
  }
  if (!existing) {
    createDestination({
      agent_group_id: sourceId,
      local_name: name,
      target_type: 'agent',
      target_id: targetId,
      created_at: new Date().toISOString(),
    });
  }
}

export async function run(): Promise<void> {
  await initEnterpriseTopology(['--workers', GENERIC_WORKER_ALIAS]);
  const frontdesk = getAgentGroupByFolder(DEFAULT_FRONTDESK_FOLDER);
  const worker = getAgentGroupByFolder(WORKER_FOLDER);
  if (!frontdesk || !worker) {
    throw new Error('Vision Archive topology bootstrap did not create the expected Frontdesk and Worker');
  }

  applyPilotFiles(frontdesk.folder, worker.folder, worker.id);
  ensureDestination(frontdesk.id, PILOT_ALIAS, worker.id);
  const generic = getDestinationByName(frontdesk.id, GENERIC_WORKER_ALIAS);
  if (generic) deleteDestination(frontdesk.id, GENERIC_WORKER_ALIAS);
  ensureDestination(worker.id, 'frontdesk', frontdesk.id);

  for (const group of [frontdesk, worker]) {
    for (const session of getSessionsByAgentGroup(group.id)) {
      if (session.status === 'active') writeDestinations(group.id, session.id);
    }
  }
  console.log(`Vision Archive pilot ready: ${frontdesk.folder} -> ${PILOT_ALIAS} -> ${worker.folder}`);
  closeDb();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => {
    closeDb();
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
