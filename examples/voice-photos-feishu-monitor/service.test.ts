import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeishuOutboundImageError, normalizeFeishuP2pTarget } from '../../src/channels/feishu/outbound-image.js';
import type { VoicePhotoMonitorConfig } from './config.js';
import { VoicePhotoMonitor, type VoicePhotoLogger, type VoicePhotoSender } from './service.js';
import { VoicePhotoState } from './state.js';

const cleanup: string[] = [];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

async function fixture(): Promise<{ root: string; databasePath: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-photo-service-'));
  cleanup.push(directory);
  const root = path.join(directory, 'source');
  await fs.mkdir(root);
  return { root, databasePath: path.join(directory, 'state.sqlite') };
}

function config(rootPath: string, stateDbPath: string): VoicePhotoMonitorConfig {
  return {
    rootPath,
    stateDbPath,
    feishuTarget: 'feishu:p2p:ou_receiver',
    feishuAppId: 'cli_test',
    feishuAppSecret: 'secret',
    feishuBaseUrl: 'https://open.feishu.test',
    feishuRequestTimeoutMs: 1_000,
    pollIntervalMs: 5,
    stabilityScans: 2,
    maxImageBytes: 1_024,
    maxCandidatesPerScan: 100,
    deliveryConcurrency: 1,
    maxSendsPerMinute: 30,
    retryBaseMs: 100,
    retryMaxMs: 1_000,
    sendingLeaseMs: 1_000,
    ownerLeaseMs: 5_000,
    shutdownDeadlineMs: 1_000,
  };
}

