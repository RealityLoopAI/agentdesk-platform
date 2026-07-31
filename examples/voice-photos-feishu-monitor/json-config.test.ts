import { describe, expect, it } from 'vitest';

import { loadVoicePhotoJsonMonitorConfig, safeVoicePhotoJsonConfig } from './json-config.js';

const enabled = {
  VOICE_PHOTOS_JSON_MONITOR_ENABLED: 'true',
  VOICE_PHOTOS_ROOT: '/mnt/voice_photos',
  VOICE_PHOTOS_JSON_STATE_DB: '/var/lib/agentdesk/voice-json.sqlite',
  VOICE_PHOTOS_AUTHENTICATED_USER_ID: 'usr_test',
  VOICE_PHOTOS_PLATFORM_ID: 'voice-photo-json:realityloop',
  VOICE_PHOTOS_SCENE_ROUTES_JSON: JSON.stringify({
    场景一: {
      resource: 'voice.photo.scene1',
      measurementField: '转速',
      acceptedUnits: ['rpm'],
      valueType: 'number',
      staticFields: { 批次: '测试版本' },
    },
  }),
  VOICE_PHOTOS_MACHINE_INGEST_HMAC_KEY: 'k'.repeat(32),
};

describe('voice photo JSON monitor config', () => {
  it('is disabled by default', () => {
    expect(loadVoicePhotoJsonMonitorConfig({})).toEqual({ enabled: false });
  });

  it('loads a safe bounded config without exposing the HMAC key', () => {
    const config = loadVoicePhotoJsonMonitorConfig(enabled);
    expect(config.enabled).toBe(true);
    if (!config.enabled) throw new Error('expected enabled');
    expect(safeVoicePhotoJsonConfig(config)).not.toHaveProperty('machineIngestHmacKey');
    expect(config.routes.场景一?.resource).toBe('voice.photo.scene1');
  });

  it('rejects state inside the read-only monitored root and short secrets', () => {
    expect(() =>
      loadVoicePhotoJsonMonitorConfig({
        ...enabled,
        VOICE_PHOTOS_JSON_STATE_DB: '/mnt/voice_photos/state.sqlite',
      }),
    ).toThrow(/outside VOICE_PHOTOS_ROOT/);
    expect(() =>
      loadVoicePhotoJsonMonitorConfig({
        ...enabled,
        VOICE_PHOTOS_MACHINE_INGEST_HMAC_KEY: 'short',
      }),
    ).toThrow(/at least 32/);
    expect(() =>
      loadVoicePhotoJsonMonitorConfig({
        ...enabled,
        VOICE_PHOTOS_STATE_DB: '/var/lib/agentdesk/voice-json.sqlite',
      }),
    ).toThrow(/must differ/);
    expect(() =>
      loadVoicePhotoJsonMonitorConfig({
        ...enabled,
        VOICE_PHOTOS_SCENE_ROUTES_JSON: JSON.stringify({
          场景一: {
            resource: 'tbl_physical',
            measurementField: '转速',
            acceptedUnits: ['rpm'],
            valueType: 'number',
            staticFields: { 批次: '测试版本' },
          },
        }),
      }),
    ).toThrow(/logical resource alias/);
  });
});
