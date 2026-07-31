import { describe, expect, it } from 'vitest';

import { createVoicePhotoImageAdapter, loadEnabledVoicePhotoImageConfig } from './image-adapter.js';

const configured = {
  VOICE_PHOTOS_ROOT: '/mnt/voice_photos',
  VOICE_PHOTOS_STATE_DB: '/var/lib/agentdesk/voice-images.sqlite',
  VOICE_PHOTOS_FEISHU_TARGET: 'feishu:p2p:ou_test',
  FEISHU_APP_ID: 'cli_test',
  FEISHU_APP_SECRET: 'secret',
};

describe('voice photo image adapter', () => {
  it('preserves implicit enablement for an existing configured P2P monitor', () => {
    const config = loadEnabledVoicePhotoImageConfig(configured);
    expect(config?.stateDbPath).toBe('/var/lib/agentdesk/voice-images.sqlite');
    expect(config?.feishuTarget).toBe('feishu:p2p:ou_test');
  });

  it('can disable images independently from JSON ingestion', () => {
    expect(
      loadEnabledVoicePhotoImageConfig({
        ...configured,
        VOICE_PHOTOS_IMAGE_MONITOR_ENABLED: 'false',
        VOICE_PHOTOS_JSON_MONITOR_ENABLED: 'true',
      }),
    ).toBeNull();
  });

  it('registers the restored monitor behind the ChannelAdapter lifecycle', () => {
    const config = loadEnabledVoicePhotoImageConfig(configured);
    if (!config) throw new Error('expected configured image monitor');
    const adapter = createVoicePhotoImageAdapter(config);
    expect(adapter.channelType).toBe('voice-photo-image-monitor');
    expect(adapter.isConnected()).toBe(false);
  });
});
