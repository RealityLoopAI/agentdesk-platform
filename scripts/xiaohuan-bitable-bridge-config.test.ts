import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { loadBridgeConfig, type EnabledBridgeConfig } from '../examples/xiaohuan-bitable-bridge/config.js';
import {
  canonicalJson,
  createIdempotencyKey,
  createRequestFingerprint,
  mapExperimentCandidateFields,
  mapExperimentFields,
  parseFieldMap,
} from '../examples/xiaohuan-bitable-bridge/mapper.js';
import type { ExperimentAudioV1 } from '../examples/xiaohuan-doubao-audio/index.js';

const result: ExperimentAudioV1 = {
  schemaVersion: 'experiment-audio.v1',
  captureId: 'capture-001',
  transcript: 'measure sample A',
  experiment: {
    title: null,
    sampleIds: ['A', 'B'],
    actions: [{ target: 'sample A', name: 'measure' }],
    measurements: [{ unit: 'g', value: 12.5, name: 'mass' }],
    observations: ['clear', 'stable'],
    notes: null,
  },
};

function enabledEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    XIAOHUAN_BITABLE_BRIDGE_ENABLED: 'true',
    XIAOHUAN_BITABLE_ALLOW_EXTERNAL_UPLOAD: 'true',
    XIAOHUAN_BITABLE_ALLOW_AGENT_DELIVERY: 'true',
    XIAOHUAN_BITABLE_AUTHENTICATED_USER_ID: 'canonical-alice',
    XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID: 'feishu:p2p:ou_alice',
    XIAOHUAN_BITABLE_RESOURCE: 'pilot.records',
    XIAOHUAN_BITABLE_FIELD_MAP_JSON: '{"captureId":"Capture","experiment.sampleIds":"Samples"}',
    XIAOHUAN_BITABLE_HTTP_BIND: '0.0.0.0',
    XIAOHUAN_BITABLE_HTTP_PORT: '50020',
    DOUBAO_ARK_API_KEY: 'ark-secret',
    DOUBAO_ARK_MODEL: 'ark-audio-model',
    ...overrides,
  };
}

