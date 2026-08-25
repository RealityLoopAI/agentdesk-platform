import fs from 'node:fs/promises';
import path from 'node:path';

import type { ChannelAdapter } from '../../src/channels/adapter.js';
import {
  createFeishuOutboundImageTransport,
  normalizeFeishuP2pTarget,
} from '../../src/channels/feishu/outbound-image.js';
import { log } from '../../src/log.js';
import { loadVoicePhotoMonitorConfig, safeVoicePhotoMonitorConfig, type VoicePhotoMonitorConfig } from './config.js';
import { VoicePhotoMonitor, type VoicePhotoLogger } from './service.js';
import { VoicePhotoState } from './state.js';

export const VOICE_PHOTO_IMAGE_CHANNEL_TYPE = 'voice-photo-image-monitor';

function enabled(env: NodeJS.ProcessEnv): boolean {
  const explicit = env.VOICE_PHOTOS_IMAGE_MONITOR_ENABLED?.trim();
  if (explicit === 'true') return true;
  if (explicit === 'false') return false;
  if (explicit) throw new Error('VOICE_PHOTOS_IMAGE_MONITOR_ENABLED must be true or false');
  return Boolean(env.VOICE_PHOTOS_FEISHU_TARGET?.trim());
}

export function loadEnabledVoicePhotoImageConfig(env: NodeJS.ProcessEnv = process.env): VoicePhotoMonitorConfig | null {
  return enabled(env) ? loadVoicePhotoMonitorConfig(env) : null;
}

export function createVoicePhotoImageAdapter(config: VoicePhotoMonitorConfig): ChannelAdapter {
  let controller: AbortController | null = null;
  let monitor: VoicePhotoMonitor | null = null;
  let servicePromise: Promise<void> | null = null;
  const logger: VoicePhotoLogger = {
    info: (event) => log.info('Voice photo image monitor', event),
    warn: (event) => log.warn('Voice photo image monitor', event),
    error: (event) => log.error('Voice photo image monitor', event),
  };

  return {
    name: 'Voice photo image monitor',
    channelType: VOICE_PHOTO_IMAGE_CHANNEL_TYPE,
    supportsThreads: false,
    async setup() {
      await fs.mkdir(path.dirname(config.stateDbPath), { recursive: true, mode: 0o700 });
      const state = new VoicePhotoState(config.stateDbPath);
      const sender = createFeishuOutboundImageTransport({
        appId: config.feishuAppId,
        appSecret: config.feishuAppSecret,
        baseUrl: config.feishuBaseUrl,
        requestTimeoutMs: config.feishuRequestTimeoutMs,
      });
      monitor = new VoicePhotoMonitor(config, {
        state,
        sender,
        target: normalizeFeishuP2pTarget(config.feishuTarget),
        logger,
      });
      controller = new AbortController();
      logger.info({
        event: 'voice_photo_image_monitor_starting',
        config: safeVoicePhotoMonitorConfig(config),
      });
      servicePromise = monitor.run(controller.signal).catch((error: unknown) => {
        logger.error({
          event: 'voice_photo_image_monitor_failed',
          errorName: error instanceof Error ? error.name : 'UnknownError',
          message: error instanceof Error ? error.message.slice(0, 256) : 'Unexpected failure',
        });
        controller?.abort();
      });
    },
    async teardown() {
      controller?.abort();
      await servicePromise;
      monitor?.close();
      controller = null;
      monitor = null;
      servicePromise = null;
    },
    isConnected: () => controller !== null && !controller.signal.aborted,
    async deliver() {
      return undefined;
    },
  };
}
