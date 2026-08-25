import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { ChannelAdapter, ChannelSetup } from '../../src/channels/adapter.js';
import { getMessagingGroupWithAgentCount } from '../../src/db/messaging-groups.js';
import { getUser } from '../../src/modules/permissions/db/users.js';
import { log } from '../../src/log.js';
import type { VoicePhotoJsonMonitorConfig } from './json-config.js';
import { VoicePhotoJsonService, type VoicePhotoJsonEnvelope } from './json-service.js';
import { VoicePhotoJsonState } from './json-state.js';

export const VOICE_PHOTO_JSON_CHANNEL_TYPE = 'voice-photo-json';

function parseWorkerResult(content: unknown): {
  digest: string;
  status: 'verified' | 'failed';
  recordId?: string;
} | null {
  let candidate = content;
  if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && 'text' in candidate) {
    candidate = (candidate as { text?: unknown }).text;
  }
  if (typeof candidate === 'string') {
    const source = candidate
      .trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '');
    try {
      candidate = JSON.parse(source);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  const value = candidate as Record<string, unknown>;
  if (
    value.schemaVersion !== 'voice-photo-json-result.v1' ||
    typeof value.digest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    (value.status !== 'verified' && value.status !== 'failed')
  ) {
    return null;
  }
  return {
    digest: value.digest,
    status: value.status,
    recordId:
      value.status === 'verified' && typeof value.recordId !== 'string'
        ? undefined
        : typeof value.recordId === 'string'
          ? value.recordId
          : undefined,
  };
}

export function createVoicePhotoJsonAdapter(config: VoicePhotoJsonMonitorConfig): ChannelAdapter {
  let setup: ChannelSetup | null = null;
  let controller: AbortController | null = null;
  let servicePromise: Promise<void> | null = null;
  let state: VoicePhotoJsonState | null = null;

  const submit = async (envelope: VoicePhotoJsonEnvelope): Promise<void> => {
    if (!setup) throw new Error('VOICE_PHOTO_JSON_ADAPTER_NOT_READY');
    await setup.onInboundEvent({
      channelType: VOICE_PHOTO_JSON_CHANNEL_TYPE,
      platformId: config.platformId,
      threadId: envelope.source.digest,
      authenticatedUserId: config.authenticatedUserId,
      message: {
        id: `voice-photo-json:${envelope.source.digest}:${randomUUID()}`,
        kind: 'chat',
        content: JSON.stringify({ text: JSON.stringify(envelope) }),
        timestamp: new Date().toISOString(),
        isMention: true,
        isGroup: false,
      },
    });
  };

  return {
    name: 'Voice photo JSON Bitable ingest',
    channelType: VOICE_PHOTO_JSON_CHANNEL_TYPE,
    supportsThreads: true,
    async setup(hostSetup) {
      if (!getUser(config.authenticatedUserId)) throw new Error('VOICE_PHOTO_JSON_USER_NOT_FOUND');
      const route = getMessagingGroupWithAgentCount(VOICE_PHOTO_JSON_CHANNEL_TYPE, config.platformId);
      if (!route || route.agentCount !== 1) throw new Error('VOICE_PHOTO_JSON_ROUTE_NOT_WIRED_TO_ONE_WORKER');
      await fs.mkdir(path.dirname(config.stateDbPath), { recursive: true, mode: 0o700 });
      setup = hostSetup;
      state = new VoicePhotoJsonState(config.stateDbPath);
      controller = new AbortController();
      const service = new VoicePhotoJsonService(config, {
        state,
        submit,
        log: (event) => log.info('Voice photo JSON monitor', event),
      });
      servicePromise = service.run(controller.signal);
    },
    async teardown() {
      controller?.abort();
      await servicePromise;
      state?.close();
      setup = null;
      controller = null;
      servicePromise = null;
      state = null;
    },
    isConnected: () => setup !== null && controller?.signal.aborted === false,
    async deliver(_platformId, _threadId, message) {
      const serialized = JSON.stringify(message.content);
      const result = parseWorkerResult(message.content);
      if (state && result?.status === 'failed') {
        state.retry(result.digest, Date.now());
      } else if (state && result?.status === 'verified' && result.recordId) {
        state.mark(result.digest, result.status, Date.now(), result.recordId);
      }
      log.info('Voice photo JSON worker result', {
        kind: message.kind,
        contentBytes: serialized.length,
        status: result?.status ?? 'unparseable',
      });
      return undefined;
    },
  };
}
