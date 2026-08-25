import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { FileSnapshot, ValidatedImage } from './scanner.js';
import { VoicePhotoState } from './state.js';

const cleanup: string[] = [];

async function stateFile(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-photo-state-'));
  cleanup.push(directory);
  return path.join(directory, 'state.sqlite');
}

function snapshot(relativePath = 'device/2026-07-30/12-00-00/image.jpg', size = 4): FileSnapshot {
  return {
    relativePath,
    absolutePath: `/mount/${relativePath}`,
    dev: '1',
    ino: '2',
    size,
    mtimeMs: 100,
    ctimeMs: 100,
  };
}

function image(relativePath: string, digest: string): ValidatedImage {
  return { ...snapshot(relativePath), data: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), digest };
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('voice photo monitor state', () => {
  it('commits a durable baseline without creating delivery events', async () => {
    const databasePath = await stateFile();
    const state = new VoicePhotoState(databasePath);
    state.commitBaseline([snapshot()], 1_000);
    expect(state.isBaselineComplete()).toBe(true);
    expect(state.baselineCompletedAt()).toBe(1_000);
    expect(state.listEvents()).toEqual([]);
    state.close();

    const restarted = new VoicePhotoState(databasePath);
    expect(restarted.isBaselineComplete()).toBe(true);
    expect(restarted.observe(snapshot(), 2, 2_000)).toBe(false);
    expect(restarted.listEvents()).toEqual([]);
    restarted.close();
  });

  it('requires stable observations and deduplicates unchanged path content', async () => {
    const state = new VoicePhotoState(await stateFile());
    state.commitBaseline([], 1);
    const first = snapshot('device/new.jpg');
    expect(state.observe(first, 2, 2)).toBe(false);
    expect(state.observe(first, 2, 3)).toBe(true);
    const eventId = state.recordReady(image(first.relativePath, 'digest-a'), 4);
    state.recordReady(image(first.relativePath, 'digest-a'), 5);
    expect(state.listEvents()).toHaveLength(1);
    expect(state.getEvent(eventId)?.status).toBe('ready');
    expect(state.observe(first, 2, 6)).toBe(false);
    state.close();
  });

  it('creates a new event when the same path receives different stable content', async () => {
    const state = new VoicePhotoState(await stateFile());
    state.commitBaseline([], 1);
    const first = snapshot('device/replaced.jpg');
    state.observe(first, 2, 2);
    state.observe(first, 2, 3);
    state.recordReady(image(first.relativePath, 'digest-a'), 4);
    state.markDelivered(state.listEvents()[0].id, 'msg-a', 5);

    const replacement = { ...first, ino: '3', mtimeMs: 200 };
    state.observe(replacement, 2, 6);
    expect(state.observe(replacement, 2, 7)).toBe(true);
    state.recordReady({ ...replacement, data: Buffer.from([0xff, 0xd8, 0xff]), digest: 'digest-b' }, 8);
    expect(state.listEvents().map((event) => event.status)).toEqual(['delivered', 'ready']);
    state.close();
  });

  it('claims, retries, recovers expired sending leases, and records delivery', async () => {
    const state = new VoicePhotoState(await stateFile());
    state.commitBaseline([], 1);
    const file = snapshot('device/delivery.jpg');
    state.observe(file, 2, 2);
    state.observe(file, 2, 3);
    state.recordReady(image(file.relativePath, 'digest'), 4);

    const firstClaim = state.claimDue(1, 100, 10)[0];
    expect(firstClaim).toMatchObject({ status: 'sending', attempts: 1 });
    expect(state.claimDue(1, 100, 50)).toEqual([]);
    const recovered = state.claimDue(1, 100, 111)[0];
    expect(recovered.attempts).toBe(2);
    state.markRetry(recovered.id, 'THROTTLED', 500, 112);
    expect(state.claimDue(1, 100, 499)).toEqual([]);
    const retry = state.claimDue(1, 100, 500)[0];
    state.markDelivered(retry.id, 'msg-1', 501);
    expect(state.getEvent(retry.id)?.status).toBe('delivered');
    expect(state.queueDepth()).toBe(0);
    state.close();
  });

  it('enforces one live owner and permits bounded stale-owner recovery', async () => {
    const databasePath = await stateFile();
    const first = new VoicePhotoState(databasePath);
    const second = new VoicePhotoState(databasePath);
    expect(first.acquireLease(100, 1_000)).toBe(true);
    expect(second.acquireLease(100, 1_050)).toBe(false);
    expect(second.acquireLease(100, 1_101)).toBe(true);
    expect(first.refreshLease(100, 1_102)).toBe(false);
    second.releaseLease();
    first.close();
    second.close();
  });

  it('records invalid generations terminally without blocking later files', async () => {
    const state = new VoicePhotoState(await stateFile());
    state.commitBaseline([], 1);
    const invalid = snapshot('device/bad.jpg');
    state.observe(invalid, 2, 2);
    state.observe(invalid, 2, 3);
    state.recordValidationFailure(invalid, 'INVALID_IMAGE_SIGNATURE', 4);
    expect(state.listEvents()[0]).toMatchObject({ status: 'terminal_failure' });
    expect(state.observe(invalid, 2, 5)).toBe(false);
    state.close();
  });
});
