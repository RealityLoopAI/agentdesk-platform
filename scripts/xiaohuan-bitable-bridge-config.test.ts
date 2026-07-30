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
    XIAOHUAN_BITABLE_SDP_PATH: './fixtures/xiaohuan.sdp',
    DOUBAO_ARK_API_KEY: 'ark-secret',
    DOUBAO_ARK_MODEL: 'ark-audio-model',
    ...overrides,
  };
}

describe('Xiaohuan Bitable bridge configuration', () => {
  it('defaults to disabled without reading secrets or listener settings', () => {
    expect(loadBridgeConfig({})).toEqual({ enabled: false });
  });

  it('loads a fixed P2P/user/resource binding and reuses Ark/VAD configuration', () => {
    const config = loadBridgeConfig(enabledEnv()) as EnabledBridgeConfig;
    expect(config.enabled).toBe(true);
    expect(config.authenticatedUserId).toBe('canonical-alice');
    expect(config.platformId).toBe('feishu:p2p:ou_alice');
    expect(config.resource).toBe('pilot.records');
    expect(config.audio.ark.apiKey).toBe('ark-secret');
    expect(config.vadService.processUtterances).toBe(true);
    expect(config.vadService.allowExternalUpload).toBe(true);
    expect(config.vadService.maxQueue).toBe(4);
    expect(config.ttsAck).toEqual({ enabled: false });
  });

  it('loads an explicit credential-free private-LAN TTS acknowledgement binding', () => {
    const config = loadBridgeConfig(
      enabledEnv({
        XIAOHUAN_BITABLE_TTS_ACK_ENABLED: 'true',
        XIAOHUAN_BITABLE_TTS_BASE_URL: 'http://192.168.66.133:18082',
        XIAOHUAN_BITABLE_TTS_ACK_TEXT: '收到',
        XIAOHUAN_BITABLE_TTS_TIMEOUT_MS: '2500',
      }),
    ) as EnabledBridgeConfig;

    expect(config.ttsAck).toEqual({
      enabled: true,
      baseUrl: 'http://192.168.66.133:18082',
      text: '收到',
      timeoutMs: 2500,
    });
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
    ['public endpoint', 'http://203.0.113.10:18082'],
    ['credential-bearing endpoint', 'http://user:pass@192.168.66.133:18082'],
    ['endpoint path', 'http://192.168.66.133:18082/api'],
    ['missing explicit port', 'http://192.168.66.133'],
    ['TLS endpoint outside the hardware contract', 'https://192.168.66.133:18082'],
  ])('rejects unsafe TTS binding: %s', (_name, baseUrl) => {
    expect(() =>
      loadBridgeConfig(
        enabledEnv({
          XIAOHUAN_BITABLE_TTS_ACK_ENABLED: 'true',
          XIAOHUAN_BITABLE_TTS_BASE_URL: baseUrl,
        }),
      ),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TTS_BASE_URL' }));
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
});
