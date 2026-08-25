import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdkCapture = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => Promise<unknown>>,
  started: false,
  closed: false,
}));

vi.mock('@larksuiteoapi/node-sdk', () => {
  class EventDispatcher {
    register(handlers: Record<string, (data: unknown) => Promise<unknown>>): this {
      Object.assign(sdkCapture.handlers, handlers);
      return this;
    }
  }

  class WSClient {
    constructor(private readonly options: { onReady?: () => void }) {}

    async start(): Promise<void> {
      sdkCapture.started = true;
      this.options.onReady?.();
    }

    close(): void {
      sdkCapture.closed = true;
    }
  }

  return {
    EventDispatcher,
    LoggerLevel: { error: 'error' },
    WSClient,
  };
});

vi.mock('../db/inbound-dedup.js', () => ({
  markInboundSeen: () => true,
}));

import type { ChannelSetup } from './adapter.js';
import { createFeishuAdapter } from './feishu.js';
import type { FeishuConfig } from './feishu/types.js';

function config(): FeishuConfig {
  return {
    appId: 'cli_0123456789abcdef',
    appSecret: 'app_secret',
    webhookPath: '/webhook/feishu',
    baseUrl: 'https://open.feishu.cn',
    requestTimeoutMs: 15_000,
    bodyTimeoutMs: 10_000,
    maxBodyBytes: 1024,
    eventMode: 'long-connection',
  };
}

function setupConfig(onAction = vi.fn()): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction,
  };
}

describe('Feishu long-connection callbacks', () => {
  beforeEach(() => {
    sdkCapture.handlers = {};
    sdkCapture.started = false;
    sdkCapture.closed = false;
  });

  it('registers card.action.trigger and acknowledges a valid confirmation click', async () => {
    const onAction = vi.fn();
    const adapter = createFeishuAdapter(config());
    await adapter.setup(setupConfig(onAction));

    expect(sdkCapture.started).toBe(true);
    expect(sdkCapture.handlers).toHaveProperty('im.message.receive_v1');
    expect(sdkCapture.handlers).toHaveProperty('card.action.trigger');

    const response = await sdkCapture.handlers['card.action.trigger']({
      operator: { open_id: 'ou_requester' },
      token: 'card-action-token',
      action: {
        value: {
          kind: 'card.ask_question',
          questionId: 'question-1',
          selectedOption: 'confirm',
          expectedUserId: 'ou_requester',
          expiresAt: Date.now() + 60_000,
        },
      },
      context: { chat_id: 'oc_p2p' },
    });

    expect(response).toEqual({});
    expect(onAction).toHaveBeenCalledOnce();
    expect(onAction).toHaveBeenCalledWith('question-1', 'confirm', 'ou_requester');

    await adapter.teardown();
    expect(sdkCapture.closed).toBe(true);
  });

  it('acknowledges malformed card actions without dispatching them', async () => {
    const onAction = vi.fn();
    const adapter = createFeishuAdapter(config());
    await adapter.setup(setupConfig(onAction));

    await expect(sdkCapture.handlers['card.action.trigger']({ unsupported: true })).resolves.toEqual({});
    expect(onAction).not.toHaveBeenCalled();
  });
});