function logger(): VoicePhotoLogger & { entries: Array<Record<string, unknown>> } {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    info: (fields) => entries.push(fields),
    warn: (fields) => entries.push(fields),
    error: (fields) => entries.push(fields),
  };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('voice photo monitor service', () => {
  it('keeps the operator service structurally outside Agent and Session delivery paths', async () => {
    const sourceDirectory = path.dirname(new URL(import.meta.url).pathname);
    const source = await Promise.all(
      ['index.ts', 'service.ts', 'state.ts'].map((filename) =>
        fs.readFile(path.join(sourceDirectory, filename), 'utf8'),
      ),
    );
    const combined = source.join('\n').toLowerCase();
    for (const forbidden of ['messages_out', 'routeinbound', 'conversation_lane', 'backend gateway', 'skill.md']) {
      expect(combined).not.toContain(forbidden);
    }
  });

  it('baselines existing images, sends only a later stable image, and does not replay after restart', async () => {
    const { root, databasePath } = await fixture();
    await fs.mkdir(path.join(root, 'device', '2026-07-30', '10-00-00'), { recursive: true });
    await fs.writeFile(path.join(root, 'device', '2026-07-30', '10-00-00', 'historical.jpg'), JPEG);
    const sendImage = vi.fn(async () => ({ imageKey: 'key', messageId: 'msg-1' }));
    const firstState = new VoicePhotoState(databasePath);
    const firstLogger = logger();
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state: firstState,
      sender: { sendImage },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
      logger: firstLogger,
    });

    await monitor.runOneCycle();
    expect(sendImage).not.toHaveBeenCalled();
    expect(firstLogger.entries).toContainEqual(
      expect.objectContaining({ event: 'voice_photo_monitor_ready', baselineCount: 1 }),
    );

    const newDirectory = path.join(root, 'device', '2026-07-30', '10-01-00');
    await fs.mkdir(newDirectory);
    await fs.writeFile(path.join(newDirectory, 'new.jpg'), JPEG);
    await monitor.runOneCycle();
    expect(sendImage).not.toHaveBeenCalled();
    await monitor.runOneCycle();
    expect(sendImage).toHaveBeenCalledTimes(1);
    expect(sendImage).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'new.jpg',
        target: { receiveId: 'ou_receiver', receiveIdType: 'open_id' },
      }),
    );
    const uuid = sendImage.mock.calls[0][0].idempotencyKey;
    expect(uuid.length).toBeLessThanOrEqual(50);
    monitor.close();

    const restartedSend = vi.fn(async () => ({ imageKey: 'key', messageId: 'msg-2' }));
    const restartedState = new VoicePhotoState(databasePath);
    const restarted = new VoicePhotoMonitor(config(root, databasePath), {
      state: restartedState,
      sender: { sendImage: restartedSend },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
    });
    await restarted.runOneCycle();
    expect(restartedSend).not.toHaveBeenCalled();
    expect(restartedState.listEvents()).toHaveLength(1);
    expect(restartedState.listEvents()[0].status).toBe('delivered');
    restarted.close();
  });

  it('retries provider throttling with the same UUID and provider delay', async () => {
    const { root, databasePath } = await fixture();
    let now = 1_000;
    const seenUuids: string[] = [];
    const sender: VoicePhotoSender = {
      sendImage: vi.fn(async (input) => {
        seenUuids.push(input.idempotencyKey);
        if (seenUuids.length === 1) {
          throw new FeishuOutboundImageError('FEISHU_SEND_FAILED', 'rate limited', {
            retryable: true,
            retryAfterMs: 500,
          });
        }
        return { imageKey: 'key', messageId: 'msg' };
      }),
    };
    const state = new VoicePhotoState(databasePath);
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state,
      sender,
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
      now: () => now,
      random: () => 0.5,
    });
    await monitor.runOneCycle();
    await fs.writeFile(path.join(root, 'new.jpg'), JPEG);
    now += 10;
    await monitor.runOneCycle();
    now += 10;
    await monitor.runOneCycle();
    expect(state.listEvents()[0].status).toBe('retry_wait');
    now += 499;
    await monitor.runOneCycle();
    expect(seenUuids).toHaveLength(1);
    now += 1;
    await monitor.runOneCycle();
    expect(seenUuids).toHaveLength(2);
    expect(new Set(seenUuids).size).toBe(1);
    expect(state.listEvents()[0].status).toBe('delivered');
    monitor.close();
  });

  it('records invalid images terminally and continues with later valid images', async () => {
    const { root, databasePath } = await fixture();
    const sendImage = vi.fn(async () => ({ imageKey: 'key', messageId: 'msg' }));
    const state = new VoicePhotoState(databasePath);
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state,
      sender: { sendImage },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
    });
    await monitor.runOneCycle();
    await fs.writeFile(path.join(root, 'bad.jpg'), Buffer.from('not an image'));
    await monitor.runOneCycle();
    await monitor.runOneCycle();
    expect(state.listEvents()[0].status).toBe('terminal_failure');
    expect(sendImage).not.toHaveBeenCalled();

    await fs.writeFile(path.join(root, 'good.jpg'), JPEG);
    await monitor.runOneCycle();
    await monitor.runOneCycle();
    expect(sendImage).toHaveBeenCalledTimes(1);
    expect(
      state
        .listEvents()
        .map((event) => event.status)
        .sort(),
    ).toEqual(['delivered', 'terminal_failure']);
    monitor.close();
  });

  it('marks a permanent provider rejection terminally without blocking the next image', async () => {
    const { root, databasePath } = await fixture();
    const targets: string[] = [];
    const sendImage = vi.fn(async (input: Parameters<VoicePhotoSender['sendImage']>[0]) => {
      targets.push(input.target.receiveId);
      if (input.filename === 'a-rejected.jpg') {
        throw new FeishuOutboundImageError('FEISHU_SEND_FAILED', 'rejected', { retryable: false });
      }
      return { imageKey: 'key', messageId: 'msg-good' };
    });
    const state = new VoicePhotoState(databasePath);
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state,
      sender: { sendImage },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
    });
    await monitor.runOneCycle();
    await fs.writeFile(path.join(root, 'a-rejected.jpg'), JPEG);
    await fs.writeFile(path.join(root, 'b-good.jpg'), JPEG);
    await monitor.runOneCycle();
    await monitor.runOneCycle();
    await monitor.runOneCycle();

    expect(
      state
        .listEvents()
        .map((event) => event.status)
        .sort(),
    ).toEqual(['delivered', 'terminal_failure']);
    expect(targets).toEqual(['ou_receiver', 'ou_receiver']);
    monitor.close();
  });

  it('preserves baseline and delivery history across a share outage', async () => {
    const { root, databasePath } = await fixture();
    const sendImage = vi.fn(async () => ({ imageKey: 'key', messageId: 'msg' }));
    const state = new VoicePhotoState(databasePath);
    const serviceLogger = logger();
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state,
      sender: { sendImage },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
      logger: serviceLogger,
    });
    await monitor.runOneCycle();
    const disconnected = `${root}-disconnected`;
    await fs.rename(root, disconnected);
    await monitor.runOneCycle();
    expect(state.isBaselineComplete()).toBe(true);
    expect(serviceLogger.entries).toContainEqual(
      expect.objectContaining({ event: 'voice_photo_scan_unavailable', code: 'SMB_UNAVAILABLE' }),
    );
    await fs.rename(disconnected, root);
    await monitor.runOneCycle();
    expect(sendImage).not.toHaveBeenCalled();
    monitor.close();
  });

  it('prevents concurrent ownership and never overlaps cycles', async () => {
    const { root, databasePath } = await fixture();
    const firstState = new VoicePhotoState(databasePath);
    const first = new VoicePhotoMonitor(config(root, databasePath), {
      state: firstState,
      sender: { sendImage: vi.fn() },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
    });
    await first.runOneCycle();

    const secondState = new VoicePhotoState(databasePath);
    const second = new VoicePhotoMonitor(config(root, databasePath), {
      state: secondState,
      sender: { sendImage: vi.fn() },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
    });
    await expect(second.runOneCycle()).rejects.toThrow(/Another voice photo monitor/);
    first.close();
    second.close();
  });

  it('serializes overlapping cycle requests and exits promptly on abort', async () => {
    const { root, databasePath } = await fixture();
    let releaseScan: (() => void) | undefined;
    let scanCalls = 0;
    const scan = vi.fn(async () => {
      scanCalls += 1;
      await new Promise<void>((resolve) => {
        releaseScan = resolve;
      });
      return [];
    });
    const state = new VoicePhotoState(databasePath);
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state,
      sender: { sendImage: vi.fn() },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
      scan,
    });
    const firstCycle = monitor.runOneCycle();
    const overlapping = monitor.runOneCycle();
    await overlapping;
    expect(scanCalls).toBe(1);
    releaseScan?.();
    await firstCycle;

    const controller = new AbortController();
    const running = monitor.run(controller.signal);
    controller.abort();
    releaseScan?.();
    await expect(running).resolves.toBeUndefined();
    monitor.close();
  });

  it('keeps polling after readiness until explicitly aborted', async () => {
    const { root, databasePath } = await fixture();
    const controller = new AbortController();
    let scans = 0;
    const scan = vi.fn(async () => {
      scans += 1;
      if (scans === 2) controller.abort();
      return [];
    });
    const state = new VoicePhotoState(databasePath);
    const monitor = new VoicePhotoMonitor(config(root, databasePath), {
      state,
      sender: { sendImage: vi.fn() },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
      scan,
    });

    await monitor.run(controller.signal);
    expect(scan).toHaveBeenCalledTimes(2);
    monitor.close();
  });

  it('keeps excess events queued under the persisted per-minute attempt budget', async () => {
    const { root, databasePath } = await fixture();
    const limited = { ...config(root, databasePath), maxSendsPerMinute: 1 };
    const sendImage = vi.fn(async () => ({ imageKey: 'key', messageId: `msg-${sendImage.mock.calls.length}` }));
    const state = new VoicePhotoState(databasePath);
    const monitor = new VoicePhotoMonitor(limited, {
      state,
      sender: { sendImage },
      target: normalizeFeishuP2pTarget('feishu:p2p:ou_receiver'),
    });
    await monitor.runOneCycle();
    await fs.writeFile(path.join(root, 'a.jpg'), JPEG);
    await fs.writeFile(path.join(root, 'b.jpg'), JPEG);
    await monitor.runOneCycle();
    await monitor.runOneCycle();
    expect(sendImage).toHaveBeenCalledTimes(1);
    expect(state.queueDepth()).toBe(1);
    monitor.close();
  });
});
