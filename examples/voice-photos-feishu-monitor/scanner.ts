import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface FileSnapshot {
  relativePath: string;
  absolutePath: string;
  dev: string;
  ino: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export interface ValidatedImage extends FileSnapshot {
  data: Buffer;
  digest: string;
}

export class VoicePhotoScanError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable = true, cause?: unknown) {
    super(message, { cause });
    this.name = 'VoicePhotoScanError';
    this.code = code;
    this.retryable = retryable;
  }
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const TEMPORARY_SUFFIX = /\.(?:tmp|temp|partial|part|crdownload|download)$/i;

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function supportedName(name: string): boolean {
  if (!name || name.startsWith('.') || TEMPORARY_SUFFIX.test(name)) return false;
  return IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase());
}

function normalizedRelative(root: string, target: string): string {
  return path
    .relative(root, target)
    .split(path.sep)
    .map((part) => part.normalize('NFC'))
    .join('/');
}

async function safeSnapshot(rootReal: string, candidatePath: string): Promise<FileSnapshot | null> {
  const first = await fs.lstat(candidatePath);
  if (first.isSymbolicLink() || !first.isFile()) return null;
  const candidateReal = await fs.realpath(candidatePath);
  if (!contained(rootReal, candidateReal)) {
    throw new VoicePhotoScanError('PATH_ESCAPE', 'Monitored path escaped the configured root', false);
  }
  const second = await fs.lstat(candidateReal);
  if (second.isSymbolicLink() || !second.isFile()) return null;
  return {
    relativePath: normalizedRelative(rootReal, candidateReal),
    absolutePath: candidateReal,
    dev: String(second.dev),
    ino: String(second.ino),
    size: second.size,
    mtimeMs: second.mtimeMs,
    ctimeMs: second.ctimeMs,
  };
}

export async function scanVoicePhotos(
  rootPath: string,
  options: { maxCandidates: number; signal?: AbortSignal },
): Promise<FileSnapshot[]> {
  try {
    const rootReal = await fs.realpath(rootPath);
    const rootStat = await fs.lstat(rootReal);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new VoicePhotoScanError('INVALID_ROOT', 'Monitored root must be a regular directory', false);
    }

    const result: FileSnapshot[] = [];
    const stack = [rootReal];
    while (stack.length > 0) {
      if (options.signal?.aborted) throw new VoicePhotoScanError('SCAN_ABORTED', 'Scan aborted');
      const directory = stack.pop()!;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        if (options.signal?.aborted) throw new VoicePhotoScanError('SCAN_ABORTED', 'Scan aborted');
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const candidatePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          const directoryReal = await fs.realpath(candidatePath);
          if (!contained(rootReal, directoryReal)) {
            throw new VoicePhotoScanError('PATH_ESCAPE', 'Monitored directory escaped the configured root', false);
          }
          const directoryStat = await fs.lstat(directoryReal);
          if (directoryStat.isDirectory() && !directoryStat.isSymbolicLink()) stack.push(directoryReal);
          continue;
        }
        if (!entry.isFile() || !supportedName(entry.name)) continue;
        if (result.length >= options.maxCandidates) {
          throw new VoicePhotoScanError('SCAN_LIMIT_EXCEEDED', 'Candidate scan limit exceeded', false);
        }
        const snapshot = await safeSnapshot(rootReal, candidatePath);
        if (snapshot) result.push(snapshot);
      }
    }
    return result.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  } catch (error) {
    if (error instanceof VoicePhotoScanError) throw error;
    throw new VoicePhotoScanError('SMB_UNAVAILABLE', 'Voice photo root is unavailable', true, error);
  }
}

export async function resolveVoicePhotoSnapshot(rootPath: string, relativePath: string): Promise<FileSnapshot> {
  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath.includes('\0') ||
    relativePath.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new VoicePhotoScanError('INVALID_RELATIVE_PATH', 'Stored image path is invalid', false);
  }
  try {
    const rootReal = await fs.realpath(rootPath);
    const candidate = path.join(rootReal, ...relativePath.split('/'));
    if (!contained(rootReal, candidate)) {
      throw new VoicePhotoScanError('PATH_ESCAPE', 'Stored image path escaped the configured root', false);
    }
    const snapshot = await safeSnapshot(rootReal, candidate);
    if (!snapshot) throw new VoicePhotoScanError('SOURCE_CHANGED', 'Stored image is no longer a regular file');
    return snapshot;
  } catch (error) {
    if (error instanceof VoicePhotoScanError) throw error;
    throw new VoicePhotoScanError('SMB_UNAVAILABLE', 'Stored image is unavailable', true, error);
  }
}

function metadataMatches(left: FileSnapshot, right: FileSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function validImageSignature(data: Buffer): boolean {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return true;
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  const six = data.subarray(0, 6).toString('ascii');
  if (six === 'GIF87a' || six === 'GIF89a') return true;
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString('ascii') === 'RIFF' &&
    data.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return true;
  }
  return data.length >= 2 && data[0] === 0x42 && data[1] === 0x4d;
}

export async function readStableImage(
  expected: FileSnapshot,
  options: { rootPath: string; maxBytes: number },
): Promise<ValidatedImage> {
  try {
    const rootReal = await fs.realpath(options.rootPath);
    const targetReal = await fs.realpath(expected.absolutePath);
    if (!contained(rootReal, targetReal)) {
      throw new VoicePhotoScanError('PATH_ESCAPE', 'Image escaped the configured root', false);
    }
    const before = await safeSnapshot(rootReal, targetReal);
    if (!before || !metadataMatches(expected, before)) {
      throw new VoicePhotoScanError('SOURCE_CHANGED', 'Image changed before read');
    }
    if (before.size > options.maxBytes) {
      throw new VoicePhotoScanError('IMAGE_TOO_LARGE', 'Image exceeds the configured byte limit', false);
    }
    const data = await fs.readFile(targetReal);
    if (data.length > options.maxBytes) {
      throw new VoicePhotoScanError('IMAGE_TOO_LARGE', 'Image exceeds the configured byte limit', false);
    }
    const after = await safeSnapshot(rootReal, targetReal);
    if (!after || !metadataMatches(before, after) || data.length !== after.size) {
      throw new VoicePhotoScanError('SOURCE_CHANGED', 'Image changed during read');
    }
    if (!validImageSignature(data)) {
      throw new VoicePhotoScanError('INVALID_IMAGE_SIGNATURE', 'Image signature is unsupported', false);
    }
    return {
      ...after,
      data,
      digest: createHash('sha256').update(data).digest('hex'),
    };
  } catch (error) {
    if (error instanceof VoicePhotoScanError) throw error;
    throw new VoicePhotoScanError('SMB_UNAVAILABLE', 'Image is unavailable', true, error);
  }
}

export function snapshotFingerprint(snapshot: FileSnapshot): string {
  return `${snapshot.dev}:${snapshot.ino}:${snapshot.size}:${snapshot.mtimeMs}:${snapshot.ctimeMs}`;
}

export function eventIdFor(relativePath: string, digest: string): string {
  return `voice-photo-${createHash('sha256').update(relativePath.normalize('NFC')).update('\0').update(digest).digest('hex')}`;
}
