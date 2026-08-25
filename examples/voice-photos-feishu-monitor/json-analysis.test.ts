import { describe, expect, it } from 'vitest';

import {
  createVoicePhotoJsonDigest,
  createVoicePhotoMachineIdempotencyKey,
  parseQualifiedVoicePhotoAnalysis,
} from './json-analysis.js';

const routes = {
  场景一: {
    resource: 'voice.photo.scene1',
    measurementField: '转速',
    acceptedUnits: ['rpm'],
    valueType: 'number' as const,
    staticFields: { 批次: '测试版本' },
  },
  场景二: {
    resource: 'voice.photo.scene2',
    measurementField: '无水氯化铜（克）',
    acceptedUnits: ['g', '克'],
    valueType: 'number' as const,
    staticFields: { 批次: '测试版本', 设备仪器: '链路测试' },
  },
};

const valid = {
  场景: '场景二',
  帧结果: [
    {
      图片: '20260730_184614_002.jpg',
      画面状态: '清晰',
      模糊置信度: 0.03,
      有读数: true,
      原始数字: '44041',
      数值: '4.4041',
      单位: 'g',
      数值置信度: 0.97,
    },
  ],
  画面状态: '清晰',
  有读数: true,
  最终数值: '4.4041',
  单位: 'g',
  数值置信度: 0.96,
  模糊置信度: 0.03,
  帧间一致性: '稳定',
  采用图片: '20260730_184614_002.jpg',
  准确性判断: '高可信',
};

describe('voice photo JSON analysis', () => {
  it('maps a qualified result to the exact test-version Bitable fields', () => {
    expect(parseQualifiedVoicePhotoAnalysis(JSON.stringify(valid), routes)).toEqual({
      analysis: valid,
      resource: 'voice.photo.scene2',
      fields: {
        批次: '测试版本',
        设备仪器: '链路测试',
        '无水氯化铜（克）': 4.4041,
      },
    });
  });

  it('routes scene one rpm readings to the 转速 field', () => {
    const sceneOne = {
      ...valid,
      场景: '场景一',
      最终数值: '650',
      单位: 'rpm',
      帧结果: valid.帧结果.map((frame) => ({ ...frame, 数值: '650', 单位: 'rpm', 原始数字: '650' })),
    };
    expect(parseQualifiedVoicePhotoAnalysis(JSON.stringify(sceneOne), routes)).toEqual({
      analysis: sceneOne,
      resource: 'voice.photo.scene1',
      fields: {
        批次: '测试版本',
        转速: 650,
      },
    });
  });

  it('keeps table fields isolated by scene', () => {
    const result = parseQualifiedVoicePhotoAnalysis(JSON.stringify(valid), routes);
    expect(result.fields).toEqual({
      批次: '测试版本',
      设备仪器: '链路测试',
      '无水氯化铜（克）': 4.4041,
    });
    expect(result.fields).not.toHaveProperty('转速');
  });

  it.each([
    [{ ...valid, 画面状态: '模糊' }, 'NOT_QUALIFIED'],
    [{ ...valid, 有读数: false }, 'NOT_QUALIFIED'],
    [{ ...valid, 最终数值: '4.5' }, 'ADOPTED_FRAME_MISMATCH'],
    [{ ...valid, 采用图片: 'missing.jpg' }, 'ADOPTED_FRAME_MISSING'],
    [{ ...valid, 单位: 'kg' }, 'UNSUPPORTED_UNIT'],
  ])('rejects invalid or incomplete analysis', (input, code) => {
    expect(() => parseQualifiedVoicePhotoAnalysis(JSON.stringify(input), routes)).toThrow(
      expect.objectContaining({ code }),
    );
  });

  it('rejects an unmapped scene before choosing any table', () => {
    expect(() => parseQualifiedVoicePhotoAnalysis(JSON.stringify({ ...valid, 场景: '未知场景' }), routes)).toThrow(
      expect.objectContaining({ code: 'UNKNOWN_SCENE' }),
    );
  });

  it('creates a stable proof-bound idempotency key', () => {
    const digest = createVoicePhotoJsonDigest(Buffer.from('sample'));
    const args = { digest, resource: 'pilot.records', fields: { x: 1 }, hmacKey: 'k'.repeat(32) };
    expect(createVoicePhotoMachineIdempotencyKey(args)).toBe(createVoicePhotoMachineIdempotencyKey(args));
    expect(createVoicePhotoMachineIdempotencyKey({ ...args, fields: { x: 2 } })).not.toBe(
      createVoicePhotoMachineIdempotencyKey(args),
    );
  });
});
