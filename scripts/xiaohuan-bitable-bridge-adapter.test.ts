import { describe, expect, it, vi } from 'vitest';

import type { ChannelSetup, InboundEvent } from '../src/channels/adapter.js';
import {
  createXiaohuanBitableAdapter,
  XIAOHUAN_BITABLE_CHANNEL_TYPE,
  type BridgeAdapterLogger,
} from '../examples/xiaohuan-bitable-bridge/adapter.js';
import type { EnabledBridgeConfig } from '../examples/xiaohuan-bitable-bridge/config.js';
import {
  BRIDGE_WORKFLOW_STEPS,
  type XiaohuanBitableBridgeEnvelope,
} from '../examples/xiaohuan-bitable-bridge/envelope.js';
import { mapExperimentFields } from '../examples/xiaohuan-bitable-bridge/mapper.js';
import type { ExperimentAudioV1 } from '../examples/xiaohuan-doubao-audio/experiment-schema.js';
import type {
  RunningWholeUtteranceHttpService,
  WholeUtteranceHttpDependencies,
  WholeUtteranceHttpOutput,
  WholeUtteranceHttpSummary,
} from '../examples/xiaohuan-doubao-audio/whole-utterance-http-service.js';
import type {
  GatewayConfirmationDeliveredEvent,
  GatewayConfirmationDeliveredListener,
  GatewayConfirmationResolvedEvent,
  GatewayConfirmationResolvedListener,
} from '../src/modules/gateway-confirmation/events.js';
import type { AgentTurnResolvedEvent, AgentTurnResolvedListener } from '../src/modules/agent-turn/events.js';
const summary: WholeUtteranceHttpSummary = {
  received: 1,
  duplicates: 0,
  succeeded: 1,
  failed: 0,
  rejected: 0,
};

function bridgeConfig(): EnabledBridgeConfig {
  return {
    enabled: true,
    authenticatedUserId: 'canonical-user-1',
    platformId: 'feishu:p2p:ou_canonical1',
    senderIdentity: {
      provider: 'feishu',
      providerScope: 'cli_app_a',
      identifierType: 'open_id',
      externalSubject: 'ou_canonical1',
    },
    feishuTranscriptMirrorEnabled: false,
    resource: 'lab.experiments',
    fieldMap: {
      captureId: 'Capture ID',
      transcript: 'Transcript',
      'experiment.sampleIds': 'Samples',
      'experiment.measurements': 'Measurements',
      'experiment.notes': 'Notes',
    },
    joinSeparator: ' | ',
    maxFieldValueBytes: 8_192,
    httpService: {
      bindHost: '127.0.0.1',
      port: 50_020,
      maxBodyBytes: 4 * 1024 * 1024,
      maxDurationMs: 20_000,
      expectedSampleRate: 16_000,
      maxQueue: 4,
      requestTimeoutMs: 10_000,
      keepUtterances: false,
    },
    audio: {
      ark: {
        baseUrl: 'https://ark.example.test/api/v3',
        apiKey: 'test-only-key',
        model: 'test-audio-model',
      },
      requestTimeoutMs: 60_000,
      maxWavBytes: 10 * 1024 * 1024,
      maxWavDurationMs: 20_000,
    },
  };
}

function experiment(captureId = 'bridge-test-000001'): ExperimentAudioV1 {
  return {
    schemaVersion: 'experiment-audio.v1',
    captureId,
    transcript: '样品 A 温度为二十五度。',
    experiment: {
      title: null,
      sampleIds: ['A'],
      actions: [],
      measurements: [{ name: '温度', value: 25, unit: '°C' }],
      observations: [],
      notes: null,
    },
  };
}

function output(result: ExperimentAudioV1): WholeUtteranceHttpOutput {
  return {
    captureId: result.captureId,
    result,
  };
}

function loggerHarness(): {
  logger: BridgeAdapterLogger;
  events: Record<string, unknown>[];
} {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    logger: {
      info: (event) => events.push(event),
      error: (event) => events.push(event),
    },
  };
}

