import type { ChannelAdapter, ChannelSetup, OutboundMessage } from '../../src/channels/adapter.js';
import { getChannelAdapter } from '../../src/channels/channel-registry.js';
import { getMessagingGroupWithAgentCount } from '../../src/db/messaging-groups.js';
import { getUserIdentity } from '../../src/db/user-identities.js';
import { log } from '../../src/log.js';
import {
  onGatewayConfirmationDelivered,
  type GatewayConfirmationDeliveredEvent,
  onGatewayConfirmationResolved,
  type GatewayConfirmationResolvedEvent,
} from '../../src/modules/gateway-confirmation/events.js';
import { onAgentTurnResolved, type AgentTurnResolvedEvent } from '../../src/modules/agent-turn/events.js';
import { getUser } from '../../src/modules/permissions/db/users.js';
import { createAudioPipeline, type SafeLogger } from '../xiaohuan-doubao-audio/pipeline.js';
import type { ExperimentAudioV1 } from '../xiaohuan-doubao-audio/experiment-schema.js';
import {
  startWholeUtteranceHttpService,
  validateWholeUtteranceHttpConfig,
  type RunningWholeUtteranceHttpService,
  type WholeUtteranceHttpDependencies,
  type WholeUtteranceHttpOutput,
  type WholeUtteranceHttpSummary,
} from '../xiaohuan-doubao-audio/whole-utterance-http-service.js';
import type { EnabledBridgeConfig } from './config.js';
import { createBridgeEnvelope } from './envelope.js';
import {
  createIdempotencyKey,
  createRequestFingerprint,
  mapExperimentCandidateFields,
  type BitableDraftFields,
} from './mapper.js';
export const XIAOHUAN_BITABLE_CHANNEL_TYPE = 'xiaohuan-bitable';

export interface BridgeAdapterLogger {
  info(event: Record<string, unknown>): void;
  error(event: Record<string, unknown>): void;
}

export interface XiaohuanBitableAdapterDependencies {
  validateBinding?: typeof validateDeploymentBinding;
  validateHttpConfig?: typeof validateWholeUtteranceHttpConfig;
  createPipeline?: typeof createAudioPipeline;
  startHttpService?: typeof startWholeUtteranceHttpService;
  mapFields?: typeof mapExperimentCandidateFields;
  fingerprint?: typeof createRequestFingerprint;
  idempotencyKey?: typeof createIdempotencyKey;
  onConfirmationDelivered?: typeof onGatewayConfirmationDelivered;
  onConfirmationResolved?: typeof onGatewayConfirmationResolved;
  onAgentTurnResolved?: typeof onAgentTurnResolved;
  mirrorTranscript?: typeof mirrorTranscriptToFeishu;
  activeDraftMaxMs?: number;
  turnSettleMs?: number;
  retryDelaysMs?: readonly number[];
  logger?: BridgeAdapterLogger;
  now?: () => Date;
}

class BridgeLifecycleError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = 'BridgeLifecycleError';
    this.code = code;
  }
}

const defaultLogger: BridgeAdapterLogger = {
  info: (event) => log.info('Xiaohuan Bitable bridge', event),
  error: (event) => log.error('Xiaohuan Bitable bridge', event),
};
const ACTIVE_DRAFT_MAX_MS = 15 * 60_000;
const TURN_SETTLE_MS = 1_000;
const RETRY_DELAYS_MS = [5_000, 30_000] as const;

interface ActiveDraft {
  requestFingerprint: string;
  stableIdempotencyKey: string;
  fields: BitableDraftFields;
  result: ExperimentAudioV1;
  attempt: number;
  sourceMessageId: string;
  transcriptMirrored: boolean;
  state: 'processing' | 'awaiting-confirmation' | 'retry-backoff';
  confirmationId?: string;
  timeout?: NodeJS.Timeout;
  settleTimeout?: NodeJS.Timeout;
  retryTimeout?: NodeJS.Timeout;
}

