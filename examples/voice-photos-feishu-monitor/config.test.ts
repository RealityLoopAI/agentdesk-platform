import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { VoicePhotoMonitorConfigError, loadVoicePhotoMonitorConfig, safeVoicePhotoMonitorConfig } from './config.js';

function validEnv(): NodeJS.ProcessEnv {
  return {
    VOICE_PHOTOS_ROOT: '/Volumes/video_database/voice_photos',
    VOICE_PHOTOS_STATE_DB: '/var/lib/agentdesk/voice-photos.sqlite',
    VOICE_PHOTOS_FEISHU_TARGET: 'feishu:p2p:ou_receiver',
    FEISHU_APP_ID: 'cli_test',
    FEISHU_APP_SECRET: 'secret-value',
  };
}

describe('voice photo monitor configuration', () => {
  it('loads safe defaults and redacts credentials and the concrete Open ID', () => {
    const config = loadVoicePhotoMonitorConfig(validEnv());
    expect(config).toMatchObject({
      rootPath: path.resolve('/Volumes/video_database/voice_photos'),
      stateDbPath: path.resolve('/var/lib/agentdesk/voice-photos.sqlite'),
      pollIntervalMs: 5_000,
      stabilityScans: 2,
      deliveryConcurrency: 1,
      maxSendsPerMinute: 30,
    });
    const safe = JSON.stringify(safeVoicePhotoMonitorConfig(config));
    expect(safe).not.toContain('secret-value');
    expect(safe).not.toContain('ou_receiver');
    expect(safe).toContain('feishu-p2p');
  });

  it.each([
    ['missing root', { VOICE_PHOTOS_ROOT: undefined }],
    ['SMB URL', { VOICE_PHOTOS_ROOT: 'smb://server/share' }],
    ['relative root', { VOICE_PHOTOS_ROOT: 'voice_photos' }],
    ['relative state', { VOICE_PHOTOS_STATE_DB: './state.sqlite' }],
    ['state inside root', { VOICE_PHOTOS_STATE_DB: '/Volumes/video_database/voice_photos/.state/monitor.sqlite' }],
    ['group target', { VOICE_PHOTOS_FEISHU_TARGET: 'feishu:oc_group' }],
    ['raw Open ID', { VOICE_PHOTOS_FEISHU_TARGET: 'ou_receiver' }],
    ['missing app id', { FEISHU_APP_ID: undefined }],
    ['missing secret', { FEISHU_APP_SECRET: undefined }],
    ['invalid poll interval', { VOICE_PHOTOS_POLL_INTERVAL_MS: '0' }],
    ['invalid stability count', { VOICE_PHOTOS_STABILITY_SCANS: '1' }],
    ['invalid concurrency', { VOICE_PHOTOS_DELIVERY_CONCURRENCY: '999' }],
  ])('fails closed for %s', (_label, overrides) => {
    expect(() => loadVoicePhotoMonitorConfig({ ...validEnv(), ...overrides })).toThrow(VoicePhotoMonitorConfigError);
  });

  it('accepts Linux mount paths and explicit bounded tuning', () => {
    const config = loadVoicePhotoMonitorConfig({
      ...validEnv(),
      VOICE_PHOTOS_ROOT: '/mnt/video_database/voice_photos',
      VOICE_PHOTOS_STATE_DB: '/var/lib/voice-monitor/state.sqlite',
      VOICE_PHOTOS_MAX_IMAGE_BYTES: '1048576',
      VOICE_PHOTOS_MAX_CANDIDATES_PER_SCAN: '500',
      VOICE_PHOTOS_MAX_SENDS_PER_MINUTE: '10',
    });
    expect(config).toMatchObject({
      rootPath: '/mnt/video_database/voice_photos',
      maxImageBytes: 1_048_576,
      maxCandidatesPerScan: 500,
      maxSendsPerMinute: 10,
    });
  });
});
