import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { VoicePhotoJsonMonitorConfig } from './json-config.js';
import { VoicePhotoJsonService, type VoicePhotoJsonEnvelope } from './json-service.js';
import { VoicePhotoJsonState } from './json-state.js';

const directories: string[] = [];
const analysis = {
  场景: '场景二',
  帧结果: [
    {
      图片: 'a.jpg',
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
  采用图片: 'a.jpg',
  准确性判断: '高可信',
};

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('VoicePhotoJsonService', () => {
  it('baselines existing JSON and submits only a later stable qualified file', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-json-'));
    directories.push(directory);
    const root = path.join(directory, 'root');
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'existing.json'), JSON.stringify(analysis));
    const state = new VoicePhotoJsonState(path.join(directory, 'state.sqlite'));
    const submitted: VoicePhotoJsonEnvelope[] = [];
    const config: VoicePhotoJsonMonitorConfig = {
      enabled: true,
      rootPath: root,
      stateDbPath: path.join(directory, 'state.sqlite'),
      authenticatedUserId: 'usr_test',
      platformId: 'voice-photo-json:realityloop',
      routes: {
        场景二: {
          resource: 'voice.photo.scene2',
          measurementField: '无水氯化铜（克）',
          acceptedUnits: ['g', '克'],
          valueType: 'number',
          staticFields: { 批次: '测试版本', 设备仪器: '测试版本' },
        },
      },
      machineIngestHmacKey: 'k'.repeat(32),
      pollIntervalMs: 1000,
      stabilityScans: 2,
      maxJsonBytes: 1024 * 1024,
      maxCandidatesPerScan: 100,
    };
    const service = new VoicePhotoJsonService(config, {
      state,
      submit: async (envelope) => {
        submitted.push(envelope);
      },
    });
    await service.runOneCycle();
    await service.runOneCycle();
    expect(submitted).toHaveLength(0);

    await fs.writeFile(path.join(root, 'new.json'), JSON.stringify(analysis));
    await service.runOneCycle();
    await service.runOneCycle();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.workflow.confirmation).toBe('forbidden');
    expect(submitted[0]?.fields).toEqual({
      批次: '测试版本',
      设备仪器: '测试版本',
      '无水氯化铜（克）': 4.4041,
    });
    state.close();
  });
});