function serviceHarness(): {
  start: ReturnType<typeof vi.fn>;
  dependencies: () => WholeUtteranceHttpDependencies;
  running: () => RunningWholeUtteranceHttpService;
} {
  let captured: WholeUtteranceHttpDependencies | undefined;
  let running: RunningWholeUtteranceHttpService | undefined;
  const start = vi.fn(
    async (
      _config: EnabledBridgeConfig['httpService'],
      dependencies: WholeUtteranceHttpDependencies,
    ): Promise<RunningWholeUtteranceHttpService> => {
      captured = dependencies;
      let resolveDone: (value: WholeUtteranceHttpSummary) => void = () => undefined;
      const done = new Promise<WholeUtteranceHttpSummary>((resolve) => {
        resolveDone = resolve;
      });
      const close = vi.fn(async () => {
        resolveDone(summary);
        return summary;
      });
      running = {
        bindHost: '127.0.0.1',
        port: 50_020,
        outputRoot: '/tmp/xiaohuan-http-test',
        done,
        close,
      };
      return running;
    },
  );
  return {
    start,
    dependencies: () => {
      if (!captured) throw new Error('service was not started');
      return captured;
    },
    running: () => {
      if (!running) throw new Error('service was not started');
      return running;
    },
  };
}

function setupHarness(onInboundEvent?: (event: InboundEvent) => void | Promise<void>): {
  setup: ChannelSetup;
  events: InboundEvent[];
} {
  const events: InboundEvent[] = [];
  return {
    events,
    setup: {
      onInbound: () => undefined,
      onInboundEvent: async (event) => {
        events.push(event);
        await onInboundEvent?.(event);
      },
      onMetadata: () => undefined,
      onAction: () => undefined,
    },
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Xiaohuan Bitable bridge ChannelAdapter', () => {
  it('satisfies ingress-only identity and thread semantics', async () => {
    const adapter = createXiaohuanBitableAdapter(bridgeConfig());
    expect(adapter).toMatchObject({
      name: XIAOHUAN_BITABLE_CHANNEL_TYPE,
      channelType: XIAOHUAN_BITABLE_CHANNEL_TYPE,
      supportsThreads: false,
    });
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.deliver('anything', null, { kind: 'chat', content: {} })).rejects.toMatchObject({
      code: 'INGRESS_ONLY_CHANNEL',
    });
  });

  it('validates before starting the listener and fails closed', async () => {
    const service = serviceHarness();
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(() => {
        throw Object.assign(new Error('operator path detail'), { code: 'INVALID_HTTP_AUDIO' });
      }),
      startHttpService: service.start,
      logger: loggerHarness().logger,
    });

    await expect(adapter.setup(setupHarness().setup)).rejects.toMatchObject({
      code: 'INVALID_HTTP_AUDIO',
    });
    expect(service.start).not.toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });

  it('preflights the canonical user and P2P route before HTTP listener validation', async () => {
    const validateHttpConfig = vi.fn();
    const startHttpService = vi.fn();
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(() => {
        throw Object.assign(new Error('unknown canonical user'), {
          code: 'CANONICAL_USER_NOT_FOUND',
        });
      }),
      validateHttpConfig,
      startHttpService,
      logger: loggerHarness().logger,
    });

    await expect(adapter.setup(setupHarness().setup)).rejects.toMatchObject({
      code: 'CANONICAL_USER_NOT_FOUND',
    });
    expect(validateHttpConfig).not.toHaveBeenCalled();
    expect(startHttpService).not.toHaveBeenCalled();
  });

  it('wraps one valid result as trusted Feishu P2P ingress with a controlled workflow', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: logs.logger,
      now: () => new Date('2026-07-30T06:00:00.000Z'),
    });

    await adapter.setup(host.setup);
    expect(adapter.isConnected()).toBe(true);
    service.dependencies().onOutput?.(output(experiment()));
    await flushPromises();

    expect(host.events).toHaveLength(1);
    const event = host.events[0]!;
    expect(event).toMatchObject({
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_canonical1',
      threadId: null,
      authenticatedUserId: 'canonical-user-1',
      senderIdentity: {
        provider: 'feishu',
        providerScope: 'cli_app_a',
        identifierType: 'open_id',
        externalSubject: 'ou_canonical1',
      },
      message: {
        kind: 'chat',
        timestamp: '2026-07-30T06:00:00.000Z',
        isMention: true,
        isGroup: false,
      },
    });
    expect(event.message.id).toMatch(/^xiaohuan-bitable-[a-f0-9]{64}-attempt-1$/);
    const chat = JSON.parse(event.message.content) as {
      text: string;
      displayText: string;
      sender: string;
    };
    const envelope = JSON.parse(chat.text) as XiaohuanBitableBridgeEnvelope;
    expect(chat.sender).toBe('Xiaohuan Bitable Bridge');
    expect(chat.displayText).toBe('语音指令：样品 A 温度为二十五度。');
    expect(envelope).toMatchObject({
      schemaVersion: 'xiaohuan-bitable-bridge.v1',
      kind: 'feishu.bitable.record.create.draft',
      resource: 'lab.experiments',
      captureId: 'bridge-test-000001',
      transcript: '样品 A 温度为二十五度。',
      fields: {
        'Capture ID': 'bridge-test-000001',
        Transcript: '样品 A 温度为二十五度。',
        Samples: 'A',
      },
      workflow: {
        operation: 'feishu.bitable.record.create',
        constraints: {
          logicalResourceLocked: true,
          mappingTargetsLocked: true,
          preserveTranscript: true,
          normalizationEvidenceRequired: true,
          selectOptionsLocked: true,
          stopOnAmbiguity: true,
          confirmation: 'host-mediated-original-user',
          executeOnlyAfterApproval: true,
          verifyCreatedRecordById: true,
          stopOnAnyFailure: true,
        },
      },
    });
    expect(envelope.workflow.steps).toEqual(BRIDGE_WORKFLOW_STEPS);
    expect(envelope.fieldMapping).toEqual(bridgeConfig().fieldMap);
    expect(envelope.idempotencyKey).toBe(`xiaohuan-bitable-create-${envelope.requestFingerprint}`);
    expect(envelope.experiment).toEqual(experiment());
    expect(event.message.content).not.toContain('test-only-key');

    await adapter.teardown();
    expect(adapter.isConnected()).toBe(false);
  });

  it('mirrors the concise transcript once to the fixed Feishu P2P route', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const config = bridgeConfig();
    config.feishuTranscriptMirrorEnabled = true;
    const mirrorTranscript = vi.fn(async () => 'om_transcript_1');
    const adapter = createXiaohuanBitableAdapter(config, {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: logs.logger,
      mirrorTranscript,
      fingerprint: () => 'a'.repeat(64),
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment()));
    await flushPromises();

    expect(mirrorTranscript).toHaveBeenCalledTimes(1);
    expect(mirrorTranscript).toHaveBeenCalledWith({
      platformId: 'feishu:p2p:ou_canonical1',
      text: '语音指令：样品 A 温度为二十五度。',
    });
    expect(logs.events).toContainEqual(
      expect.objectContaining({
        event: 'xiaohuan_feishu_transcript_mirrored',
        outcome: 'ok',
        platformMessageId: 'om_transcript_1',
      }),
    );

    await adapter.teardown();
  });

  it('queues later drafts until the matching Host confirmation resolves', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let deliveredListener: GatewayConfirmationDeliveredListener | undefined;
    let resolvedListener: GatewayConfirmationResolvedListener | undefined;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
      fingerprint: () => fingerprints.shift()!,
      onConfirmationDelivered: (listener) => {
        deliveredListener = listener;
        return () => undefined;
      },
      onConfirmationResolved: (listener) => {
        resolvedListener = listener;
        return () => undefined;
      },
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment('bridge-test-000001')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-000002')));
    await flushPromises();
    expect(host.events).toHaveLength(1);

    const delivered: GatewayConfirmationDeliveredEvent = {
      confirmationId: 'confirm-1',
      kind: 'create',
      requesterUserId: 'canonical-user-1',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_canonical1',
      threadId: null,
      resource: 'lab.experiments',
      correlationId: 'a'.repeat(64),
    };
    deliveredListener?.(delivered);
    const resolved: GatewayConfirmationResolvedEvent = {
      confirmationId: 'confirm-1',
      kind: 'create',
      status: 'approved',
      requesterUserId: 'canonical-user-1',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_canonical1',
      threadId: null,
    };
    resolvedListener?.({ ...resolved, platformId: 'feishu:p2p:ou_other' });
    await flushPromises();
    expect(host.events).toHaveLength(1);

    resolvedListener?.(resolved);
    await flushPromises();
    expect(host.events).toHaveLength(2);
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}-attempt-1`);

    await adapter.teardown();
  });

  it('releases a draft that never reaches confirmation and bounds the waiting queue', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const config = bridgeConfig();
    config.httpService.maxQueue = 1;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(config, {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: logs.logger,
      activeDraftMaxMs: 10,
      fingerprint: () => fingerprints.shift()!,
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment('bridge-test-000001')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-000002')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-000003')));
    await flushPromises();
    expect(host.events).toHaveLength(1);
    expect(logs.events).toContainEqual(
      expect.objectContaining({
        stage: 'confirmation-queue',
        code: 'CONFIRMATION_QUEUE_OVERFLOW',
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    await flushPromises();
    expect(host.events).toHaveLength(2);
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}-attempt-1`);

    await adapter.teardown();
  });

  it('releases the next draft when an Agent turn completes without a confirmation', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let turnListener: AgentTurnResolvedListener | undefined;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
      fingerprint: () => fingerprints.shift()!,
      turnSettleMs: 1,
      onAgentTurnResolved: (listener) => {
        turnListener = listener;
        return () => undefined;
      },
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment('bridge-test-000001')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-000002')));
    await flushPromises();
    expect(host.events).toHaveLength(1);

    const turn: AgentTurnResolvedEvent = {
      sessionId: 'session-1',
      sourceMessageId: `${host.events[0]!.message.id}:frontdesk-group`,
      status: 'completed',
      retryable: false,
    };
    turnListener?.(turn);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushPromises();

    expect(host.events).toHaveLength(2);
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}-attempt-1`);
    await adapter.teardown();
  });

  it('retries a transient provider failure with one fingerprint and a unique attempt id', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let turnListener: AgentTurnResolvedListener | undefined;
    const fingerprint = 'a'.repeat(64);
    const fingerprintFn = vi.fn(() => fingerprint);
    const config = bridgeConfig();
    config.feishuTranscriptMirrorEnabled = true;
    const mirrorTranscript = vi.fn(async () => 'om_transcript_retry');
    const adapter = createXiaohuanBitableAdapter(config, {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
      fingerprint: fingerprintFn,
      mirrorTranscript,
      retryDelaysMs: [1, 1],
      onAgentTurnResolved: (listener) => {
        turnListener = listener;
        return () => undefined;
      },
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment()));
    await flushPromises();
    expect(host.events[0]?.message.id).toBe(`xiaohuan-bitable-${fingerprint}-attempt-1`);

    turnListener?.({
      sessionId: 'session-1',
      sourceMessageId: `${host.events[0]!.message.id}:frontdesk-group`,
      status: 'provider-failed',
      code: 'gateway_5xx',
      retryable: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await flushPromises();

    expect(host.events).toHaveLength(2);
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${fingerprint}-attempt-2`);
    expect(fingerprintFn).toHaveBeenCalledOnce();
    const firstEnvelope = JSON.parse(
      (JSON.parse(host.events[0]!.message.content) as { text: string }).text,
    ) as XiaohuanBitableBridgeEnvelope;
    const secondEnvelope = JSON.parse(
      (JSON.parse(host.events[1]!.message.content) as { text: string }).text,
    ) as XiaohuanBitableBridgeEnvelope;
    expect(secondEnvelope.requestFingerprint).toBe(firstEnvelope.requestFingerprint);
    expect(secondEnvelope.idempotencyKey).toBe(firstEnvelope.idempotencyKey);
    expect(mirrorTranscript).toHaveBeenCalledOnce();
    await adapter.teardown();
  });

  it('serializes five completed turns without leaving a stale active draft', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let turnListener: AgentTurnResolvedListener | undefined;
    const fingerprints = Array.from({ length: 5 }, (_, index) => String(index + 1).repeat(64));
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
      fingerprint: () => fingerprints.shift()!,
      turnSettleMs: 1,
      onAgentTurnResolved: (listener) => {
        turnListener = listener;
        return () => undefined;
      },
    });

    await adapter.setup(host.setup);
    for (let index = 1; index <= 5; index += 1) {
      service.dependencies().onOutput?.(output(experiment(`bridge-test-${index}`)));
    }
    await flushPromises();
    expect(host.events).toHaveLength(1);

    for (let index = 0; index < 5; index += 1) {
      const current = host.events[index];
      expect(current).toBeDefined();
      turnListener?.({
        sessionId: 'session-1',
        sourceMessageId: `${current!.message.id}:frontdesk-group`,
        status: 'completed',
        retryable: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await flushPromises();
      expect(host.events).toHaveLength(Math.min(index + 2, 5));
    }

    expect(host.events.map((event) => event.message.id)).toEqual(
      Array.from({ length: 5 }, (_, index) => `xiaohuan-bitable-${String(index + 1).repeat(64)}-attempt-1`),
    );
    await adapter.teardown();
  });

  it('keeps the queue blocked when a confirmation arrives during the completion settle window', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let turnListener: AgentTurnResolvedListener | undefined;
    let deliveredListener: GatewayConfirmationDeliveredListener | undefined;
    let resolvedListener: GatewayConfirmationResolvedListener | undefined;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
      fingerprint: () => fingerprints.shift()!,
      turnSettleMs: 10,
      onAgentTurnResolved: (listener) => {
        turnListener = listener;
        return () => undefined;
      },
      onConfirmationDelivered: (listener) => {
        deliveredListener = listener;
        return () => undefined;
      },
      onConfirmationResolved: (listener) => {
        resolvedListener = listener;
        return () => undefined;
      },
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment('bridge-test-1')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-2')));
    await flushPromises();
    turnListener?.({
      sessionId: 'session-1',
      sourceMessageId: host.events[0]!.message.id,
      status: 'completed',
      retryable: false,
    });
    deliveredListener?.({
      confirmationId: 'confirm-late',
      kind: 'create',
      requesterUserId: 'canonical-user-1',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_canonical1',
      threadId: null,
      resource: 'lab.experiments',
      correlationId: 'a'.repeat(64),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.events).toHaveLength(1);

    resolvedListener?.({
      confirmationId: 'confirm-late',
      kind: 'create',
      status: 'approved',
      requesterUserId: 'canonical-user-1',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_canonical1',
      threadId: null,
    });
    await flushPromises();
    expect(host.events).toHaveLength(2);
    await adapter.teardown();
  });

  it('releases the next queued draft after transient retries are exhausted', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let turnListener: AgentTurnResolvedListener | undefined;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
      fingerprint: () => fingerprints.shift()!,
      retryDelaysMs: [1, 1],
      onAgentTurnResolved: (listener) => {
        turnListener = listener;
        return () => undefined;
      },
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment('bridge-test-1')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-2')));
    await flushPromises();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = host.events[attempt]!;
      turnListener?.({
        sessionId: 'session-1',
        sourceMessageId: current.message.id,
        status: 'provider-failed',
        code: 'gateway_5xx',
        retryable: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await flushPromises();
    }

    expect(host.events).toHaveLength(4);
    expect(host.events.slice(0, 3).map((event) => event.message.id)).toEqual([
      `xiaohuan-bitable-${'a'.repeat(64)}-attempt-1`,
      `xiaohuan-bitable-${'a'.repeat(64)}-attempt-2`,
      `xiaohuan-bitable-${'a'.repeat(64)}-attempt-3`,
    ]);
    expect(host.events[3]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}-attempt-1`);
    await adapter.teardown();
  });

  it('isolates model, mapping and Host ingress failures and accepts a later utterance', async () => {
    const service = serviceHarness();
    const host = setupHarness(async (event) => {
      if (event.message.id.includes('a'.repeat(64))) {
        throw new Error('private Host routing detail');
      }
    });
    const logs = loggerHarness();
    let mapCalls = 0;
    let fingerprints = 0;
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: logs.logger,
      mapFields: (result, fieldMap, options) => {
        mapCalls += 1;
        if (mapCalls === 1) {
          throw Object.assign(new Error('full mapped value is secret'), {
            code: 'FIELD_VALUE_TOO_LARGE',
          });
        }
        return mapExperimentFields(result, fieldMap, options);
      },
      fingerprint: () => {
        fingerprints += 1;
        return fingerprints === 1 ? 'a'.repeat(64) : 'b'.repeat(64);
      },
      idempotencyKey: (value) => `idem-${value}`,
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.({
      captureId: 'bridge-test-failed-model',
      errorCode: 'INVALID_STRUCTURED_OUTPUT',
    });
    service.dependencies().onOutput?.(output(experiment('bridge-test-map-failure')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-host-failure')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-success')));
    await flushPromises();

    expect(host.events).toHaveLength(2);
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}-attempt-1`);
    const serializedLogs = JSON.stringify(logs.events);
    expect(serializedLogs).toContain('INVALID_STRUCTURED_OUTPUT');
    expect(serializedLogs).toContain('FIELD_VALUE_TOO_LARGE');
    expect(serializedLogs).toContain('HOST_INBOUND_FAILED');
    expect(serializedLogs).not.toContain('full mapped value is secret');
    expect(serializedLogs).not.toContain('private Host routing detail');

    await adapter.teardown();
  });

  it('delivers mapping and evidence when every preliminary value is unresolved', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const config = bridgeConfig();
    config.fieldMap = { 'experiment.notes': 'Notes' };
    const adapter = createXiaohuanBitableAdapter(config, {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: logs.logger,
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment()));
    await flushPromises();
    expect(host.events).toHaveLength(1);
    const chat = JSON.parse(host.events[0]!.message.content) as { text: string };
    const envelope = JSON.parse(chat.text) as XiaohuanBitableBridgeEnvelope;
    expect(envelope.fields).toEqual({});
    expect(envelope.fieldMapping).toEqual({ 'experiment.notes': 'Notes' });
    await adapter.teardown();
  });

  it('closes the HTTP service and waits for an already-started Host delivery on teardown', async () => {
    const service = serviceHarness();
    let finishDelivery: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const host = setupHarness(() => delivery);
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService: service.start,
      logger: loggerHarness().logger,
    });

    await adapter.setup(host.setup);
    service.dependencies().onOutput?.(output(experiment()));
    await flushPromises();
    const teardown = adapter.teardown();
    let stopped = false;
    void teardown.then(() => {
      stopped = true;
    });
    await flushPromises();

    expect(service.running().close).toHaveBeenCalledOnce();
    expect(stopped).toBe(false);
    finishDelivery?.();
    await teardown;
    expect(stopped).toBe(true);

    service.dependencies().onOutput?.(output(experiment('bridge-test-too-late')));
    await flushPromises();
    expect(host.events).toHaveLength(1);
  });

  it('drains a pre-teardown utterance emitted while the HTTP service closes', async () => {
    const host = setupHarness();
    let captured: WholeUtteranceHttpDependencies | undefined;
    const startHttpService = vi.fn(
      async (
        _config: EnabledBridgeConfig['httpService'],
        dependencies: WholeUtteranceHttpDependencies,
      ): Promise<RunningWholeUtteranceHttpService> => {
        captured = dependencies;
        let resolveDone: (value: WholeUtteranceHttpSummary) => void = () => undefined;
        const done = new Promise<WholeUtteranceHttpSummary>((resolve) => {
          resolveDone = resolve;
        });
        return {
          bindHost: '127.0.0.1',
          port: 50_020,
          outputRoot: '/tmp/xiaohuan-http-test',
          done,
          close: async () => {
            await dependencies.onOutput?.(output(experiment('bridge-test-drained')));
            resolveDone(summary);
            return summary;
          },
        };
      },
    );
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateHttpConfig: vi.fn(),
      startHttpService,
      logger: loggerHarness().logger,
    });

    await adapter.setup(host.setup);
    expect(captured).toBeDefined();
    await adapter.teardown();
    expect(host.events).toHaveLength(1);
    const chat = JSON.parse(host.events[0]!.message.content) as { text: string };
    expect(JSON.parse(chat.text)).toMatchObject({ captureId: 'bridge-test-drained' });
  });
});
