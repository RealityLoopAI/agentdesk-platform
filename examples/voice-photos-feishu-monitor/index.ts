import { registerChannelAdapter } from '../../src/channels/channel-registry.js';
import { createVoicePhotoImageAdapter, loadEnabledVoicePhotoImageConfig } from './image-adapter.js';
import { createVoicePhotoJsonAdapter } from './json-adapter.js';
import { loadVoicePhotoJsonMonitorConfig } from './json-config.js';

export { createVoicePhotoImageAdapter } from './image-adapter.js';
export { createVoicePhotoJsonAdapter } from './json-adapter.js';

registerChannelAdapter('voice-photo-image-monitor', {
  factory: () => {
    const config = loadEnabledVoicePhotoImageConfig();
    return config ? createVoicePhotoImageAdapter(config) : null;
  },
});

registerChannelAdapter('voice-photo-json', {
  factory: () => {
    const config = loadVoicePhotoJsonMonitorConfig();
    return config.enabled ? createVoicePhotoJsonAdapter(config) : null;
  },
});
