import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('Bitable pilot topology', () => {
  it('keeps the worker on the root session lane and points it at the host Gateway', () => {
    const config = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'examples/bitable-pilot/agent-group/container.json'), 'utf8'),
    );

    expect(config.a2aSessionMode).toBe('root-session');
    expect(config.memoryMode).toBe('gateway');
    expect(config.provider).toBe('openai');
    expect(config.backendGateway).toEqual({
      baseUrl: 'http://host.docker.internal:8088',
      timeoutMs: 30000,
    });
    expect(config.resources).toEqual({ memoryMb: 1024, cpus: 1, pidsLimit: 512 });
  });

  it('routes through Frontdesk and makes discovery, confirmation, and write limits explicit', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'examples/bitable-pilot/agent-group/CLAUDE.local.md'), 'utf8');
    const reconciler = fs.readFileSync(path.join(ROOT, 'examples/bitable-pilot/configure-topology.ts'), 'utf8');

    expect(worker).toContain('gateway_describe');
    expect(worker).toContain('gateway_authorize');
    expect(worker).toContain('explicit user confirmation');
    expect(worker).toContain('stable idempotency key');
    expect(worker).toContain('Never use or request record update, record delete, or any batch operation');
    expect(worker).toContain('<message to="frontdesk">');
    expect(reconciler).toContain("const PILOT_ALIAS = 'bitable'");
    expect(reconciler).toContain('Do not claim an operation is available');
    expect(reconciler).toContain('derivePilotSigningKey');
    expect(reconciler).toContain('GATEWAY_SIGNING_KEY');
    expect(reconciler).toContain('agentdesk-bitable-pilot:gateway-signing');
  });
});
