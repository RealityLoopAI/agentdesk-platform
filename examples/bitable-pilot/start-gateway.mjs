#!/usr/bin/env node
/**
 * Start the local Bitable pilot Gateway with a least-privilege environment.
 *
 * The repository's ignored .env already contains the Feishu channel app
 * credentials. This launcher reads it as a source but copies only the
 * Gateway/Bitable variables into process.env before loading the reference
 * Gateway. OpenAI/provider, Web, and Channel secrets are not injected.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const envPath = process.env.BITABLE_GATEWAY_ENV_FILE || path.join(root, '.env');
const fileEnv = fs.existsSync(envPath) ? parseEnv(fs.readFileSync(envPath, 'utf8')) : {};

function value(...keys) {
  for (const key of keys) {
    const candidate = process.env[key] || fileEnv[key];
    if (candidate?.trim()) return candidate.trim();
  }
  return '';
}

function deriveSecret(seed, purpose) {
  return crypto.createHmac('sha256', seed).update(`agentdesk-bitable-pilot:${purpose}`).digest('hex');
}

const appId = value('FEISHU_BITABLE_APP_ID', 'FEISHU_APP_ID');
const appSecret = value('FEISHU_BITABLE_APP_SECRET', 'FEISHU_APP_SECRET');
const resources = value('FEISHU_BITABLE_RESOURCES_JSON');
const feishuSiteBase = value('FEISHU_BASE_URL').replace(/\/+$/, '');
const bitableBaseUrl =
  value('FEISHU_BITABLE_BASE_URL') || (feishuSiteBase ? `${feishuSiteBase}/open-apis` : '');
if (!appId || !appSecret || !resources) {
  throw new Error(
    'Bitable Gateway requires an app id, app secret, and FEISHU_BITABLE_RESOURCES_JSON in its environment file',
  );
}

const gatewayEnv = {
  PORT: value('PORT') || '8088',
  BRAND_NAMESPACE: value('BRAND_NAMESPACE'),
  FEISHU_BITABLE_APP_ID: appId,
  FEISHU_BITABLE_APP_SECRET: appSecret,
  FEISHU_BITABLE_CURSOR_SECRET:
    value('FEISHU_BITABLE_CURSOR_SECRET') || deriveSecret(appSecret, 'cursor'),
  FEISHU_BITABLE_CONFIRMATION_SECRET:
    value('FEISHU_BITABLE_CONFIRMATION_SECRET') || deriveSecret(appSecret, 'confirmation'),
  FEISHU_BITABLE_RESOURCES_JSON: resources,
  FEISHU_BITABLE_READ_ENABLED: value('FEISHU_BITABLE_READ_ENABLED') || 'false',
  FEISHU_BITABLE_WRITE_ENABLED: value('FEISHU_BITABLE_WRITE_ENABLED') || 'false',
  FEISHU_BITABLE_BASE_URL: bitableBaseUrl,
  // The local pilot must not run an unsigned identity path. A deployment-set
  // key wins; otherwise derive a purpose-separated key from the Feishu app
  // secret. configure-topology.ts uses the identical derivation for the
  // host-side signing proxy. Production should set a dedicated random key.
  GATEWAY_SIGNING_KEY:
    value('GATEWAY_SIGNING_KEY') || deriveSecret(appSecret, 'gateway-signing'),
};

for (const [key, candidate] of Object.entries(gatewayEnv)) {
  if (candidate) process.env[key] = candidate;
  else delete process.env[key];
}

await import('../reference-gateway/server.mjs');