export interface FeishuTranscriptMirrorInput {
  platformId: string;
  text: string;
}

/**
 * Reuse the initialized Host Feishu adapter so the Bridge never owns Feishu
 * credentials or accepts a transcript-derived destination.
 */
export async function mirrorTranscriptToFeishu(input: FeishuTranscriptMirrorInput): Promise<string | undefined> {
  const feishu = getChannelAdapter('feishu');
  if (!feishu?.isConnected()) {
    throw new BridgeLifecycleError('FEISHU_ADAPTER_UNAVAILABLE');
  }
  return feishu.deliver(input.platformId, null, {
    kind: 'chat',
    content: { text: input.text },
  });
}

function safeErrorCode(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code?: unknown }).code === 'string') {
    const code = (error as { code: string }).code;
    if (/^[A-Z0-9_:-]{1,128}$/.test(code)) return code;
  }
  return fallback;
}

function serviceLogger(logger: BridgeAdapterLogger): SafeLogger {
  return {
    info: (event) => logger.info(event),
    error: (event) => logger.error(event),
  };
}

/**
 * Resolve the operator binding against Host-owned state before TCP listening starts.
 * This is deployment validation only; authorization remains exclusively in
 * the Gateway workflow carried by the envelope.
 */
export function validateDeploymentBinding(config: EnabledBridgeConfig): void {
  if (!getUser(config.authenticatedUserId)) {
    throw new BridgeLifecycleError('CANONICAL_USER_NOT_FOUND');
  }
  if (
    config.senderIdentity.provider !== 'feishu' ||
    config.senderIdentity.identifierType !== 'open_id' ||
    config.platformId !== `feishu:p2p:${config.senderIdentity.externalSubject}`
  ) {
    throw new BridgeLifecycleError('FEISHU_IDENTITY_ROUTE_MISMATCH');
  }
  const identity = getUserIdentity(config.senderIdentity);
  if (!identity) {
    throw new BridgeLifecycleError('VERIFIED_FEISHU_IDENTITY_NOT_FOUND');
  }
  if (identity.user_id !== config.authenticatedUserId) {
    throw new BridgeLifecycleError('FEISHU_IDENTITY_USER_MISMATCH');
  }
  const route = getMessagingGroupWithAgentCount('feishu', config.platformId);
  if (!route) throw new BridgeLifecycleError('FEISHU_P2P_ROUTE_NOT_FOUND');
  if (Boolean(route.mg.is_group)) {
    throw new BridgeLifecycleError('FEISHU_ROUTE_IS_NOT_P2P');
  }
  if (route.agentCount < 1) {
    throw new BridgeLifecycleError('FEISHU_P2P_ROUTE_NOT_WIRED');
  }
}

/**
 * Create a voice-ingress ChannelAdapter.
 *
 * The adapter targets an existing Feishu P2P messaging group through
 * `onInboundEvent`. When explicitly enabled it also asks the already
 * initialized Host Feishu adapter to mirror the concise transcript to that
 * same fixed P2P route. It never calls Gateway execution or owns
 * Feishu/Bitable credentials.
 */
