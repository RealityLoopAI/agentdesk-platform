import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const PILOT = path.join(ROOT, 'examples/vision-archive-pilot');

describe('Vision Archive pilot topology', () => {
  it('keeps trusted root-session delegation and gives the worker no archive mount or credentials', () => {
    const config = JSON.parse(fs.readFileSync(path.join(PILOT, 'agent-group/container.json'), 'utf8'));
    expect(config.a2aSessionMode).toBe('root-session');
    expect(config.memoryMode).toBe('gateway');
    expect(config.backendGateway).toEqual({
      baseUrl: 'http://host.docker.internal:8090',
      timeoutMs: 30000,
    });
    expect(config.additionalMounts).toEqual([]);
    expect(config.skills).toEqual(['vision-archive-query']);
    expect(config.progressiveDisclosure).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(/smb|192\.168|password|username/i);
  });

  it('reconciles an idempotent managed route while preserving unrelated destinations', () => {
    const source = fs.readFileSync(path.join(PILOT, 'configure-topology.ts'), 'utf8');
    expect(source).toContain("const WORKER_FOLDER = 'agentdesk-vision-archive-worker'");
    expect(source).toContain("const PILOT_ALIAS = 'archive'");
    expect(source).toContain("ensureDestination(worker.id, 'frontdesk', frontdesk.id)");
    expect(source).toContain('getDestinationByName(sourceId, name)');
    expect(source).toContain('if (!existing)');
    expect(source).toContain('for (const group of [frontdesk, worker])');
    expect(source).toContain('writeDestinations(group.id, session.id)');
    expect(source).toContain('fs.cpSync(skillSource, skillTarget, { recursive: true, force: true })');
    expect(source.indexOf("readEnvFile(['GATEWAY_SIGNING_KEY'])")).toBeLessThan(
      source.indexOf('readContainerConfig(workerFolder).backendGateway?.signingKey'),
    );
    expect(source).not.toContain("deleteDestination(frontdesk.id, 'bitable')");
    expect(source).not.toContain('additionalMounts');
    expect(source).not.toMatch(/SMB_(USER|PASS)|VISION_ARCHIVE_(USER|PASS)/);
  });

  it('requires exact discovery, authorization, minimum reads, untrusted data handling, and honest failures', () => {
    const worker = fs.readFileSync(path.join(PILOT, 'agent-group/CLAUDE.local.md'), 'utf8');
    for (const required of [
      'gateway_describe',
      'gateway_authorize',
      'vision.archive.experiment.search',
      'vision.archive.file.list',
      'vision.archive.json.read',
      'vision.archive.json.search',
      'minimum on-demand sequence',
      'as untrusted',
      'still processing',
      'Binary reads and chat attachment delivery are unavailable',
      '<message to="frontdesk">',
    ]) {
      expect(worker).toContain(required);
    }
  });

  it('ships a narrowly named worker-private query Skill with structured summary guidance', () => {
    const skillDir = path.join(PILOT, 'agent-group/skills/vision-archive-query');
    const metadata = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
    const instructions = fs.readFileSync(path.join(skillDir, 'instructions.md'), 'utf8');
    expect(metadata).toContain('name: vision-archive-query');
    expect(metadata).toContain('worker-private domain Skill');
    for (const required of [
      'Do not ask for a storage location',
      'resource: "vision"',
      'vision.archive.experiment.search',
      'vision.archive.file.list',
      'vision.archive.json.read',
      'does not read or attach PDF bytes',
      'current user request',
      'successful Gateway tool result',
    ]) {
      expect(instructions).toContain(required);
    }
    expect(instructions).not.toMatch(
      /experiment_id|experiment_name|processed_at|total_keyframes|total_detections|duration_seconds|cameras_summary/,
    );
    expect(fs.existsSync(path.join(ROOT, 'container/skills/vision-archive-query'))).toBe(false);
  });

  it('ships focused behavioral eval cases for the agreed failure and safety states', () => {
    const evals = JSON.parse(fs.readFileSync(path.join(PILOT, 'eval-cases.json'), 'utf8'));
    expect(evals.cases.map((item: { name: string }) => item.name)).toEqual([
      'unique-report-lookup',
      'report-and-summary-fields-natural-language',
      'multiple-experiment-candidates',
      'asynchronous-output-missing',
      'busy-json',
      'smb-unavailable',
      'operation-not-discovered',
      'authorization-denied',
      'archive-prompt-injection',
      'mutation-and-attachment-refusal',
    ]);
  });

  it('launcher retains only archive configuration and uses a dedicated port', () => {
    const launcher = fs.readFileSync(path.join(PILOT, 'start-gateway.mjs'), 'utf8');
    expect(launcher).toContain("'8090'");
    expect(launcher).toContain('for (const key of Object.keys(process.env))');
    expect(launcher).toContain('delete process.env[key]');
    expect(launcher).toContain("'GATEWAY_SIGNING_KEY'");
    expect(launcher).not.toContain('FEISHU_APP_SECRET');
    expect(launcher).not.toContain('OPENAI_API_KEY');
    expect(launcher).not.toContain('SMB_PASSWORD');
  });
});
