import type { ExperimentAudioV1 } from '../xiaohuan-doubao-audio/experiment-schema.js';
import type { ExperimentFieldMap } from './mapper.js';

export const BRIDGE_ENVELOPE_SCHEMA_VERSION = 'xiaohuan-bitable-bridge.v1' as const;
export const BRIDGE_DRAFT_KIND = 'feishu.bitable.record.create.draft' as const;
export const BRIDGE_CREATE_OPERATION = 'feishu.bitable.record.create' as const;

export const BRIDGE_WORKFLOW_STEPS = [
  'gateway_describe',
  'feishu.bitable.field.list',
  'gateway_authorize',
  'gateway_request_confirmation',
  'gateway_execute',
  'feishu.bitable.record.get',
] as const;

export interface XiaohuanBitableBridgeEnvelope {
  schemaVersion: typeof BRIDGE_ENVELOPE_SCHEMA_VERSION;
  kind: typeof BRIDGE_DRAFT_KIND;
  resource: string;
  captureId: string;
  transcript: string;
  experiment: ExperimentAudioV1;
  fieldMapping: ExperimentFieldMap;
  fields: Record<string, unknown>;
  requestFingerprint: string;
  idempotencyKey: string;
  workflow: {
    operation: typeof BRIDGE_CREATE_OPERATION;
    steps: typeof BRIDGE_WORKFLOW_STEPS;
    constraints: {
      logicalResourceLocked: true;
      mappingTargetsLocked: true;
      preserveTranscript: true;
      normalizationEvidenceRequired: true;
      selectOptionsLocked: true;
      stopOnAmbiguity: true;
      authorizeBeforeConfirmation: true;
      confirmation: 'host-mediated-original-user';
      executeOnlyAfterApproval: true;
      verifyCreatedRecordById: true;
      stopOnAnyFailure: true;
    };
  };
}

export interface BridgeEnvelopeInput {
  resource: string;
  result: ExperimentAudioV1;
  fieldMapping: ExperimentFieldMap;
  fields: Record<string, unknown>;
  requestFingerprint: string;
  idempotencyKey: string;
}

/**
 * Construct the only Agent-visible bridge instruction.
 *
 * Identity and physical Bitable addressing are intentionally absent. The Host
 * carries the canonical user outside this envelope, while the Gateway resolves
 * the operator-approved logical resource.
 */
export function createBridgeEnvelope(input: BridgeEnvelopeInput): XiaohuanBitableBridgeEnvelope {
  return {
    schemaVersion: BRIDGE_ENVELOPE_SCHEMA_VERSION,
    kind: BRIDGE_DRAFT_KIND,
    resource: input.resource,
    captureId: input.result.captureId,
    transcript: input.result.transcript,
    experiment: input.result,
    fieldMapping: input.fieldMapping,
    fields: input.fields,
    requestFingerprint: input.requestFingerprint,
    idempotencyKey: input.idempotencyKey,
    workflow: {
      operation: BRIDGE_CREATE_OPERATION,
      steps: BRIDGE_WORKFLOW_STEPS,
      constraints: {
        logicalResourceLocked: true,
        mappingTargetsLocked: true,
        preserveTranscript: true,
        normalizationEvidenceRequired: true,
        selectOptionsLocked: true,
        stopOnAmbiguity: true,
        authorizeBeforeConfirmation: true,
        confirmation: 'host-mediated-original-user',
        executeOnlyAfterApproval: true,
        verifyCreatedRecordById: true,
        stopOnAnyFailure: true,
      },
    },
  };
}
