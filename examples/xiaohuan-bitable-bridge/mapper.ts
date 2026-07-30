import { createHash } from 'node:crypto';

import type { ExperimentAudioV1 } from '../xiaohuan-doubao-audio/index.js';

export const SUPPORTED_EXPERIMENT_SOURCE_PATHS = [
  'captureId',
  'transcript',
  'experiment.title',
  'experiment.sampleIds',
  'experiment.actions',
  'experiment.measurements',
  'experiment.observations',
  'experiment.notes',
] as const;

export type ExperimentSourcePath = (typeof SUPPORTED_EXPERIMENT_SOURCE_PATHS)[number];
export interface ActionTargetFieldRule {
  readonly field: string;
  readonly selector: 'action-target';
  readonly name: string;
}

export interface MeasurementValueFieldRule {
  readonly field: string;
  readonly selector: 'measurement-value';
  readonly name: string;
  readonly unit?: string;
}

export type ExperimentFieldRule = string | ActionTargetFieldRule | MeasurementValueFieldRule;
export type ExperimentFieldMap = Readonly<Partial<Record<ExperimentSourcePath, ExperimentFieldRule>>>;
export type BitableDraftFields = Record<string, string | number | boolean>;

export interface MapExperimentFieldsOptions {
  joinSeparator?: string;
  maxFieldValueBytes?: number;
}

export interface RequestFingerprintInput {
  captureId: string;
  resource: string;
  transcript: string;
  experiment: ExperimentAudioV1['experiment'];
  fieldMapping: ExperimentFieldMap;
}

export class FieldMappingError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'FieldMappingError';
    this.code = code;
  }
}

const SUPPORTED_PATH_SET = new Set<string>(SUPPORTED_EXPERIMENT_SOURCE_PATHS);
const DEFAULT_JOIN_SEPARATOR = ' | ';
const DEFAULT_MAX_FIELD_VALUE_BYTES = 8 * 1024;
const MAX_TARGET_FIELD_NAME_LENGTH = 128;
const MAX_SELECTOR_TEXT_LENGTH = 256;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, current) => {
    if (!isPlainObject(current)) return current;
    return Object.keys(current)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = current[key];
        return sorted;
      }, {});
  });
}

function validConfiguredText(value: unknown, maximumLength: number): value is string {
  return (
    typeof value === 'string' &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function parseSelectorRule(
  source: string,
  value: Record<string, unknown>,
): ActionTargetFieldRule | MeasurementValueFieldRule {
  const selector = value.selector;
  if (selector !== 'action-target' && selector !== 'measurement-value') {
    throw new FieldMappingError('INVALID_SELECTOR', `Invalid selector for source path: ${source}`);
  }

  const expectedKeys =
    selector === 'action-target'
      ? ['field', 'name', 'selector']
      : value.unit === undefined
        ? ['field', 'name', 'selector']
        : ['field', 'name', 'selector', 'unit'];
  const actualKeys = Object.keys(value).sort();
  if (actualKeys.length !== expectedKeys.length || actualKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new FieldMappingError('INVALID_SELECTOR_SHAPE', `Selector contains unsupported or missing keys: ${source}`);
  }
  if (!validConfiguredText(value.field, MAX_TARGET_FIELD_NAME_LENGTH)) {
    throw new FieldMappingError('INVALID_TARGET_FIELD', `Invalid target field for source path: ${source}`);
  }
  if (!validConfiguredText(value.name, MAX_SELECTOR_TEXT_LENGTH)) {
    throw new FieldMappingError('INVALID_SELECTOR_NAME', `Invalid selector name for source path: ${source}`);
  }

  if (selector === 'action-target') {
    if (source !== 'experiment.actions') {
      throw new FieldMappingError('SELECTOR_SOURCE_MISMATCH', 'action-target requires experiment.actions');
    }
    return Object.freeze({ field: value.field, selector, name: value.name });
  }

  if (source !== 'experiment.measurements') {
    throw new FieldMappingError('SELECTOR_SOURCE_MISMATCH', 'measurement-value requires experiment.measurements');
  }
  if (value.unit !== undefined && !validConfiguredText(value.unit, MAX_SELECTOR_TEXT_LENGTH)) {
    throw new FieldMappingError('INVALID_SELECTOR_UNIT', `Invalid selector unit for source path: ${source}`);
  }
  return Object.freeze({
    field: value.field,
    selector,
    name: value.name,
    ...(value.unit === undefined ? {} : { unit: value.unit }),
  });
}

export function parseFieldMap(raw: string): ExperimentFieldMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FieldMappingError('INVALID_FIELD_MAP_JSON', 'XIAOHUAN_BITABLE_FIELD_MAP_JSON must be valid JSON');
  }
  if (!isPlainObject(parsed)) {
    throw new FieldMappingError('INVALID_FIELD_MAP_SHAPE', 'Field mapping must be a JSON object');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > SUPPORTED_EXPERIMENT_SOURCE_PATHS.length) {
    throw new FieldMappingError('INVALID_FIELD_MAP_SIZE', 'Field mapping must contain between 1 and 8 entries');
  }

  const result: Partial<Record<ExperimentSourcePath, ExperimentFieldRule>> = {};
  const targets = new Set<string>();
  for (const [source, rawTarget] of entries) {
    if (!SUPPORTED_PATH_SET.has(source)) {
      throw new FieldMappingError('UNKNOWN_SOURCE_PATH', `Unsupported experiment source path: ${source}`);
    }
    if (typeof rawTarget !== 'string' && !isPlainObject(rawTarget)) {
      throw new FieldMappingError('INVALID_TARGET_FIELD', `Invalid target field for source path: ${source}`);
    }
    const rule: ExperimentFieldRule = typeof rawTarget === 'string' ? rawTarget : parseSelectorRule(source, rawTarget);
    const target = typeof rule === 'string' ? rule : rule.field;
    if (!validConfiguredText(target, MAX_TARGET_FIELD_NAME_LENGTH)) {
      throw new FieldMappingError('INVALID_TARGET_FIELD', `Invalid target field for source path: ${source}`);
    }
    if (targets.has(target)) {
      throw new FieldMappingError('DUPLICATE_TARGET_FIELD', `Target field must be unique: ${target}`);
    }
    targets.add(target);
    result[source as ExperimentSourcePath] = rule;
  }
  return Object.freeze(result) as ExperimentFieldMap;
}

