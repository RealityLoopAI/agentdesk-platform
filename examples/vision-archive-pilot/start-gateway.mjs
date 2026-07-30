#!/usr/bin/env node
/**
 * Launch a dedicated least-privilege Vision Archive Gateway.
 * Only archive configuration, signing, and basic process variables survive.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = process.env.VISION_ARCHIVE_GATEWAY_ENV_FILE || path.join(projectRoot, '.env');
const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};
const sourceEnv = { ...fileEnv, ...process.env };
const archiveKeys = [
  'VISION_ARCHIVE_ROOT',
  'VISION_ARCHIVE_RESOURCES_JSON',
  'VISION_ARCHIVE_READ_ENABLED',
  'VISION_ARCHIVE_ALLOWED_CATEGORIES',
  'VISION_ARCHIVE_ALLOWED_EXTENSIONS',
  'VISION_ARCHIVE_MAX_ROOT_ENTRIES',
  'VISION_ARCHIVE_MAX_LIST_ENTRIES',
  'VISION_ARCHIVE_MAX_RESULTS',
  'VISION_ARCHIVE_MAX_JSON_BYTES',
  'VISION_ARCHIVE_MAX_JSON_DEPTH',
  'VISION_ARCHIVE_MAX_JSON_ITEMS',
  'VISION_ARCHIVE_MAX_JSON_NODES',
  'VISION_ARCHIVE_HANDLE_TTL_MS',
  'VISION_ARCHIVE_MAX_HANDLES',
  'VISION_ARCHIVE_OPERATION_TIMEOUT_MS',
];
const required = ['VISION_ARCHIVE_ROOT', 'VISION_ARCHIVE_RESOURCES_JSON', 'GATEWAY_SIGNING_KEY'];
for (const key of required) {
  if (!sourceEnv[key]?.trim()) throw new Error(`Vision Archive Gateway requires ${key}`);
}

const preserve = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'NODE_OPTIONS', 'NODE_EXTRA_CA_CERTS']);
for (const key of Object.keys(process.env)) {
  if (!preserve.has(key)) delete process.env[key];
}
for (const key of archiveKeys) {
  if (sourceEnv[key]?.trim()) process.env[key] = sourceEnv[key].trim();
}
process.env.VISION_ARCHIVE_READ_ENABLED = sourceEnv.VISION_ARCHIVE_READ_ENABLED?.trim() || 'true';
process.env.GATEWAY_SIGNING_KEY = sourceEnv.GATEWAY_SIGNING_KEY.trim();
process.env.BRAND_NAMESPACE = sourceEnv.BRAND_NAMESPACE?.trim() || 'agentdesk';
process.env.PORT = sourceEnv.VISION_ARCHIVE_GATEWAY_PORT?.trim() || '8090';

await import('../reference-gateway/server.mjs');
