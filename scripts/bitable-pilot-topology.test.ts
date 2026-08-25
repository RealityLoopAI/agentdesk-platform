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

  it('routes through Frontdesk and makes query, confirmation, and write limits explicit', () => {
    const worker = fs.readFileSync(path.join(ROOT, 'examples/bitable-pilot/agent-group/CLAUDE.local.md'), 'utf8');
    const reconciler = fs.readFileSync(path.join(ROOT, 'examples/bitable-pilot/configure-topology.ts'), 'utf8');

    expect(worker).toContain('gateway_describe');
    expect(worker).toContain('gateway_authorize');
    expect(worker).toContain('feishu.bitable.field.list');
    expect(worker).toContain('feishu.bitable.record.list');
    expect(worker).toContain('feishu.bitable.record.update');
    expect(worker).toContain('feishu.bitable.record.delete');
    expect(worker).toContain('the submitted value must exactly equal one returned');
    expect(worker).toContain('before authorization/confirmation/execution');
    expect(worker).toContain('Copy Operation names verbatim');
    expect(worker).toContain('Never claim that an Operation was attempted');
    expect(worker).toContain('gateway_request_confirmation');
    expect(worker).toContain('Gateway-returned preview object unchanged');
    expect(worker).toContain('expectedRecordFingerprint');
    expect(worker).toContain('one visible match with `hasMore=true`');
    expect(worker).toContain('Never choose the first match');
    expect(worker).toContain('stable idempotency key');
    expect(worker).toContain('preliminary partial draft');
    expect(worker).toContain('`批次测试四号` → `测试四号`');
    expect(worker).toContain('`列路测试` → the live option `链路测试`');
    expect(worker).toContain('never default, calculate, or convert');
    expect(worker).toContain('one option is plausible');
    expect(worker).toContain('Never add a target absent from `fieldMapping`');
    expect(worker).toContain('Never use Batch Create, Batch Update, Batch Delete');
    expect(worker).toContain('Never turn a multi-match Delete into a series of');
    expect(worker).toContain('require `NOT_FOUND`');
    expect(worker).toContain('Never submit a raw Feishu filter');
    expect(worker).toContain('post-write verification fails');
    expect(worker).toContain('<message to="frontdesk">');
    expect(reconciler).toContain("const PILOT_ALIAS = 'bitable'");
    expect(reconciler).toContain('Do not claim an operation is available');
    expect(reconciler).toContain('structured record queries');
    expect(reconciler).toContain('Host renders trusted Create/Update/Delete confirmations');
    expect(reconciler).toContain('xiaohuan-bitable-bridge.v1');
    expect(reconciler).toContain('delegate the complete JSON unchanged');
    expect(reconciler).toContain('derivePilotSigningKey');
    expect(reconciler).toContain('GATEWAY_SIGNING_KEY');
    expect(reconciler).toContain('agentdesk-bitable-pilot:gateway-signing');
    expect(reconciler).not.toContain('readContainerConfig(workerFolder).backendGateway?.signingKey');
    expect(reconciler.indexOf("const configured = value('GATEWAY_SIGNING_KEY')")).toBeLessThan(
      reconciler.indexOf("const appSecret = value('FEISHU_BITABLE_APP_SECRET')"),
    );
  });

  it('ships focused behavioral eval cases for single-record CRUD safety', () => {
    const evals = JSON.parse(fs.readFileSync(path.join(ROOT, 'examples/bitable-pilot/eval-cases.json'), 'utf8'));
    expect(evals.cases.map((item: { name: string }) => item.name)).toEqual([
      'structured-query-unique-result',
      'zero-match-clarification',
      'multiple-match-disambiguation',
      'has-more-does-not-imply-unique',
      'confirmed-create-and-get-verification',
      'unknown-select-option-stops-before-write',
      'update-dry-run-host-confirmation-and-get',
      'update-conflict-stops-write',
      'delete-unique-target-preview-confirm-and-not-found',
      'delete-zero-multiple-or-has-more-stops',
      'delete-conflict-or-verification-failure-stops',
      'raw-filter-refusal',
      'guessed-batch-refusal',
      'authorization-or-confirmation-failure',
    ]);
  });

  it('keeps single-record CRUD open to trusted users without enabling batch', () => {
    const envTemplate = fs.readFileSync(
      path.join(ROOT, 'examples/reference-gateway/bitable-query-create-update.env.example'),
      'utf8',
    );
    expect(envTemplate).toContain('"readers":["*"]');
    expect(envTemplate).toContain('"writers":["*"]');
    expect(envTemplate).toContain('"feishu.bitable.record.update"');
    expect(envTemplate).toContain('"feishu.bitable.record.delete"');
    expect(envTemplate).not.toContain('"feishu.bitable.record.batch_create"');
    expect(envTemplate).not.toContain('"feishu.bitable.record.batch_update"');
    expect(envTemplate).not.toContain('"feishu.bitable.record.batch_delete"');
  });
});
