/**
 * Idempotently reconcile the optional Windows GUI worker topology.
 * Windows-specific desktop control remains isolated under examples/.
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
import {
  createDestination,
  deleteDestination,
  getDestinationByName,
} from '../../src/modules/agent-to-agent/db/agent-destinations.js';
import { writeDestinations } from '../../src/modules/agent-to-agent/write-destinations.js';
import { run as initEnterpriseTopology } from '../../scripts/init-enterprise-topology.js';

export const GUI_AGENT_BASE_URL = 'http://192.168.66.98:8000';
const WORKER_FOLDER = 'agentdesk-windows-gui-worker';
const GENERIC_WORKER_ALIAS = 'windows-gui-worker';
const GUI_ALIAS = 'gui';
const MANAGED_START = '<!-- windows-gui-agent:start -->';
const MANAGED_END = '<!-- windows-gui-agent:end -->';

function applyWorkerFiles(frontdeskFolder: string, workerFolder: string, workerId: string): void {
  const exampleDir = path.resolve(import.meta.dirname, 'agent-group');
  const workerDir = path.join(GROUPS_DIR, workerFolder);
  const workerPrompt = fs.readFileSync(path.join(exampleDir, 'CLAUDE.local.md'), 'utf8');
  const workerConfig = JSON.parse(fs.readFileSync(path.join(exampleDir, 'container.json'), 'utf8')) as ContainerConfig;
  const bridgeSource = path.join(exampleDir, 'gui-agent-mcp.ts');
  const bridgeTarget = path.join(workerDir, 'gui-agent-mcp.ts');
  const skillSource = path.join(exampleDir, 'skills', 'operate-windows-gui');
  const skillTarget = path.join(workerDir, 'skills', 'operate-windows-gui');

  workerConfig.agentGroupId = workerId;
  workerConfig.mcpServers.windows_gui.env = {
    ...workerConfig.mcpServers.windows_gui.env,
    GUI_AGENT_BASE_URL,
    NO_PROXY: '192.168.66.98',
    no_proxy: '192.168.66.98',
  };
  fs.mkdirSync(path.dirname(skillTarget), { recursive: true });
  fs.cpSync(skillSource, skillTarget, { recursive: true, force: true });
  fs.copyFileSync(bridgeSource, bridgeTarget);
  fs.writeFileSync(path.join(workerDir, 'CLAUDE.local.md'), workerPrompt);
  writeContainerConfig(workerFolder, workerConfig);

  const promptPath = path.join(GROUPS_DIR, frontdeskFolder, 'CLAUDE.local.md');
  const managed = `${MANAGED_START}
## Windows GUI worker routing

- \`gui\`: operator-specific Windows desktop specialist for observing and
  controlling applications through the configured accessibility service.
- Delegate only explicit desktop/application operation requests. Include the
  user's exact requested outcome and any application/window name they supplied.
- Keep credentials and unrelated conversation history out of the delegation.
- The GUI worker must obtain user confirmation before consequential actions;
  Frontdesk must faithfully relay that request to the original user.
${MANAGED_END}`;
  const current = fs
    .readFileSync(promptPath, 'utf8')
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
    throw new Error('Windows GUI topology bootstrap did not create the expected Frontdesk and Worker');
  }

  applyWorkerFiles(frontdesk.folder, worker.folder, worker.id);
  ensureDestination(frontdesk.id, GUI_ALIAS, worker.id);
  const generic = getDestinationByName(frontdesk.id, GENERIC_WORKER_ALIAS);
  if (generic) deleteDestination(frontdesk.id, GENERIC_WORKER_ALIAS);
  ensureDestination(worker.id, 'frontdesk', frontdesk.id);

  for (const group of [frontdesk, worker]) {
    for (const session of getSessionsByAgentGroup(group.id)) {
      if (session.status === 'active') writeDestinations(group.id, session.id);
    }
  }
  console.log(`Windows GUI worker ready: ${frontdesk.folder} -> ${GUI_ALIAS} -> ${worker.folder}`);
  closeDb();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => {
    closeDb();
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