function valueAt(result: ExperimentAudioV1, path: ExperimentSourcePath): unknown {
  switch (path) {
    case 'captureId':
      return result.captureId;
    case 'transcript':
      return result.transcript;
    case 'experiment.title':
      return result.experiment.title;
    case 'experiment.sampleIds':
      return result.experiment.sampleIds;
    case 'experiment.actions':
      return result.experiment.actions;
    case 'experiment.measurements':
      return result.experiment.measurements;
    case 'experiment.observations':
      return result.experiment.observations;
    case 'experiment.notes':
      return result.experiment.notes;
  }
}

function encodeValue(value: unknown, joinSeparator: string): string | number | boolean {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
    return value.join(joinSeparator);
  }
  if (Array.isArray(value)) return canonicalJson(value);
  throw new FieldMappingError('UNSUPPORTED_SOURCE_VALUE', 'Mapped source value has an unsupported shape');
}

function encodedBytes(value: string | number | boolean): number {
  return Buffer.byteLength(typeof value === 'string' ? value : canonicalJson(value), 'utf8');
}

function selectValue(result: ExperimentAudioV1, rule: ActionTargetFieldRule | MeasurementValueFieldRule): unknown {
  if (rule.selector === 'action-target') {
    const matches = result.experiment.actions.filter((action) => action.name === rule.name);
    if (matches.length !== 1) {
      throw new FieldMappingError('SELECTOR_MATCH_COUNT', 'action-target selector must match exactly one action');
    }
    const target = matches[0].target;
    if (target === null || target.trim().length === 0) {
      throw new FieldMappingError('EMPTY_SELECTOR_VALUE', 'action-target selector matched an empty target');
    }
    return target;
  }

  const matches = result.experiment.measurements.filter(
    (measurement) => measurement.name === rule.name && (rule.unit === undefined || measurement.unit === rule.unit),
  );
  if (matches.length !== 1) {
    throw new FieldMappingError(
      'SELECTOR_MATCH_COUNT',
      'measurement-value selector must match exactly one measurement',
    );
  }
  const value = matches[0].value;
  if (value === null) {
    throw new FieldMappingError('EMPTY_SELECTOR_VALUE', 'measurement-value selector matched a null value');
  }
  return value;
}

const OMIT_FIELD = Symbol('omit-field');

