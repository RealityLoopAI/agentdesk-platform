import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createVoicePhotoJsonDigest,
  parseQualifiedVoicePhotoAnalysis,
  type VoicePhotoSceneRoutes,
} from './json-analysis.js';

export interface JsonSnapshot {
  relativePath: string;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  dev: string;
  ino: string;
}

export interface QualifiedJsonFile extends JsonSnapshot {
  digest: string;
  resource: string;
  fields: Record<string, unknown>;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function scanVoicePhotoJson(rootPath: string, limit: number): Promise<JsonSnapshot[]> {
  const root = await fs.realpath(rootPath);
  const results: JsonSnapshot[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (results.length >= limit) return;
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await visit(candidate);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        const stat = await fs.stat(candidate);
        results.push({
          relativePath: path.relative(root, candidate),
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          dev: String(stat.dev),
          ino: String(stat.ino),
        });
      }
    }
  };
  await visit(root);
  return results.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

export function jsonSnapshotFingerprint(snapshot: JsonSnapshot): string {
  return [snapshot.dev, snapshot.ino, snapshot.size, snapshot.mtimeMs, snapshot.ctimeMs].join(':');
}

export async function readQualifiedVoicePhotoJson(
  rootPath: string,
  snapshot: JsonSnapshot,
  maxBytes: number,
  routes: VoicePhotoSceneRoutes,
): Promise<QualifiedJsonFile> {
  if (snapshot.size < 2 || snapshot.size > maxBytes) {
    throw new Error('JSON_SIZE_OUT_OF_RANGE');
  }
  const root = await fs.realpath(rootPath);
  const candidate = path.resolve(root, snapshot.relativePath);
  if (!inside(root, candidate)) throw new Error('JSON_PATH_ESCAPES_ROOT');
  const real = await fs.realpath(candidate);
  if (!inside(root, real)) throw new Error('JSON_PATH_ESCAPES_ROOT');
  const before = await fs.stat(real);
  const data = await fs.readFile(real);
  const after = await fs.stat(real);
  if (
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    after.size !== snapshot.size ||
    after.mtimeMs !== snapshot.mtimeMs
  ) {
    throw new Error('JSON_CHANGED_DURING_READ');
  }
  const parsed = parseQualifiedVoicePhotoAnalysis(data.toString('utf8'), routes);
  return {
    ...snapshot,
    digest: createVoicePhotoJsonDigest(data),
    resource: parsed.resource,
    fields: parsed.fields,
  };
}