describe('Xiaohuan Bitable bridge configuration', () => {
  it('defaults to disabled without reading secrets or listener settings', () => {
    expect(loadBridgeConfig({})).toEqual({ enabled: false });
  });

  it('loads a fixed P2P/user/resource binding and whole-utterance HTTP configuration', () => {
    const config = loadBridgeConfig(enabledEnv()) as EnabledBridgeConfig;
    expect(config.enabled).toBe(true);
    expect(config.authenticatedUserId).toBe('canonical-alice');
    expect(config.platformId).toBe('feishu:p2p:ou_alice');
    expect(config.feishuTranscriptMirrorEnabled).toBe(false);
    expect(config.resource).toBe('pilot.records');
    expect(config.audio.ark.apiKey).toBe('ark-secret');
    expect(config.httpService).toMatchObject({
      bindHost: '0.0.0.0',
      port: 50_020,
      maxBodyBytes: 4 * 1024 * 1024,
      maxDurationMs: 20_000,
      expectedSampleRate: 16_000,
      maxQueue: 8,
      requestTimeoutMs: 10_000,
      keepUtterances: false,
    });
  });

  it('enables transcript mirroring only through an explicit boolean switch', () => {
    const config = loadBridgeConfig(
      enabledEnv({ XIAOHUAN_BITABLE_FEISHU_TRANSCRIPT_MIRROR_ENABLED: 'true' }),
    ) as EnabledBridgeConfig;
    expect(config.feishuTranscriptMirrorEnabled).toBe(true);
    expect(() =>
      loadBridgeConfig(
        enabledEnv({ XIAOHUAN_BITABLE_FEISHU_TRANSCRIPT_MIRROR_ENABLED: 'yes' }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_BOOLEAN' }));
  });

  it.each([
    ['missing upload consent', { XIAOHUAN_BITABLE_ALLOW_EXTERNAL_UPLOAD: 'false' }],
    ['missing delivery consent', { XIAOHUAN_BITABLE_ALLOW_AGENT_DELIVERY: 'false' }],
    ['group route', { XIAOHUAN_BITABLE_FEISHU_P2P_PLATFORM_ID: 'feishu:chat:oc_group' }],
    ['physical app token', { XIAOHUAN_BITABLE_RESOURCE: 'bascnPhysical123' }],
    ['physical table id', { XIAOHUAN_BITABLE_RESOURCE: 'tblPhysical123' }],
  ])('fails closed for %s', (_name, override) => {
    expect(() => loadBridgeConfig(enabledEnv(override))).toThrow();
  });

  it.each([
    ['port out of range', { XIAOHUAN_BITABLE_HTTP_PORT: '70000' }],
    ['body over hardware contract', { XIAOHUAN_BITABLE_HTTP_MAX_BODY_BYTES: '4194305' }],
    ['queue is zero', { XIAOHUAN_BITABLE_HTTP_MAX_QUEUE: '0' }],
    ['duration exceeds Ark limit', { XIAOHUAN_BITABLE_HTTP_MAX_DURATION_MS: '20001' }],
  ])('rejects invalid HTTP receiver configuration: %s', (_name, override) => {
    expect(() => loadBridgeConfig(enabledEnv(override))).toThrow();
  });
});

describe('Xiaohuan Bitable field mapping', () => {
  it('maps only configured values, omits nulls, joins strings, and canonicalizes object arrays', () => {
    const mapping = parseFieldMap(
      JSON.stringify({
        captureId: 'Capture',
        'experiment.title': 'Title',
        'experiment.sampleIds': 'Samples',
        'experiment.actions': 'Actions',
        'experiment.measurements': 'Measurements',
        'experiment.observations': 'Observations',
        'experiment.notes': 'Notes',
      }),
    );
    expect(mapExperimentFields(result, mapping, { joinSeparator: '; ' })).toEqual({
      Capture: 'capture-001',
      Samples: 'A; B',
      Actions: '[{"name":"measure","target":"sample A"}]',
      Measurements: '[{"name":"mass","unit":"g","value":12.5}]',
      Observations: 'clear; stable',
    });
  });

  it.each([
    ['unknown source', '{"device.ip":"IP"}', 'UNKNOWN_SOURCE_PATH'],
    ['duplicate target', '{"captureId":"Same","transcript":"Same"}', 'DUPLICATE_TARGET_FIELD'],
    ['empty target', '{"captureId":""}', 'INVALID_TARGET_FIELD'],
  ])('rejects %s', (_name, raw, code) => {
    expect(() => parseFieldMap(raw)).toThrowError(expect.objectContaining({ code }));
  });

  it('rejects values over the configured UTF-8 byte limit', () => {
    const mapping = parseFieldMap('{"transcript":"Transcript"}');
    expect(() => mapExperimentFields(result, mapping, { maxFieldValueBytes: 5 })).toThrowError(
      expect.objectContaining({
        code: 'FIELD_VALUE_TOO_LARGE',
      }),
    );
  });

  it('keeps string shorthand and maps unique exact action targets and measurement values unchanged', () => {
    const mapping = parseFieldMap(
      JSON.stringify({
        captureId: 'Capture',
        'experiment.actions': {
          field: 'Target',
          selector: 'action-target',
          name: 'measure',
        },
        'experiment.measurements': {
          field: 'Mass',
          selector: 'measurement-value',
          name: 'mass',
          unit: 'g',
        },
      }),
    );

    expect(mapExperimentFields(result, mapping)).toEqual({
      Capture: 'capture-001',
      Target: 'sample A',
      Mass: 12.5,
    });
  });

  it('treats measurement unit as optional and preserves a string value without conversion', () => {
    const selected: ExperimentAudioV1 = {
      ...result,
      experiment: {
        ...result.experiment,
        measurements: [{ name: 'temperature', value: '十二点五', unit: '摄氏度' }],
      },
    };
    const mapping = parseFieldMap(
      JSON.stringify({
        'experiment.measurements': {
          field: 'Temperature',
          selector: 'measurement-value',
          name: 'temperature',
        },
      }),
    );

    expect(mapExperimentFields(selected, mapping)).toEqual({ Temperature: '十二点五' });
  });

  it('does not convert units or use a same-name measurement with a different unit', () => {
    const mapping = parseFieldMap(
      JSON.stringify({
        'experiment.measurements': {
          field: 'Mass in kg',
          selector: 'measurement-value',
          name: 'mass',
          unit: 'kg',
        },
      }),
    );

    expect(() => mapExperimentFields(result, mapping)).toThrowError(
      expect.objectContaining({ code: 'SELECTOR_MATCH_COUNT' }),
    );
  });

  it.each([
    [
      'zero action matches',
      { ...result.experiment, actions: [{ name: 'mix', target: 'sample A' }] },
      {
        'experiment.actions': {
          field: 'Target',
          selector: 'action-target',
          name: 'measure',
        },
      },
      'SELECTOR_MATCH_COUNT',
    ],
    [
      'multiple action matches',
      {
        ...result.experiment,
        actions: [
          { name: 'measure', target: 'sample A' },
          { name: 'measure', target: 'sample B' },
        ],
      },
      {
        'experiment.actions': {
          field: 'Target',
          selector: 'action-target',
          name: 'measure',
        },
      },
      'SELECTOR_MATCH_COUNT',
    ],
    [
      'empty action target',
      { ...result.experiment, actions: [{ name: 'measure', target: '' }] },
      {
        'experiment.actions': {
          field: 'Target',
          selector: 'action-target',
          name: 'measure',
        },
      },
      'EMPTY_SELECTOR_VALUE',
    ],
    [
      'zero measurement matches',
      result.experiment,
      {
        'experiment.measurements': {
          field: 'Volume',
          selector: 'measurement-value',
          name: 'volume',
        },
      },
      'SELECTOR_MATCH_COUNT',
    ],
    [
      'multiple measurement matches when unit is omitted',
      {
        ...result.experiment,
        measurements: [
          { name: 'mass', value: 12.5, unit: 'g' },
          { name: 'mass', value: 0.0125, unit: 'kg' },
        ],
      },
      {
        'experiment.measurements': {
          field: 'Mass',
          selector: 'measurement-value',
          name: 'mass',
        },
      },
      'SELECTOR_MATCH_COUNT',
    ],
    [
      'null measurement value',
      {
        ...result.experiment,
        measurements: [{ name: 'mass', value: null, unit: 'g' }],
      },
      {
        'experiment.measurements': {
          field: 'Mass',
          selector: 'measurement-value',
          name: 'mass',
          unit: 'g',
        },
      },
      'EMPTY_SELECTOR_VALUE',
    ],
  ])('fails the complete draft for %s', (_name, experiment, rawMapping, code) => {
    const selected = { ...result, experiment } as ExperimentAudioV1;
    const mapping = parseFieldMap(JSON.stringify(rawMapping));
    expect(() => mapExperimentFields(selected, mapping)).toThrowError(expect.objectContaining({ code }));
  });

  it.each([
    [
      'selector on the wrong source',
      '{"transcript":{"field":"Target","selector":"action-target","name":"measure"}}',
      'SELECTOR_SOURCE_MISMATCH',
    ],
    [
      'duplicate target across shorthand and selector',
      '{"captureId":"Same","experiment.actions":{"field":"Same","selector":"action-target","name":"measure"}}',
      'DUPLICATE_TARGET_FIELD',
    ],
    [
      'extra selector property',
      '{"experiment.actions":{"field":"Target","selector":"action-target","name":"measure","unit":"g"}}',
      'INVALID_SELECTOR_SHAPE',
    ],
  ])('rejects invalid selector configuration: %s', (_name, raw, code) => {
    expect(() => parseFieldMap(raw)).toThrowError(expect.objectContaining({ code }));
  });

  it('uses canonical source evidence and mapping bytes for a stable fingerprint and Create key', () => {
    const input = {
      captureId: 'capture-001',
      resource: 'pilot.records',
      transcript: result.transcript,
      experiment: result.experiment,
      fieldMapping: parseFieldMap(
        '{"experiment.sampleIds":"Samples","experiment.measurements":"Measurements"}',
      ),
    };
    const reordered = {
      fieldMapping: {
        'experiment.measurements': 'Measurements',
        'experiment.sampleIds': 'Samples',
      },
      experiment: result.experiment,
      transcript: result.transcript,
      resource: 'pilot.records',
      captureId: 'capture-001',
    };
    const fingerprint = createRequestFingerprint(input);
    expect(fingerprint).toBe(createRequestFingerprint(reordered));
    expect(fingerprint).toBe(createHash('sha256').update(canonicalJson(input)).digest('hex'));
    expect(createIdempotencyKey(fingerprint)).toBe(`xiaohuan-bitable-create-${fingerprint}`);
  });

  it('keeps a partial draft when structured extraction misses transcript evidence', () => {
    const asrMiss: ExperimentAudioV1 = {
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
    const mapping = parseFieldMap(
      JSON.stringify({
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
      }),
    );

    expect(mapExperimentCandidateFields(asrMiss, mapping)).toEqual({
      设备仪器: '列路测试',
      '无水氯化铜（克）': 5,
    });
  });

  it('recovers the real spoken batch deterministically after one configured transcript marker', () => {
    const asrMiss: ExperimentAudioV1 = {
      schemaVersion: 'experiment-audio.v1',
      captureId: 'xiaohuan-http-b0169e79',
      transcript: '批次测试十号，使用链路测试设备，无水氯化铜四克',
      experiment: {
        title: null,
        sampleIds: [],
        actions: [{ name: '使用', target: '链路测试设备' }],
        measurements: [{ name: '无水氯化铜', value: 4, unit: '克' }],
        observations: [],
        notes: null,
      },
    };
    const mapping = parseFieldMap(
      JSON.stringify({
        transcript: {
          field: '批次',
          selector: 'text-after-marker',
          markers: ['批次'],
        },
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
      }),
    );

    expect(mapExperimentCandidateFields(asrMiss, mapping)).toEqual({
      批次: '测试十号',
      设备仪器: '链路测试设备',
      '无水氯化铜（克）': 4,
    });
    expect(mapExperimentFields(asrMiss, mapping)).toEqual({
      批次: '测试十号',
      设备仪器: '链路测试设备',
      '无水氯化铜（克）': 4,
    });
  });

  it.each([
    ['missing marker', '本次实验使用链路测试设备', {}],
    ['multiple marker phrases', '批次测试十号，批次测试十一号。', {}],
  ])('omits an unsafe text-after-marker candidate: %s', (_name, transcript, expected) => {
    const selected = { ...result, transcript };
    const mapping = parseFieldMap(
      '{"transcript":{"field":"批次","selector":"text-after-marker","markers":["批次"]}}',
    );
    expect(mapExperimentCandidateFields(selected, mapping)).toEqual(expected);
    expect(() => mapExperimentFields(selected, mapping)).toThrowError(
      expect.objectContaining({ code: 'SELECTOR_MATCH_COUNT' }),
    );
  });

  it('uses the longest configured marker at one position and allows transcript end as a boundary', () => {
    const selected = { ...result, transcript: '本次实验的批次为测试十二号' };
    const mapping = parseFieldMap(
      '{"transcript":{"field":"批次","selector":"text-after-marker","markers":["批次","批次为"]}}',
    );
    expect(mapExperimentCandidateFields(selected, mapping)).toEqual({ 批次: '测试十二号' });
  });

  it('omits unresolved selectors instead of rejecting the whole candidate draft', () => {
    const unresolved: ExperimentAudioV1 = {
      ...result,
      experiment: {
        ...result.experiment,
        actions: [{ name: '操作', target: 'sample A' }],
        measurements: [],
      },
    };
    const mapping = parseFieldMap(
      JSON.stringify({
        captureId: 'Capture',
        'experiment.actions': {
          field: 'Target',
          selector: 'action-target',
          name: 'measure',
        },
        'experiment.measurements': {
          field: 'Mass',
          selector: 'measurement-value',
          name: 'mass',
          unit: 'g',
        },
      }),
    );
    expect(mapExperimentCandidateFields(unresolved, mapping)).toEqual({
      Capture: 'capture-001',
    });
  });

  it.each([
    [
      'text selector on a non-transcript source',
      '{"experiment.sampleIds":{"field":"批次","selector":"text-after-marker","markers":["批次"]}}',
      'SELECTOR_SOURCE_MISMATCH',
    ],
    [
      'empty marker list',
      '{"transcript":{"field":"批次","selector":"text-after-marker","markers":[]}}',
      'INVALID_SELECTOR_MARKERS',
    ],
    [
      'duplicate markers',
      '{"transcript":{"field":"批次","selector":"text-after-marker","markers":["批次","批次"]}}',
      'INVALID_SELECTOR_MARKERS',
    ],
    [
      'unsupported text selector key',
      '{"transcript":{"field":"批次","selector":"text-after-marker","markers":["批次"],"name":"x"}}',
      'INVALID_SELECTOR_SHAPE',
    ],
  ])('rejects invalid text-after-marker configuration: %s', (_name, raw, code) => {
    expect(() => parseFieldMap(raw)).toThrowError(expect.objectContaining({ code }));
  });
});