export function createXiaohuanBitableAdapter(
  config: EnabledBridgeConfig,
  dependencies: XiaohuanBitableAdapterDependencies = {},
): ChannelAdapter {
  const validateBinding = dependencies.validateBinding ?? validateDeploymentBinding;
  const validateHttpConfig = dependencies.validateHttpConfig ?? validateWholeUtteranceHttpConfig;
  const createPipeline = dependencies.createPipeline ?? createAudioPipeline;
  const startHttpService = dependencies.startHttpService ?? startWholeUtteranceHttpService;
  const mapFields = dependencies.mapFields ?? mapExperimentCandidateFields;
  const fingerprint = dependencies.fingerprint ?? createRequestFingerprint;
  const idempotencyKey = dependencies.idempotencyKey ?? createIdempotencyKey;
  const subscribeConfirmation = dependencies.onConfirmationDelivered ?? onGatewayConfirmationDelivered;
  const subscribeResolution = dependencies.onConfirmationResolved ?? onGatewayConfirmationResolved;
  const subscribeAgentTurn = dependencies.onAgentTurnResolved ?? onAgentTurnResolved;
  const mirrorTranscript = dependencies.mirrorTranscript ?? mirrorTranscriptToFeishu;
  const activeDraftMaxMs = dependencies.activeDraftMaxMs ?? ACTIVE_DRAFT_MAX_MS;
  const turnSettleMs = dependencies.turnSettleMs ?? TURN_SETTLE_MS;
  const retryDelaysMs = dependencies.retryDelaysMs ?? RETRY_DELAYS_MS;
  const logger = dependencies.logger ?? defaultLogger;
  const now = dependencies.now ?? (() => new Date());

  let hostSetup: ChannelSetup | null = null;
  let runningService: RunningWholeUtteranceHttpService | null = null;
  let servicePromise: Promise<void> | null = null;
  let unsubscribeConfirmationDelivered: (() => void) | null = null;
  let unsubscribeConfirmationResolved: (() => void) | null = null;
  let unsubscribeAgentTurnResolved: (() => void) | null = null;
  let acceptingOutputs = false;
  const pendingDeliveries = new Set<Promise<void>>();
  const draftQueue: ExperimentAudioV1[] = [];
  let activeDraft: ActiveDraft | null = null;
  let drainPromise: Promise<void> | null = null;
  let scheduleDrain: () => void = () => undefined;

  const trackDelivery = (promise: Promise<void>): void => {
    pendingDeliveries.add(promise);
    void promise.finally(() => pendingDeliveries.delete(promise));
  };

  const releaseActiveDraft = (
    expected: ActiveDraft,
    reason: 'resolved' | 'timeout' | 'host-ingress-failed' | 'completed-without-confirmation' | 'provider-failed',
  ): void => {
    if (activeDraft !== expected) return;
    if (expected.timeout) clearTimeout(expected.timeout);
    if (expected.settleTimeout) clearTimeout(expected.settleTimeout);
    if (expected.retryTimeout) clearTimeout(expected.retryTimeout);
    activeDraft = null;
    logger.info({
      event: 'xiaohuan_bitable_draft_released',
      outcome: reason === 'timeout' ? 'timeout' : 'ok',
      requestFingerprint: expected.requestFingerprint,
      reason,
      queued: draftQueue.length,
    });
    scheduleDrain();
  };

  const handleConfirmationDelivered = (event: GatewayConfirmationDeliveredEvent): void => {
    const current = activeDraft;
    if (
      !current ||
      event.kind !== 'create' ||
      event.correlationId !== current.requestFingerprint ||
      event.requesterUserId !== config.authenticatedUserId ||
      event.channelType !== 'feishu' ||
      event.platformId !== config.platformId ||
      event.threadId !== null ||
      event.resource !== config.resource
    ) {
      return;
    }
    if (current.confirmationId && current.confirmationId !== event.confirmationId) {
      return;
    }
    if (current.settleTimeout) {
      clearTimeout(current.settleTimeout);
      current.settleTimeout = undefined;
    }
    if (current.retryTimeout) {
      clearTimeout(current.retryTimeout);
      current.retryTimeout = undefined;
    }
    current.confirmationId = event.confirmationId;
    current.state = 'awaiting-confirmation';
  };

  const handleConfirmationResolved = (event: GatewayConfirmationResolvedEvent): void => {
    const current = activeDraft;
    if (
      !current ||
      !current.confirmationId ||
      event.confirmationId !== current.confirmationId ||
      event.kind !== 'create' ||
      event.requesterUserId !== config.authenticatedUserId ||
      event.channelType !== 'feishu' ||
      event.platformId !== config.platformId ||
      event.threadId !== null
    ) {
      return;
    }
    releaseActiveDraft(current, 'resolved');
  };

  const sourceMatches = (actual: string, expected: string): boolean =>
    actual === expected || actual.startsWith(`${expected}:`);

  let submitActiveDraft: (setup: ChannelSetup, current: ActiveDraft) => Promise<boolean>;

  const handleAgentTurnResolved = (event: AgentTurnResolvedEvent): void => {
    const current = activeDraft;
    if (!current || current.state !== 'processing' || !sourceMatches(event.sourceMessageId, current.sourceMessageId)) {
      return;
    }

    if (event.status === 'completed') {
      if (current.confirmationId) return;
      current.settleTimeout = setTimeout(
        () => releaseActiveDraft(current, 'completed-without-confirmation'),
        turnSettleMs,
      );
      current.settleTimeout.unref?.();
      return;
    }

    if (event.status === 'provider-failed' && event.retryable && current.attempt < retryDelaysMs.length) {
      if (current.timeout) clearTimeout(current.timeout);
      current.state = 'retry-backoff';
      const delayMs = retryDelaysMs[current.attempt] ?? 0;
      current.retryTimeout = setTimeout(() => {
        if (activeDraft !== current || !hostSetup || !acceptingOutputs) return;
        current.attempt += 1;
        current.sourceMessageId = `${XIAOHUAN_BITABLE_CHANNEL_TYPE}-${current.requestFingerprint}-attempt-${current.attempt + 1}`;
        current.state = 'processing';
        current.confirmationId = undefined;
        current.retryTimeout = undefined;
        current.timeout = setTimeout(() => releaseActiveDraft(current, 'timeout'), activeDraftMaxMs);
        current.timeout.unref?.();
        trackDelivery(submitActiveDraft(hostSetup, current).then(() => undefined));
      }, delayMs);
      current.retryTimeout.unref?.();
      logger.info({
        event: 'xiaohuan_bitable_draft_retry_scheduled',
        outcome: 'retry',
        requestFingerprint: current.requestFingerprint,
        attempt: current.attempt + 2,
        delayMs,
        code: event.code,
      });
      return;
    }

    releaseActiveDraft(current, event.status === 'provider-failed' ? 'provider-failed' : 'timeout');
  };

  submitActiveDraft = async (setup: ChannelSetup, current: ActiveDraft): Promise<boolean> => {
    const result = current.result;

    const envelope = createBridgeEnvelope({
      resource: config.resource,
      result,
      fieldMapping: config.fieldMap,
      fields: current.fields,
      requestFingerprint: current.requestFingerprint,
      idempotencyKey: current.stableIdempotencyKey,
    });

    try {
      await setup.onInboundEvent({
        channelType: 'feishu',
        platformId: config.platformId,
        threadId: null,
        authenticatedUserId: config.authenticatedUserId,
        senderIdentity: config.senderIdentity,
        message: {
          id: current.sourceMessageId,
          kind: 'chat',
          content: JSON.stringify({
            text: JSON.stringify(envelope),
            displayText: `语音指令：${result.transcript}`,
            sender: 'Xiaohuan Bitable Bridge',
          }),
          timestamp: now().toISOString(),
          isMention: true,
          isGroup: false,
        },
      });
      if (config.feishuTranscriptMirrorEnabled && !current.transcriptMirrored) {
        try {
          const platformMessageId = await mirrorTranscript({
            platformId: config.platformId,
            text: `语音指令：${result.transcript}`,
          });
          current.transcriptMirrored = true;
          logger.info({
            event: 'xiaohuan_feishu_transcript_mirrored',
            outcome: 'ok',
            captureId: result.captureId,
            requestFingerprint: current.requestFingerprint,
            platformMessageId: platformMessageId ?? null,
          });
        } catch (error) {
          logger.error({
            event: 'xiaohuan_feishu_transcript_mirror_failed',
            stage: 'feishu-delivery',
            outcome: 'error',
            captureId: result.captureId,
            requestFingerprint: current.requestFingerprint,
            code: safeErrorCode(error, 'FEISHU_TRANSCRIPT_MIRROR_FAILED'),
          });
        }
      }
      logger.info({
        event: 'xiaohuan_bitable_draft_delivered',
        outcome: 'ok',
        captureId: result.captureId,
        requestFingerprint: current.requestFingerprint,
        attempt: current.attempt + 1,
      });
      return true;
    } catch (error) {
      releaseActiveDraft(current, 'host-ingress-failed');
      logger.error({
        event: 'xiaohuan_bitable_draft_failed',
        stage: 'host-ingress',
        outcome: 'error',
        captureId: result.captureId,
        code: safeErrorCode(error, 'HOST_INBOUND_FAILED'),
      });
      return false;
    }
  };

  const deliverResult = async (setup: ChannelSetup, result: ExperimentAudioV1): Promise<boolean> => {
    let requestFingerprint: string;
    let fields: BitableDraftFields;
    let stableIdempotencyKey: string;
    try {
      fields = mapFields(result, config.fieldMap, {
        joinSeparator: config.joinSeparator,
        maxFieldValueBytes: config.maxFieldValueBytes,
      });
      requestFingerprint = fingerprint({
        captureId: result.captureId,
        resource: config.resource,
        transcript: result.transcript,
        experiment: result.experiment,
        fieldMapping: config.fieldMap,
      });
      stableIdempotencyKey = idempotencyKey(requestFingerprint);
    } catch (error) {
      logger.error({
        event: 'xiaohuan_bitable_draft_failed',
        stage: 'mapping',
        outcome: 'error',
        captureId: result.captureId,
        code: safeErrorCode(error, 'BRIDGE_MAPPING_FAILED'),
      });
      return false;
    }
    const current: ActiveDraft = {
      requestFingerprint,
      stableIdempotencyKey,
      fields,
      result,
      attempt: 0,
      sourceMessageId: `${XIAOHUAN_BITABLE_CHANNEL_TYPE}-${requestFingerprint}-attempt-1`,
      transcriptMirrored: false,
      state: 'processing',
    };
    activeDraft = current;
    current.timeout = setTimeout(() => releaseActiveDraft(current, 'timeout'), activeDraftMaxMs);
    current.timeout.unref?.();
    return submitActiveDraft(setup, current);
  };

  const drainDraftQueue = async (): Promise<void> => {
    const setup = hostSetup;
    if (!setup) return;
    while (acceptingOutputs && !activeDraft && draftQueue.length > 0) {
      const result = draftQueue.shift();
      if (!result) return;
      const delivered = await deliverResult(setup, result);
      if (delivered && activeDraft) return;
    }
  };

  scheduleDrain = (): void => {
    if (drainPromise || !acceptingOutputs || !hostSetup || activeDraft || draftQueue.length === 0) {
      return;
    }
    const pending = drainDraftQueue().finally(() => {
      if (drainPromise === pending) drainPromise = null;
      if (acceptingOutputs && !activeDraft && draftQueue.length > 0) scheduleDrain();
    });
    drainPromise = pending;
    trackDelivery(pending);
  };

  const handleOutput = (output: WholeUtteranceHttpOutput): void => {
    if (!acceptingOutputs) return;
    if (!output.result) {
      logger.error({
        event: 'xiaohuan_bitable_utterance_failed',
        stage: 'audio-pipeline',
        outcome: 'error',
        captureId: output.captureId,
        code: output.errorCode ?? 'UTTERANCE_PROCESSING_FAILED',
      });
      return;
    }
    if (draftQueue.length >= config.httpService.maxQueue) {
      logger.error({
        event: 'xiaohuan_bitable_draft_failed',
        stage: 'confirmation-queue',
        outcome: 'error',
        captureId: output.result.captureId,
        code: 'CONFIRMATION_QUEUE_OVERFLOW',
      });
      return;
    }
    draftQueue.push(output.result);
    scheduleDrain();
  };

  const adapter: ChannelAdapter = {
    name: XIAOHUAN_BITABLE_CHANNEL_TYPE,
    channelType: XIAOHUAN_BITABLE_CHANNEL_TYPE,
    supportsThreads: false,

    async setup(setup: ChannelSetup): Promise<void> {
      if (hostSetup || servicePromise) throw new BridgeLifecycleError('BRIDGE_ALREADY_STARTED');

      // Validate Host identity and the HTTP contract before binding TCP 50020.
      await validateBinding(config);
      validateHttpConfig(config.httpService);
      const pipeline = createPipeline(config.audio, { logger: serviceLogger(logger) });

      hostSetup = setup;
      unsubscribeConfirmationDelivered = subscribeConfirmation(handleConfirmationDelivered);
      unsubscribeConfirmationResolved = subscribeResolution(handleConfirmationResolved);
      unsubscribeAgentTurnResolved = subscribeAgentTurn(handleAgentTurnResolved);
      acceptingOutputs = true;

      const serviceDependencies: WholeUtteranceHttpDependencies = {
        logger: serviceLogger(logger),
        processUtterance: (filePath, captureId) => pipeline.processWav(filePath, captureId),
        onOutput: handleOutput,
      };

      try {
        runningService = await startHttpService(config.httpService, serviceDependencies);
      } catch (error) {
        acceptingOutputs = false;
        unsubscribeConfirmationDelivered?.();
        unsubscribeConfirmationResolved?.();
        unsubscribeAgentTurnResolved?.();
        unsubscribeConfirmationDelivered = null;
        unsubscribeConfirmationResolved = null;
        unsubscribeAgentTurnResolved = null;
        hostSetup = null;
        throw error;
      }

      servicePromise = runningService.done
        .then((summary: WholeUtteranceHttpSummary) => {
          logger.info({
            event: 'xiaohuan_bitable_service_stopped',
            outcome: 'ok',
            accepted: summary.received,
            duplicates: summary.duplicates,
            succeeded: summary.succeeded,
            failed: summary.failed,
            rejected: summary.rejected,
          });
        })
        .catch((error: unknown) => {
          logger.error({
            event: 'xiaohuan_bitable_service_failed',
            outcome: 'error',
            code: safeErrorCode(error, 'BRIDGE_SERVICE_FAILED'),
          });
        })
        .finally(() => {
          acceptingOutputs = false;
          runningService = null;
        });

      logger.info({
        event: 'xiaohuan_bitable_adapter_started',
        outcome: 'ok',
      });
    },

    async teardown(): Promise<void> {
      // Stop accepting HTTP requests and drain already accepted model work.
      await runningService?.close();
      await servicePromise;
      acceptingOutputs = false;
      draftQueue.splice(0);
      await Promise.allSettled([...pendingDeliveries]);
      unsubscribeConfirmationDelivered?.();
      unsubscribeConfirmationResolved?.();
      unsubscribeAgentTurnResolved?.();
      unsubscribeConfirmationDelivered = null;
      unsubscribeConfirmationResolved = null;
      unsubscribeAgentTurnResolved = null;
      if (activeDraft?.timeout) clearTimeout(activeDraft.timeout);
      if (activeDraft?.settleTimeout) clearTimeout(activeDraft.settleTimeout);
      if (activeDraft?.retryTimeout) clearTimeout(activeDraft.retryTimeout);
      activeDraft = null;
      hostSetup = null;
      runningService = null;
      servicePromise = null;
      drainPromise = null;
      logger.info({
        event: 'xiaohuan_bitable_adapter_stopped',
        outcome: 'ok',
      });
    },

    isConnected(): boolean {
      return hostSetup !== null && acceptingOutputs;
    },

    async deliver(_platformId: string, _threadId: string | null, _message: OutboundMessage): Promise<undefined> {
      throw new BridgeLifecycleError('INGRESS_ONLY_CHANNEL');
    },
  };

  return adapter;
}
