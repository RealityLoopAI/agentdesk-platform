import { describe, expect, it, vi } from 'vitest';

import { createBridgeEnvelope } from '../examples/xiaohuan-bitable-bridge/envelope.js';
import {
  createIdempotencyKey,
  createRequestFingerprint,
  mapExperimentCandidateFields,
  type ExperimentFieldMap,
} from '../examples/xiaohuan-bitable-bridge/mapper.js';
import type { ExperimentAudioV1 } from '../examples/xiaohuan-doubao-audio/experiment-schema.js';

interface SimulatedGateway {
  describe: ReturnType<typeof vi.fn>;
  fieldList: ReturnType<typeof vi.fn>;
  authorize: ReturnType<typeof vi.fn>;
  requestConfirmation: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
}

function arkResult(): ExperimentAudioV1 {
  return {
    schemaVersion: 'experiment-audio.v1',
    captureId: 'bridge-e2e-000001',
    transcript: '批次测试一号，使用链路测试，无水氯化铜五克。',
    experiment: {
      title: null,
      sampleIds: ['测试一号'],
      actions: [{ name: '使用', target: '链路测试', details: null }],
      measurements: [{ name: '无水氯化铜', value: 5, unit: '克' }],
      observations: [],
      notes: null,
    },
  };
}

function fieldMap(): ExperimentFieldMap {
  return {
    'experiment.sampleIds': '批次',
    'experiment.actions': {
      field: '设备仪器',
      selector: 'action-target',
      name: '使用',
    },
    'experiment.measurements': {
      field: '无水氯化铜（克）',
      selector: 'measurement-value',
      name: '无水氯化铜',
      unit: '克',
    },
  };
}

function createDraftFromResult(result: ExperimentAudioV1) {
  const resource = 'pilot.records';
  const mapping = fieldMap();
  const fields = mapExperimentCandidateFields(result, mapping);
  const requestFingerprint = createRequestFingerprint({
    captureId: result.captureId,
    resource,
    transcript: result.transcript,
    experiment: result.experiment,
    fieldMapping: mapping,
  });
  return createBridgeEnvelope({
    resource,
    result,
    fieldMapping: mapping,
    fields,
    requestFingerprint,
    idempotencyKey: createIdempotencyKey(requestFingerprint),
  });
}

function createDraft() {
  return createDraftFromResult(arkResult());
}

async function runSimulatedWorkflow(
  draft: ReturnType<typeof createDraft>,
  gateway: SimulatedGateway,
): Promise<{ status: 'cancelled' } | { status: 'created'; recordId: string }> {
  await gateway.describe();
  await gateway.fieldList(draft.resource);
  await gateway.authorize(draft.workflow.operation, draft.resource);
  const approved = await gateway.requestConfirmation({
    resource: draft.resource,
    operation: draft.workflow.operation,
    fields: draft.fields,
    requestFingerprint: draft.requestFingerprint,
  });
  if (!approved) return { status: 'cancelled' };

  const created = await gateway.create({
    resource: draft.resource,
    fields: draft.fields,
    idempotencyKey: draft.idempotencyKey,
  }) as { recordId: string };
  await gateway.get({
    resource: draft.resource,
    recordId: created.recordId,
  });
  return { status: 'created', recordId: created.recordId };
}

function gatewayHarness(approved: boolean): SimulatedGateway {
  return {
    describe: vi.fn().mockResolvedValue({ operations: ['feishu.bitable.record.create'] }),
    fieldList: vi.fn().mockResolvedValue({ fields: ['批次', '设备仪器', '无水氯化铜（克）'] }),
    authorize: vi.fn().mockResolvedValue({ allowed: true }),
    requestConfirmation: vi.fn().mockResolvedValue(approved),
    create: vi.fn().mockResolvedValue({ recordId: 'rec_bridge_000001' }),
    get: vi.fn().mockResolvedValue({
      recordId: 'rec_bridge_000001',
      fields: {
        批次: '测试一号',
        设备仪器: '链路测试',
        '无水氯化铜（克）': 5,
      },
      fieldMapping: fieldMap(),
    }),
  };
}

describe('Xiaohuan to Bitable simulated workflow', () => {
  it('turns one Ark result into one fixed-resource Create intent', () => {
    const first = createDraft();
    const replay = createDraft();

    expect(first).toMatchObject({
      schemaVersion: 'xiaohuan-bitable-bridge.v1',
      kind: 'feishu.bitable.record.create.draft',
      resource: 'pilot.records',
      fields: {
        批次: '测试一号',
        设备仪器: '链路测试',
        '无水氯化铜（克）': 5,
      },
    });
    expect(first.idempotencyKey).toBe(
      `xiaohuan-bitable-create-${first.requestFingerprint}`,
    );
    expect(replay.requestFingerprint).toBe(first.requestFingerprint);
    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
  });

  it('preserves the real ASR-miss evidence and locked mapping for Worker normalization', () => {
    const missed: ExperimentAudioV1 = {
      schemaVersion: 'experiment-audio.v1',
      captureId: 'xiaohuan-bitable-000006',
      transcript: '批次测试四号，使用列路测试，无水氯化铜五克',
      experiment: {
        title: null,
        sampleIds: [],
        actions: [{ name: '使用', target: '列路测试' }],
        measurements: [{ name: '无水氯化铜', value: 5, unit: '克' }],
        observations: [],
        notes: null,
      },
    };
    const draft = createDraftFromResult(missed);

    expect(draft.fields).toEqual({
      设备仪器: '列路测试',
      '无水氯化铜（克）': 5,
    });
    expect(draft.fieldMapping).toEqual(fieldMap());
    expect(draft.transcript).toContain('批次测试四号');
    expect(draft.workflow.constraints).toMatchObject({
      mappingTargetsLocked: true,
      preserveTranscript: true,
      normalizationEvidenceRequired: true,
      selectOptionsLocked: true,
      stopOnAmbiguity: true,
    });
  });

  it('performs zero writes when Host confirmation is cancelled', async () => {
    const gateway = gatewayHarness(false);

    await expect(runSimulatedWorkflow(createDraft(), gateway)).resolves.toEqual({
      status: 'cancelled',
    });
    expect(gateway.describe).toHaveBeenCalledTimes(1);
    expect(gateway.fieldList).toHaveBeenCalledWith('pilot.records');
    expect(gateway.authorize).toHaveBeenCalledTimes(1);
    expect(gateway.requestConfirmation).toHaveBeenCalledTimes(1);
    expect(gateway.create).not.toHaveBeenCalled();
    expect(gateway.get).not.toHaveBeenCalled();
  });

  it('creates exactly once with the stable key and verifies the returned record ID', async () => {
    const gateway = gatewayHarness(true);
    const draft = createDraft();

    await expect(runSimulatedWorkflow(draft, gateway)).resolves.toEqual({
      status: 'created',
      recordId: 'rec_bridge_000001',
    });
    expect(gateway.create).toHaveBeenCalledTimes(1);
    expect(gateway.create).toHaveBeenCalledWith({
      resource: 'pilot.records',
      fields: draft.fields,
      idempotencyKey: draft.idempotencyKey,
    });
    expect(gateway.get).toHaveBeenCalledTimes(1);
    expect(gateway.get).toHaveBeenCalledWith({
      resource: 'pilot.records',
      recordId: 'rec_bridge_000001',
    });
  });
});
