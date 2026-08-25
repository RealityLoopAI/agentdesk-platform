import path from 'node:path';

import { FeishuOutboundImageError, type SendFeishuImageResult } from '../../src/channels/feishu/outbound-image.js';
import type { FeishuReceiveTarget } from '../../src/channels/feishu/types.js';
import type { VoicePhotoMonitorConfig } from './config.js';
import {
  VoicePhotoScanError,
  readStableImage,
  resolveVoicePhotoSnapshot,
  scanVoicePhotos,
  type FileSnapshot,
} from './scanner.js';
import { VoicePhotoState, type DeliveryEvent } from './state.js';

export interface VoicePhotoLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}

export interface VoicePhotoSender {
  sendImage(input: {
    target: FeishuReceiveTarget;
    filename: string;
    data: Buffer;
    idempotencyKey: string;
  }): Promise<SendFeishuImageResult>;
}

export interface VoicePhotoMonitorDependencies {
  state: VoicePhotoState;
  sender: VoicePhotoSender;
  target: FeishuReceiveTarget;
  logger?: VoicePhotoLogger;
  now?: () => number;
  random?: () => number;
  scan?: typeof scanVoicePhotos;
  readImage?: typeof readStableImage;
  resolveSnapshot?: typeof resolveVoicePhotoSnapshot;
}

export interface VoicePhotoMonitorCounters {
  scans: number;
  unavailableScans: number;
  candidates: number;
  readyEvents: number;
  deliveryAttempts: number;
  delivered: number;
  retries: number;
  terminalFailures: number;
}

const silentLogger: VoicePhotoLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

class VoicePhotoOwnershipError extends Error {}

function errorCode(error: unknown): string {
  if (error instanceof VoicePhotoScanError || error instanceof FeishuOutboundImageError) return error.code;
  return 'UNEXPECTED_MONITOR_ERROR';
}

function retryable(error: unknown): boolean {
  if (error instanceof VoicePhotoScanError || error instanceof FeishuOutboundImageError) return error.retryable;
  return true;
}

function retryHint(error: unknown): number | undefined {
  return error instanceof FeishuOutboundImageError ? error.retryAfterMs : undefined;
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        resolve();
      },
      { once: true },
    );
  });
}

export class VoicePhotoMonitor {
  readonly counters: VoicePhotoMonitorCounters = {
    scans: 0,
    unavailableScans: 0,
    candidates: 0,
    readyEvents: 0,
    deliveryAttempts: 0,
    delivered: 0,
    retries: 0,
    terminalFailures: 0,
  };

  private readonly logger: VoicePhotoLogger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly scan: typeof scanVoicePhotos;
  private readonly readImage: typeof readStableImage;
  private readonly resolveSnapshot: typeof resolveVoicePhotoSnapshot;
  private leaseOwned = false;
  private cycleRunning = false;

  constructor(
    private readonly config: VoicePhotoMonitorConfig,
    private readonly dependencies: VoicePhotoMonitorDependencies,
  ) {
    this.logger = dependencies.logger ?? silentLogger;
    this.now = dependencies.now ?? Date.now;
    this.random = dependencies.random ?? Math.random;
    this.scan = dependencies.scan ?? scanVoicePhotos;
    this.readImage = dependencies.readImage ?? readStableImage;
    this.resolveSnapshot = dependencies.resolveSnapshot ?? resolveVoicePhotoSnapshot;
  }

  acquireOwnership(): void {
    if (this.leaseOwned) return;
    if (!this.dependencies.state.acquireLease(this.config.ownerLeaseMs, this.now())) {
      throw new VoicePhotoOwnershipError('Another voice photo monitor owns the configured state database');
    }
    this.leaseOwned = true;
  }

  private refreshOwnership(): void {
    if (!this.leaseOwned || !this.dependencies.state.refreshLease(this.config.ownerLeaseMs, this.now())) {
      throw new VoicePhotoOwnershipError('Voice photo monitor ownership lease was lost');
    }
  }

  private backoff(event: DeliveryEvent, providerHint?: number): number {
    const exponential = Math.min(
      this.config.retryMaxMs,
      this.config.retryBaseMs * 2 ** Math.min(20, Math.max(0, event.attempts - 1)),
    );
    const jittered = Math.round(exponential * (0.8 + this.random() * 0.4));
    return Math.min(this.config.retryMaxMs, Math.max(providerHint ?? 0, jittered));
  }