function selectCandidateValue(
  result: ExperimentAudioV1,
  rule: ActionTargetFieldRule | MeasurementValueFieldRule,
): unknown | typeof OMIT_FIELD {
  if (rule.selector === 'action-target') {
    const matches = result.experiment.actions.filter((action) => action.name === rule.name);
    if (matches.length !== 1) return OMIT_FIELD;
    const target = matches[0].target;
    return target === null || target.trim().length === 0 ? OMIT_FIELD : target;
  }

  const matches = result.experiment.measurements.filter(
    (measurement) =>
      measurement.name === rule.name &&
      (rule.unit === undefined || measurement.unit === rule.unit),
  );
  if (matches.length !== 1 || matches[0].value === null) return OMIT_FIELD;
  return matches[0].value;
}

function validateMappingOptions(options: MapExperimentFieldsOptions): {
  joinSeparator: string;
  maxFieldValueBytes: number;
} {
  const joinSeparator = options.joinSeparator ?? DEFAULT_JOIN_SEPARATOR;
  const maxFieldValueBytes = options.maxFieldValueBytes ?? DEFAULT_MAX_FIELD_VALUE_BYTES;
  if (!joinSeparator || joinSeparator.length > 32 || /[\u0000-\u001f\u007f]/.test(joinSeparator)) {
    throw new FieldMappingError('INVALID_JOIN_SEPARATOR', 'Join separator must be 1-32 printable characters');
  }
  if (!Number.isSafeInteger(maxFieldValueBytes) || maxFieldValueBytes < 1 || maxFieldValueBytes > 64 * 1024) {
    throw new FieldMappingError('INVALID_VALUE_LIMIT', 'Field value byte limit must be between 1 and 65536');
  }
  return { joinSeparator, maxFieldValueBytes };
}

function assignEncodedField(
  fields: BitableDraftFields,
  target: string,
  source: ExperimentSourcePath,
  rawValue: unknown,
  joinSeparator: string,
  maxFieldValueBytes: number,
): void {
  const encoded = encodeValue(rawValue, joinSeparator);
  if (encodedBytes(encoded) > maxFieldValueBytes) {
    throw new FieldMappingError(
      'FIELD_VALUE_TOO_LARGE',
      `Mapped value exceeds the configured limit for source path: ${source}`,
    );
  }
  fields[target] = encoded;
}

export function mapExperimentFields(
  result: ExperimentAudioV1,
  fieldMap: ExperimentFieldMap,
  options: MapExperimentFieldsOptions = {},
): BitableDraftFields {
  const { joinSeparator, maxFieldValueBytes } = validateMappingOptions(options);

  const fields: BitableDraftFields = {};
  for (const source of SUPPORTED_EXPERIMENT_SOURCE_PATHS) {
    const rule = fieldMap[source];
    if (!rule) continue;
    const target = typeof rule === 'string' ? rule : rule.field;
    const rawValue = typeof rule === 'string' ? valueAt(result, source) : selectValue(result, rule);
    if (rawValue === null) continue;
    assignEncodedField(fields, target, source, rawValue, joinSeparator, maxFieldValueBytes);
  }
  return fields;
}

/**
 * Build a best-effort candidate draft without guessing.
 *
 * Missing/ambiguous selector values and empty collections are omitted so the
 * Worker can use the original transcript plus live Field List to normalize
 * them. Invalid mapping configuration and over-limit concrete values remain
 * hard failures.
 */
export function mapExperimentCandidateFields(
  result: ExperimentAudioV1,
  fieldMap: ExperimentFieldMap,
  options: MapExperimentFieldsOptions = {},
): BitableDraftFields {
  const { joinSeparator, maxFieldValueBytes } = validateMappingOptions(options);
  const fields: BitableDraftFields = {};
  for (const source of SUPPORTED_EXPERIMENT_SOURCE_PATHS) {
    const rule = fieldMap[source];
    if (!rule) continue;
    const target = typeof rule === 'string' ? rule : rule.field;
    const rawValue =
      typeof rule === 'string'
        ? valueAt(result, source)
        : selectCandidateValue(result, rule);
    if (
      rawValue === null ||
      rawValue === OMIT_FIELD ||
      (typeof rawValue === 'string' && rawValue.trim().length === 0) ||
      (Array.isArray(rawValue) && rawValue.length === 0)
    ) {
      continue;
    }
    assignEncodedField(fields, target, source, rawValue, joinSeparator, maxFieldValueBytes);
  }
  return fields;
}

export function createRequestFingerprint(input: RequestFingerprintInput): string {
  return createHash('sha256').update(canonicalJson(input), 'utf8').digest('hex');
}

export function createIdempotencyKey(fingerprint: string): string {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) {
    throw new FieldMappingError('INVALID_FINGERPRINT', 'Create fingerprint must be a lowercase SHA-256 hex digest');
  }
  return `xiaohuan-bitable-create-${fingerprint}`;
}
