import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { VoicePhotoScanError, readStableImage, resolveVoicePhotoSnapshot, scanVoicePhotos } from './scanner.js';

const cleanup: string[] = [];
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const SUPPORTED_IMAGES = [
  ['image.jpg', JPEG],
  ['image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
  ['image.gif', Buffer.from('GIF89a', 'ascii')],
  ['image.webp', Buffer.from('RIFF0000WEBP', 'ascii')],
  ['image.bmp', Buffer.from([0x42, 0x4d])],
] as const;

async function fixture(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'voice-photo-scan-'));
  cleanup.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('voice photo scanner', () => {
  it('recursively finds supported regular images in deterministic order', async () => {
    const root = await fixture();
    await fs.mkdir(path.join(root, '设备', '2026-07-30', '12-00-00'), { recursive: true });
    await fs.writeFile(path.join(root, '设备', '2026-07-30', '12-00-00', '照片_2.jpg'), JPEG);
    await fs.writeFile(path.join(root, '设备', '2026-07-30', '12-00-00', '照片_1.png'), JPEG);
    await fs.writeFile(path.join(root, '.DS_Store'), JPEG);
    await fs.writeFile(path.join(root, 'ignored.txt'), JPEG);
    await fs.writeFile(path.join(root, 'partial.jpg.tmp'), JPEG);

    const snapshots = await scanVoicePhotos(root, { maxCandidates: 10 });
    expect(snapshots.map((snapshot) => snapshot.relativePath)).toEqual([
      '设备/2026-07-30/12-00-00/照片_1.png',
      '设备/2026-07-30/12-00-00/照片_2.jpg',
    ]);
  });

  it('does not follow file or directory symlinks', async () => {
    const root = await fixture();
    const outside = await fixture();
    await fs.writeFile(path.join(outside, 'outside.jpg'), JPEG);
    await fs.symlink(path.join(outside, 'outside.jpg'), path.join(root, 'linked.jpg'));
    await fs.symlink(outside, path.join(root, 'linked-dir'));
    expect(await scanVoicePhotos(root, { maxCandidates: 10 })).toEqual([]);
  });

  it('fails closed when the candidate bound is exceeded or the share is unavailable', async () => {
    const root = await fixture();
    await fs.writeFile(path.join(root, 'one.jpg'), JPEG);
    await fs.writeFile(path.join(root, 'two.jpg'), JPEG);
    await expect(scanVoicePhotos(root, { maxCandidates: 1 })).rejects.toMatchObject({
      code: 'SCAN_LIMIT_EXCEEDED',
      retryable: false,
    });
    await expect(scanVoicePhotos(path.join(root, 'missing'), { maxCandidates: 10 })).rejects.toMatchObject({
      code: 'SMB_UNAVAILABLE',
      retryable: true,
    });
  });

  it('validates image signatures, byte bounds, and stable metadata', async () => {
    const root = await fixture();
    const file = path.join(root, 'image.jpg');
    await fs.writeFile(file, JPEG);
    const snapshot = (await scanVoicePhotos(root, { maxCandidates: 10 }))[0];
    const image = await readStableImage(snapshot, { rootPath: root, maxBytes: 100 });
    expect(image.digest).toHaveLength(64);
    expect(image.data).toEqual(JPEG);
    await expect(readStableImage(snapshot, { rootPath: root, maxBytes: 3 })).rejects.toMatchObject({
      code: 'IMAGE_TOO_LARGE',
      retryable: false,
    });

    await fs.writeFile(file, Buffer.from('not an image'));
    const changed = await resolveVoicePhotoSnapshot(root, 'image.jpg');
    await expect(readStableImage(changed, { rootPath: root, maxBytes: 100 })).rejects.toMatchObject({
      code: 'INVALID_IMAGE_SIGNATURE',
      retryable: false,
    });
  });

  it.each(SUPPORTED_IMAGES)('accepts the supported signature for %s', async (filename, bytes) => {
    const root = await fixture();
    await fs.writeFile(path.join(root, filename), bytes);
    const snapshot = (await scanVoicePhotos(root, { maxCandidates: 10 }))[0];
    await expect(readStableImage(snapshot, { rootPath: root, maxBytes: 100 })).resolves.toMatchObject({
      relativePath: filename,
    });
  });

  it('detects same-size replacements even when the producer restores mtime', async () => {
    const root = await fixture();
    const file = path.join(root, 'image.jpg');
    await fs.writeFile(file, JPEG);
    const first = (await scanVoicePhotos(root, { maxCandidates: 10 }))[0];
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fs.writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    await fs.utimes(file, first.mtimeMs / 1000, first.mtimeMs / 1000);
    const replacement = (await scanVoicePhotos(root, { maxCandidates: 10 }))[0];
    expect(replacement.size).toBe(first.size);
    expect(replacement.mtimeMs).toBeCloseTo(first.mtimeMs, 0);
    expect(replacement.ctimeMs).not.toBe(first.ctimeMs);
  });

  it('rejects traversal and stale snapshots', async () => {
    const root = await fixture();
    const file = path.join(root, 'image.jpg');
    await fs.writeFile(file, JPEG);
    const snapshot = (await scanVoicePhotos(root, { maxCandidates: 10 }))[0];
    await expect(resolveVoicePhotoSnapshot(root, '../escape.jpg')).rejects.toBeInstanceOf(VoicePhotoScanError);
    await fs.appendFile(file, Buffer.from([0]));
    await expect(readStableImage(snapshot, { rootPath: root, maxBytes: 100 })).rejects.toMatchObject({
      code: 'SOURCE_CHANGED',
    });
  });
});
