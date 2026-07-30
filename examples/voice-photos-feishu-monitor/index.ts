import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createFeishuOutboundImageTransport,
  normalizeFeishuP2pTarget,
} from '../../src/channels/feishu/outbound-image.js';
import { loadVoicePhotoMonitorConfig, safeVoicePhotoMonitorConfig } from './config.js';
import { VoicePhotoMonitor, type VoicePhotoLogger } from './service.js';
import { VoicePhotoState } from './state.js';

const logger: VoicePhotoLogger = {
  info: (fields) => console.log(JSON.stringify({ level: 'info', ...fields })),
  warn: (fields) => console.warn(JSON.stringify({ level: 'warn', ...fields })),
  error: (fields) => console.error(JSON.stringify({ level: 'error', ...fields })),
};

async function main(): Promise<void> {
  const config = loadVoicePhotoMonitorConfig();
  await fs.mkdir(path.dirname(config.stateDbPath), { recursive: true, mode: 0o700 });

  const state = new VoicePhotoState(config.stateDbPath);
  const sender = createFeishuOutboundImageTransport({
    appId: config.feishuAppId,
    appSecret: config.feishuAppSecret,
    baseUrl: config.feishuBaseUrl,
    requestTimeoutMs: config.feishuRequestTimeoutMs,
  });
  const monitor = new VoicePhotoMonitor(config, {
    state,
    sender,
    target: normalizeFeishuP2pTarget(config.feishuTarget),
    logger,
  });
  const controller = new AbortController();
  let stopping = false;
  let forcedExit: NodeJS.Timeout | undefined;
  const requestStop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ event: 'voice_photo_monitor_shutdown_requested', signal });
    controller.abort();
    forcedExit = setTimeout(() => {
      logger.error({ event: 'voice_photo_monitor_shutdown_deadline_exceeded' });
      process.exit(1);
    }, config.shutdownDeadlineMs);
    forcedExit.unref?.();
  };
  process.once('SIGINT', () => requestStop('SIGINT'));
  process.once('SIGTERM', () => requestStop('SIGTERM'));

  logger.info({ event: 'voice_photo_monitor_starting', config: safeVoicePhotoMonitorConfig(config) });
  try {
    await monitor.run(controller.signal);
  } finally {
    if (forcedExit) clearTimeout(forcedExit);
    monitor.close();
  }
}

main().catch((error: unknown) => {
  logger.error({
    event: 'voice_photo_monitor_fatal',
    errorName: error instanceof Error ? error.name : 'UnknownError',
    message: error instanceof Error ? error.message.slice(0, 256) : 'Unexpected failure',
  });
  process.exitCode = 1;
});