  private async processSnapshot(snapshot: FileSnapshot): Promise<void> {
    const now = this.now();
    if (!this.dependencies.state.observe(snapshot, this.config.stabilityScans, now)) return;
    try {
      const image = await this.readImage(snapshot, {
        rootPath: this.config.rootPath,
        maxBytes: this.config.maxImageBytes,
      });
      this.dependencies.state.recordReady(image, this.now());
      this.counters.readyEvents += 1;
    } catch (error) {
      if (retryable(error)) {
        this.dependencies.state.resetObservation(snapshot, this.now());
        return;
      }
      this.dependencies.state.recordValidationFailure(snapshot, errorCode(error), this.now());
      this.counters.terminalFailures += 1;
      this.logger.warn({
        event: 'voice_photo_validation_failed',
        code: errorCode(error),
        relativePath: snapshot.relativePath.slice(0, 512),
      });
    }
  }

  private async deliver(event: DeliveryEvent): Promise<void> {
    this.counters.deliveryAttempts += 1;
    try {
      const snapshot = await this.resolveSnapshot(this.config.rootPath, event.relativePath);
      const image = await this.readImage(snapshot, {
        rootPath: this.config.rootPath,
        maxBytes: this.config.maxImageBytes,
      });
      if (image.digest !== event.digest) {
        this.dependencies.state.resetObservation(image, this.now());
        throw new VoicePhotoScanError('SOURCE_CHANGED', 'Ready image content changed before delivery', false);
      }
      const result = await this.dependencies.sender.sendImage({
        target: this.dependencies.target,
        filename: path.basename(event.relativePath),
        data: image.data,
        idempotencyKey: event.providerUuid,
      });
      this.dependencies.state.markDelivered(event.id, result.messageId, this.now());
      this.counters.delivered += 1;
      this.logger.info({
        event: 'voice_photo_delivered',
        eventId: event.id,
        relativePath: event.relativePath.slice(0, 512),
        providerMessageId: result.messageId ?? null,
      });
    } catch (error) {
      const now = this.now();
      if (retryable(error)) {
        const delayMs = this.backoff(event, retryHint(error));
        this.dependencies.state.markRetry(event.id, errorCode(error), now + delayMs, now);
        this.counters.retries += 1;
        this.logger.warn({
          event: 'voice_photo_delivery_retry',
          eventId: event.id,
          code: errorCode(error),
          delayMs,
        });
      } else {
        this.dependencies.state.markTerminal(event.id, errorCode(error), now);
        this.counters.terminalFailures += 1;
        this.logger.error({
          event: 'voice_photo_delivery_terminal',
          eventId: event.id,
          code: errorCode(error),
        });
      }
    }
  }

  private async drain(): Promise<void> {
    const now = this.now();
    const remainingRate = Math.max(
      0,
      this.config.maxSendsPerMinute - this.dependencies.state.attemptsSince(now - 60_000),
    );
    const claimCount = Math.min(this.config.deliveryConcurrency, remainingRate);
    if (claimCount <= 0) return;
    const events = this.dependencies.state.claimDue(claimCount, this.config.sendingLeaseMs, now);
    await Promise.all(events.map((event) => this.deliver(event)));
  }

  async runOneCycle(signal?: AbortSignal): Promise<void> {
    if (this.cycleRunning) return;
    this.acquireOwnership();
    this.cycleRunning = true;
    try {
      this.refreshOwnership();
      const startedAt = this.now();
      const snapshots = await this.scan(this.config.rootPath, {
        maxCandidates: this.config.maxCandidatesPerScan,
        signal,
      });
      this.counters.scans += 1;
      this.counters.candidates += snapshots.length;

      if (!this.dependencies.state.isBaselineComplete()) {
        const completedAt = this.now();
        this.dependencies.state.commitBaseline(snapshots, completedAt);
        this.logger.info({
          event: 'voice_photo_monitor_ready',
          baselineCount: snapshots.length,
          baselineCompletedAt: new Date(completedAt).toISOString(),
          scanDurationMs: completedAt - startedAt,
        });
        return;
      }

      for (const snapshot of snapshots) {
        if (signal?.aborted) return;
        await this.processSnapshot(snapshot);
      }
      await this.drain();
      this.logger.info({
        event: 'voice_photo_scan_complete',
        candidateCount: snapshots.length,
        queueDepth: this.dependencies.state.queueDepth(),
        scanDurationMs: this.now() - startedAt,
      });
    } catch (error) {
      if (error instanceof VoicePhotoOwnershipError) throw error;
      this.counters.unavailableScans += 1;
      this.logger.warn({
        event: 'voice_photo_scan_unavailable',
        code: errorCode(error),
      });
    } finally {
      this.cycleRunning = false;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    this.acquireOwnership();
    try {
      while (!signal.aborted) {
        await this.runOneCycle(signal);
        if (!signal.aborted) await wait(this.config.pollIntervalMs, signal);
      }
    } finally {
      if (this.leaseOwned) {
        this.dependencies.state.releaseLease();
        this.leaseOwned = false;
      }
    }
  }

  close(): void {
    if (this.leaseOwned) {
      this.dependencies.state.releaseLease();
      this.leaseOwned = false;
    }
    this.dependencies.state.close();
  }
}
