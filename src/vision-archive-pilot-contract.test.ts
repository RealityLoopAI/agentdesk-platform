import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const pilotDir = path.resolve(process.cwd(), 'examples/vision-archive-pilot/agent-group');

describe('Vision Archive pilot contract', () => {
  it('selects GLM only through the per-group model override', () => {
    const config = JSON.parse(fs.readFileSync(path.join(pilotDir, 'container.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(config.provider).toBe('openai');
    expect(config.providerModel).toBe('glm-5.2');
    expect(config).not.toHaveProperty('env.OPENAI_MODEL');
    expect(JSON.stringify(config)).not.toContain('OPENAI_API_KEY');
    expect(JSON.stringify(config)).not.toContain('OPENAI_BASE_URL');
  });

  it('contains no example archive result fields and requires turn-local evidence', () => {
    const instructions = fs.readFileSync(path.join(pilotDir, 'skills/vision-archive-query/instructions.md'), 'utf8');
    for (const seededField of [
      'experiment_id',
      'experiment_name',
      'processed_at',
      'total_keyframes',
      'total_detections',
      'duration_seconds',
      'cameras_summary',
    ]) {
      expect(instructions).not.toContain(seededField);
    }
    expect(instructions).toContain('current user request');
    expect(instructions).toContain('successful Gateway tool result');
  });
});
