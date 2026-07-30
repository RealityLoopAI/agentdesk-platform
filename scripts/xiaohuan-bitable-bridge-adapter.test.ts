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
  VadListeningServiceDependencies,
  VadServiceOutput,
  VadServiceSummary,
} from '../examples/xiaohuan-doubao-audio/vad-listening-service.js';
import type {
  GatewayConfirmationDeliveredEvent,
  GatewayConfirmationDeliveredListener,
  GatewayConfirmationResolvedEvent,
  GatewayConfirmationResolvedListener,
} from '../src/modules/gateway-confirmation/events.js';
import { createTtsReceiptKey } from '../examples/xiaohuan-bitable-bridge/tts-ack.js';

const summary: VadServiceSummary = {
  accepted: 1,
  succeeded: 1,
  failed: 0,
  discarded: 0,
};

function bridgeConfig(): EnabledBridgeConfig {
  return {
    enabled: true,
    authenticatedUserId: 'canonical-user-1',
    platformId: 'feishu:p2p:ou_canonical1',
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
    ttsAck: { enabled: false },
    vadService: {
      sdpPath: '/operator/xiaohuan.sdp',
      ffmpegPath: 'ffmpeg',
      vad: {
        sampleRate: 16_000,
        frameMs: 20,
        thresholdDb: -38,
        startFrames: 2,
        preRollMs: 200,
        trailingSilenceMs: 800,
        minSpeechMs: 300,
        maxUtteranceMs: 20_000,
      },
      maxQueue: 4,
      maxUtterances: 0,
      firstAudioTimeoutMs: 30_000,
      stopGraceMs: 3_000,
      keepUtterances: false,
      processUtterances: true,
      allowExternalUpload: true,
      capturePrefix: 'bridge-test',
      normalizePeakDb: -3,
      maxNormalizeGainDb: 30,
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

function output(result: ExperimentAudioV1): VadServiceOutput {
  return {
    captureId: result.captureId,
    index: 1,
    reason: 'silence',
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
  run: ReturnType<typeof vi.fn>;
  dependencies: () => VadListeningServiceDependencies;
} {
  let captured: VadListeningServiceDependencies | undefined;
  const run = vi.fn(
    async (
      _config: EnabledBridgeConfig['vadService'],
      dependencies: VadListeningServiceDependencies,
    ): Promise<VadServiceSummary> => {
      captured = dependencies;
      await new Promise<void>((resolve) => {
        if (dependencies.signal?.aborted) resolve();
        else dependencies.signal?.addEventListener('abort', () => resolve(), { once: true });
      });
      return summary;
    },
  );
  return {
    run,
    dependencies: () => {
      if (!captured) throw new Error('service was not started');
      return captured;
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
    await expect(adapter.deliver('anything', null, { kind: 'chat', content: {} }))
      .rejects.toMatchObject({ code: 'INGRESS_ONLY_CHANNEL' });
  });

  it('validates before starting the listener and fails closed', async () => {
    const service = serviceHarness();
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockRejectedValue(
        Object.assign(new Error('operator path detail'), { code: 'INVALID_SDP' }),
      ),
      runVadService: service.run,
      logger: loggerHarness().logger,
    });

    await expect(adapter.setup(setupHarness().setup)).rejects.toMatchObject({
      code: 'INVALID_SDP',
    });
    expect(service.run).not.toHaveBeenCalled();
    expect(adapter.isConnected()).toBe(false);
  });

  it('preflights the canonical user and P2P route before VAD validation', async () => {
    const validateVadConfig = vi.fn();
    const runVadService = vi.fn();
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(() => {
        throw Object.assign(new Error('unknown canonical user'), {
          code: 'CANONICAL_USER_NOT_FOUND',
        });
      }),
      validateVadConfig,
      runVadService,
      logger: loggerHarness().logger,
    });

    await expect(adapter.setup(setupHarness().setup)).rejects.toMatchObject({
      code: 'CANONICAL_USER_NOT_FOUND',
    });
    expect(validateVadConfig).not.toHaveBeenCalled();
    expect(runVadService).not.toHaveBeenCalled();
  });

  it('wraps one valid result as trusted Feishu P2P ingress with a controlled workflow', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
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
      message: {
        kind: 'chat',
        timestamp: '2026-07-30T06:00:00.000Z',
        isMention: true,
        isGroup: false,
      },
    });
    expect(event.message.id).toMatch(/^xiaohuan-bitable-[a-f0-9]{64}$/);
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
    expect(envelope.idempotencyKey).toBe(
      `xiaohuan-bitable-create-${envelope.requestFingerprint}`,
    );
    expect(envelope.experiment).toEqual(experiment());
    expect(event.message.content).not.toContain('test-only-key');

    await adapter.teardown();
    expect(adapter.isConnected()).toBe(false);
  });

  it('acknowledges a complete local WAV before Ark output or confirmation delivery', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const config = bridgeConfig();
    config.ttsAck = {
      enabled: true,
      baseUrl: 'http://192.168.66.133:18082',
      text: '收到',
      timeoutMs: 2_000,
    };
    let confirmationListener: GatewayConfirmationDeliveredListener | undefined;
    const unsubscribeDelivered = vi.fn();
    const receiptKey = createTtsReceiptKey('test-run', 'bridge-test-000001');
    const sendTtsAck = vi.fn(async () => ({
      requestId: `xiaohuan-received-${receiptKey}`,
      taskId: 'task-1',
      queuePosition: 1,
      duplicate: false,
    }));
    const adapter = createXiaohuanBitableAdapter(config, {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
      logger: logs.logger,
      createReceiptRunId: () => 'test-run',
      onConfirmationDelivered: (listener) => {
        confirmationListener = listener;
        return unsubscribeDelivered;
      },
      sendTtsAck,
    });

    await adapter.setup(host.setup);
    service.dependencies().onWavReady?.({
      captureId: 'bridge-test-000001',
      index: 1,
      reason: 'silence',
      metadata: {
        bytes: 32_044,
        durationMs: 1_000,
        sampleRate: 16_000,
        channels: 1,
        bitsPerSample: 16,
        audioFormat: 1,
        dataBytes: 32_000,
      },
    });
    await flushPromises();
    expect(host.events).toHaveLength(0);
    expect(sendTtsAck).toHaveBeenCalledOnce();
    expect(sendTtsAck).toHaveBeenCalledWith(config.ttsAck, receiptKey);
    expect(confirmationListener).toBeDefined();

    await confirmationListener?.({
      confirmationId: 'confirm-1',
      kind: 'create',
      requesterUserId: 'canonical-user-1',
      channelType: 'feishu',
      platformId: 'feishu:p2p:ou_canonical1',
      threadId: null,
      resource: 'lab.experiments',
      correlationId: 'c'.repeat(64),
    });
    expect(sendTtsAck).toHaveBeenCalledTimes(1);
    expect(logs.events).toContainEqual(
      expect.objectContaining({
        event: 'xiaohuan_tts_ack_accepted',
        outcome: 'ok',
      }),
    );

    await adapter.teardown();
    expect(unsubscribeDelivered).toHaveBeenCalledOnce();
  });

  it('queues later drafts until the matching Host confirmation resolves', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    let deliveredListener: GatewayConfirmationDeliveredListener | undefined;
    let resolvedListener: GatewayConfirmationResolvedListener | undefined;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
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
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}`);

    await adapter.teardown();
  });

  it('releases a draft that never reaches confirmation and bounds the waiting queue', async () => {
    const service = serviceHarness();
    const host = setupHarness();
    const logs = loggerHarness();
    const config = bridgeConfig();
    config.vadService.maxQueue = 1;
    const fingerprints = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const adapter = createXiaohuanBitableAdapter(config, {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
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
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}`);

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
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
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
      index: 1,
      reason: 'silence',
      errorCode: 'INVALID_STRUCTURED_OUTPUT',
    });
    service.dependencies().onOutput?.(output(experiment('bridge-test-map-failure')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-host-failure')));
    service.dependencies().onOutput?.(output(experiment('bridge-test-success')));
    await flushPromises();

    expect(host.events).toHaveLength(2);
    expect(host.events[1]?.message.id).toBe(`xiaohuan-bitable-${'b'.repeat(64)}`);
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
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
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

  it('aborts the service and waits for an already-started Host delivery on teardown', async () => {
    const service = serviceHarness();
    let finishDelivery: (() => void) | undefined;
    const delivery = new Promise<void>((resolve) => {
      finishDelivery = resolve;
    });
    const host = setupHarness(() => delivery);
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService: service.run,
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

    expect(service.dependencies().signal?.aborted).toBe(true);
    expect(stopped).toBe(false);
    finishDelivery?.();
    await teardown;
    expect(stopped).toBe(true);

    service.dependencies().onOutput?.(output(experiment('bridge-test-too-late')));
    await flushPromises();
    expect(host.events).toHaveLength(1);
  });

  it('drains a pre-teardown utterance emitted while the VAD service stops', async () => {
    const host = setupHarness();
    let captured: VadListeningServiceDependencies | undefined;
    const runVadService = vi.fn(
      async (
        _config: EnabledBridgeConfig['vadService'],
        dependencies: VadListeningServiceDependencies,
      ): Promise<VadServiceSummary> => {
        captured = dependencies;
        await new Promise<void>((resolve) => {
          dependencies.signal?.addEventListener(
            'abort',
            () => {
              dependencies.onOutput?.(output(experiment('bridge-test-drained')));
              resolve();
            },
            { once: true },
          );
        });
        return summary;
      },
    );
    const adapter = createXiaohuanBitableAdapter(bridgeConfig(), {
      validateBinding: vi.fn(),
      validateVadConfig: vi.fn().mockResolvedValue(undefined),
      runVadService,
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
