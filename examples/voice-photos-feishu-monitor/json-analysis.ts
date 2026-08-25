import { createHash, createHmac } from 'node:crypto';

export const VOICE_PHOTO_JSON_SCHEMA_VERSION = 'voice-photo-json.v1' as const;
export const VOICE_PHOTO_JSON_IDEMPOTENCY_PREFIX = 'voice-photo-json-v1' as const;
export const TEST_VERSION_VALUE = '测试版本' as const;

export interface VoicePhotoSceneRoute {
  resource: string;
  measurementField: string;
  acceptedUnits: string[];
  valueType: 'number' | 'text-with-unit';
  staticFields: Record<string, string>;
}

export type VoicePhotoSceneRoutes = Record<string, VoicePhotoSceneRoute>;

export const DEFAULT_VOICE_PHOTO_SCENE_ROUTES: VoicePhotoSceneRoutes = {
  场景二: {
    resource: 'voice.photo.scene2',
    measurementField: '无水氯化铜（克）',
    acceptedUnits: ['g', '克'],
    valueType: 'number',
    staticFields: { 批次: TEST_VERSION_VALUE, 设备仪器: TEST_VERSION_VALUE },
  },
};

export interface VoicePhotoFrameResult {
  图片: string;
  画面状态: string;
  模糊置信度: number;
  有读数: boolean;
  原始数字: string;
  数值: string;
  单位: string;
  数值置信度: number;
}

export interface VoicePhotoAnalysis {
  场景: string;
  帧结果: VoicePhotoFrameResult[];
  画面状态: string;
  有读数: boolean;
  最终数值: string;
  单位: string;
  数值置信度: number;
  模糊置信度: number;
  帧间一致性: string;
  采用图片: string;
  准确性判断: string;
}

export interface QualifiedVoicePhotoAnalysis {
  analysis: VoicePhotoAnalysis;
  resource: string;
  fields: Record<string, unknown>;
}

export class VoicePhotoJsonValidationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VoicePhotoJsonValidationError';
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VoicePhotoJsonValidationError('INVALID_SHAPE', `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new VoicePhotoJsonValidationError('MISSING_TEXT', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function confidence(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new VoicePhotoJsonValidationError('INVALID_CONFIDENCE', `${label} must be between 0 and 1`);
  }
  return value;
}

function decimal(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(result) || !Number.isFinite(Number(result))) {
    throw new VoicePhotoJsonValidationError('INVALID_DECIMAL', `${label} must be a finite decimal string`);
  }
  return result;
}

function parseFrame(value: unknown, index: number): VoicePhotoFrameResult {
  const frame = object(value, `帧结果[${index}]`);
  return {
    图片: text(frame.图片, `帧结果[${index}].图片`),
    画面状态: text(frame.画面状态, `帧结果[${index}].画面状态`),
    模糊置信度: confidence(frame.模糊置信度, `帧结果[${index}].模糊置信度`),
    有读数:
      typeof frame.有读数 === 'boolean'
        ? frame.有读数
        : (() => {
            throw new VoicePhotoJsonValidationError('INVALID_BOOLEAN', `帧结果[${index}].有读数 must be boolean`);
          })(),
    原始数字: text(frame.原始数字, `帧结果[${index}].原始数字`),
    数值: decimal(frame.数值, `帧结果[${index}].数值`),
    单位: text(frame.单位, `帧结果[${index}].单位`),
    数值置信度: confidence(frame.数值置信度, `帧结果[${index}].数值置信度`),
  };
}

export function parseQualifiedVoicePhotoAnalysis(
  source: string,
  routes: VoicePhotoSceneRoutes = DEFAULT_VOICE_PHOTO_SCENE_ROUTES,
): QualifiedVoicePhotoAnalysis {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    throw new VoicePhotoJsonValidationError('INVALID_JSON', 'analysis file must contain valid JSON');
  }
  const value = object(raw, 'analysis');
  const scene = text(value.场景, '场景');
  const route = routes[scene];
  if (!route) {
    throw new VoicePhotoJsonValidationError('UNKNOWN_SCENE', `no configured Bitable route for scene: ${scene}`);
  }
  if (value.有读数 !== true || value.画面状态 !== '清晰') {
    throw new VoicePhotoJsonValidationError('NOT_QUALIFIED', 'top-level result must be 清晰 and 有读数=true');
  }
  if (!Array.isArray(value.帧结果) || value.帧结果.length === 0) {
    throw new VoicePhotoJsonValidationError('MISSING_FRAMES', '帧结果 must be a non-empty array');
  }
  const frames = value.帧结果.map(parseFrame);
  const finalValue = decimal(value.最终数值, '最终数值');
  const finalUnit = text(value.单位, '单位');
  if (!route.acceptedUnits.includes(finalUnit)) {
    throw new VoicePhotoJsonValidationError('UNSUPPORTED_UNIT', `unit ${finalUnit} is not allowed for scene ${scene}`);
  }
  const adoptedImage = text(value.采用图片, '采用图片');
  const adopted = frames.find((frame) => frame.图片 === adoptedImage);
  if (!adopted) {
    throw new VoicePhotoJsonValidationError('ADOPTED_FRAME_MISSING', '采用图片 must reference 帧结果');
  }
  if (
    adopted.画面状态 !== '清晰' ||
    !adopted.有读数 ||
    Number(adopted.数值) !== Number(finalValue) ||
    adopted.单位 !== finalUnit
  ) {
    throw new VoicePhotoJsonValidationError(
      'ADOPTED_FRAME_MISMATCH',
      'adopted frame must be clear and match the final value and unit',
    );
  }

  const analysis: VoicePhotoAnalysis = {
    场景: scene,
    帧结果: frames,
    画面状态: '清晰',
    有读数: true,
    最终数值: finalValue,
    单位: finalUnit,
    数值置信度: confidence(value.数值置信度, '数值置信度'),
    模糊置信度: confidence(value.模糊置信度, '模糊置信度'),
    帧间一致性: text(value.帧间一致性, '帧间一致性'),
    采用图片: adoptedImage,
    准确性判断: text(value.准确性判断, '准确性判断'),
  };
  const measurementValue = route.valueType === 'number' ? Number(finalValue) : `${finalValue}${finalUnit}`;
  return {
    analysis,
    resource: route.resource,
    fields: {
      ...route.staticFields,
      [route.measurementField]: measurementValue,
    },
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}

export function createVoicePhotoJsonDigest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function createVoicePhotoMachineIdempotencyKey(input: {
  digest: string;
  resource: string;
  fields: Record<string, unknown>;
  hmacKey: string;
}): string {
  if (!/^[a-f0-9]{64}$/.test(input.digest)) {
    throw new VoicePhotoJsonValidationError('INVALID_DIGEST', 'digest must be lowercase SHA-256 hex');
  }
  const payload = canonicalJson({
    version: VOICE_PHOTO_JSON_SCHEMA_VERSION,
    digest: input.digest,
    resource: input.resource,
    fields: input.fields,
  });
  const signature = createHmac('sha256', input.hmacKey).update(payload).digest('hex');
  return `${VOICE_PHOTO_JSON_IDEMPOTENCY_PREFIX}:${input.digest}:${signature}`;
}
