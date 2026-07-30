import { AudioPipelineError } from './errors.js';

export interface ExperimentAudioV1 {
  schemaVersion: 'experiment-audio.v1';
  captureId: string;
  transcript: string;
  experiment: {
    title: string | null;
    sampleIds: string[];
    actions: Array<{ name: string; target: string | null }>;
    measurements: Array<{
      name: string;
      value: number | string | null;
      unit: string | null;
    }>;
    observations: string[];
    notes: string | null;
  };
}

export const experimentAudioJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'captureId', 'transcript', 'experiment'],
  properties: {
    schemaVersion: { const: 'experiment-audio.v1' },
    captureId: { type: 'string' },
    transcript: { type: 'string' },
    experiment: {
      type: 'object',
      additionalProperties: false,
      required: ['title', 'sampleIds', 'actions', 'measurements', 'observations', 'notes'],
      properties: {
        title: { type: ['string', 'null'] },
        sampleIds: { type: 'array', items: { type: 'string' } },
        actions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'target'],
            properties: {
              name: { type: 'string' },
              target: { type: ['string', 'null'] },
            },
          },
        },
        measurements: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'value', 'unit'],
            properties: {
              name: { type: 'string' },
              value: { type: ['number', 'string', 'null'] },
              unit: { type: ['string', 'null'] },
            },
          },
        },
        observations: { type: 'array', items: { type: 'string' } },
        notes: { type: ['string', 'null'] },
      },
    },
  },
} as const;

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function validateExperimentAudioV1(
  value: unknown,
  expected: { captureId: string; transcript?: string },
): ExperimentAudioV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throwInvalid();
  }
  const root = value as Record<string, unknown>;
  if (
    root.schemaVersion !== 'experiment-audio.v1' ||
    root.captureId !== expected.captureId ||
    typeof root.transcript !== 'string' ||
    !root.transcript.trim() ||
    (expected.transcript !== undefined && root.transcript !== expected.transcript) ||
    !root.experiment ||
    typeof root.experiment !== 'object' ||
    Array.isArray(root.experiment)
  ) {
    throwInvalid();
  }
  const experiment = root.experiment as Record<string, unknown>;
  if (
    !isNullableString(experiment.title) ||
    !isStringArray(experiment.sampleIds) ||
    !Array.isArray(experiment.actions) ||
    !experiment.actions.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        isNullableString((item as Record<string, unknown>).target),
    ) ||
    !Array.isArray(experiment.measurements) ||
    !experiment.measurements.every((item) => {
      if (!item || typeof item !== 'object') return false;
      const measurement = item as Record<string, unknown>;
      return (
        typeof measurement.name === 'string' &&
        (measurement.value === null ||
          typeof measurement.value === 'number' ||
          typeof measurement.value === 'string') &&
        isNullableString(measurement.unit)
      );
    }) ||
    !isStringArray(experiment.observations) ||
    !isNullableString(experiment.notes)
  ) {
    throwInvalid();
  }
  return value as ExperimentAudioV1;
}

function throwInvalid(): never {
  throw new AudioPipelineError(
    'multimodal',
    'INVALID_STRUCTURED_OUTPUT',
    'Model output does not match experiment-audio.v1',
  );
}
