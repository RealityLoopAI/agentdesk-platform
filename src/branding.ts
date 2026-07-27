/**
 * Branding — single source of truth for the platform's display name and
 * protocol namespace.
 *
 * Everything here is overridable via environment variables so a fork or a
 * downstream deployment can rebrand without touching code. The defaults are
 * intentionally generic ("AgentDesk") — this is an open, business-agnostic
 * enterprise agent framework, not a single product.
 *
 * | env var          | what it controls                                    |
 * |------------------|-----------------------------------------------------|
 * | `BRAND_NAME`     | Human-facing platform name (logs, system prompts).  |
 * | `BRAND_NAMESPACE`| Machine identifier used to derive every runtime tag: |
 * |                  | container labels, image base, HMAC header prefix,    |
 * |                  | metric prefix, `~/.config/<ns>/` paths, MCP server.  |
 *
 * `BRAND_NAMESPACE` must be a DNS/label-safe slug (lowercase, `[a-z0-9-]`)
 * because it ends up in Docker labels, image names, and HTTP header names.
 * It is read once at process start and treated as stable for the lifetime
 * of the process — changing it mid-flight would orphan running containers
 * and on-disk config.
 *
 * Both variables resolve as: process env → `.env` in the working directory →
 * default. `container/build.sh` resolves `BRAND_NAMESPACE` the same way, so
 * the image name it builds matches the one the host derives here.
 */
import fs from 'fs';
import path from 'path';

/**
 * Minimal `.env` fallback for the two brand variables. Inlined rather than
 * reusing `env.ts` readEnvFile because branding must stay import-cycle-free
 * (env → log → observability/tracer → branding). Parsing rules mirror
 * readEnvFile: trim, skip comments, strip one layer of matching quotes,
 * last assignment wins.
 */
function readBrandVar(key: string): string | undefined {
  const fromEnv = process.env[key];
  if (fromEnv) return fromEnv;
  let content: string;
  try {
    content = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf-8');
  } catch {
    return undefined;
  }
  let found: string | undefined;
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1 || trimmed.slice(0, eqIdx).trim() !== key) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (value) found = value;
  }
  return found;
}

function sanitizeNamespace(raw: string | undefined, fallback: string): string {
  const slug = (raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || fallback;
}

/** Human-facing platform name. Used in logs, banners, default assistant name. */
export const PLATFORM_BRAND = (readBrandVar('BRAND_NAME') || 'AgentDesk').trim();

/** Full platform name for banners / startup logs. */
export const PLATFORM_NAME = `${PLATFORM_BRAND} Agent Platform`;

/**
 * Machine namespace. Lowercase slug. Derives container labels, image base,
 * signing-header prefix, metric prefix, config dirs, MCP server name.
 */
export const PLATFORM_PROTOCOL_NAMESPACE = sanitizeNamespace(readBrandVar('BRAND_NAMESPACE'), 'agentdesk');

/** Built-in MCP server name (shown to the agent provider). */
export const MCP_SERVER_NAME = PLATFORM_PROTOCOL_NAMESPACE;

/**
 * Prometheus metric prefix. Metric names allow only `[a-zA-Z0-9_:]` AND must not
 * start with a digit, so the namespace's hyphens become underscores and a leading
 * digit gets an underscore prefix.
 * e.g. `my-brand` → `my_brand` → `my_brand_inbound_total`; `3dlab` → `_3dlab`.
 *
 * The digit guard matters because `sanitizeNamespace` (and the documented rule,
 * "lowercase [a-z0-9-]") allows a leading digit, which is fine for Docker labels
 * and DNS labels but not for Prometheus. Without it, `BRAND_NAMESPACE=3dlab` made
 * prom-client throw `Invalid metric name` while src/metrics.ts was still being
 * imported — killing the host before any startup logging, with an error naming
 * neither BRAND_NAMESPACE nor the offending metric.
 */
const rawMetricPrefix = PLATFORM_PROTOCOL_NAMESPACE.replace(/-/g, '_');
export const METRIC_PREFIX = /^[0-9]/.test(rawMetricPrefix) ? `_${rawMetricPrefix}` : rawMetricPrefix;

/**
 * Default frontdesk agent group folder + display name. A fresh install
 * provisions one blank template frontdesk under this folder; operators add
 * their own desks/workers on top. No business-specific roles are baked in.
 */
export const DEFAULT_FRONTDESK_FOLDER = `${PLATFORM_PROTOCOL_NAMESPACE}-frontdesk`;
/**
 * USER-FACING display name of the entry agent. Deliberately NOT "Frontdesk"
 * (ADR-0060): to the user this is their assistant, not a reception desk that
 * transfers them onward — delegation is internal plumbing. The folder keeps
 * the `-frontdesk` slug: it is an operator/topology identifier, never shown
 * in a chat.
 */
export const DEFAULT_FRONTDESK_NAME = `${PLATFORM_BRAND} Assistant`;

/** Folder prefix for worker agent groups created by the bootstrap script. */
export const DEFAULT_WORKER_FOLDER_PREFIX = PLATFORM_PROTOCOL_NAMESPACE;

export const DEFAULT_UI_THEME = {
  brandPrimary: '#245866',
  brandPrimaryHover: '#1B4652',
  brandPrimaryActive: '#143A44',
  brandSurfaceSubtle: '#E8F1F2',
  brandBorder: '#B8D0D3',
  canvas: '#FAF8F4',
  surface: '#FFFFFF',
  border: '#DDE5E5',
  textPrimary: '#18343B',
  textSecondary: '#60757A',
  statusSuccess: '#287A5B',
  statusWarning: '#B66A20',
  statusDanger: '#C44545',
} as const;

export type PublicUiTheme = { -readonly [Key in keyof typeof DEFAULT_UI_THEME]: string };

export interface PublicBranding {
  displayName: string;
  logoPath: string;
  theme: PublicUiTheme;
}

const UI_THEME_ENV: Record<keyof PublicUiTheme, string> = {
  brandPrimary: 'BRAND_UI_PRIMARY',
  brandPrimaryHover: 'BRAND_UI_PRIMARY_HOVER',
  brandPrimaryActive: 'BRAND_UI_PRIMARY_ACTIVE',
  brandSurfaceSubtle: 'BRAND_UI_SURFACE_SUBTLE',
  brandBorder: 'BRAND_UI_BORDER',
  canvas: 'BRAND_UI_CANVAS',
  surface: 'BRAND_UI_SURFACE',
  border: 'BRAND_UI_NEUTRAL_BORDER',
  textPrimary: 'BRAND_UI_TEXT_PRIMARY',
  textSecondary: 'BRAND_UI_TEXT_SECONDARY',
  statusSuccess: 'BRAND_UI_STATUS_SUCCESS',
  statusWarning: 'BRAND_UI_STATUS_WARNING',
  statusDanger: 'BRAND_UI_STATUS_DANGER',
};

function publicDisplayName(raw: string | undefined): string {
  const normalized = Array.from(raw ?? '')
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join('')
    .trim();
  return normalized.length >= 1 && normalized.length <= 80 ? normalized : 'Agent Platform';
}

function publicLogoPath(raw: string | undefined): string {
  const candidate = raw?.trim() || '/brand/logo.svg';
  if (
    !candidate.startsWith('/') ||
    candidate.startsWith('//') ||
    candidate.includes('\\') ||
    candidate.includes('..') ||
    candidate.includes('?') ||
    candidate.includes('#') ||
    !/\.(?:svg|png|webp)$/i.test(candidate)
  ) {
    return '/brand/logo.svg';
  }
  return candidate;
}

function publicColor(raw: string | undefined, fallback: string): string {
  const candidate = raw?.trim();
  return candidate && /^#[0-9A-Fa-f]{6}$/.test(candidate) ? candidate.toUpperCase() : fallback;
}

/**
 * Public UI-only branding projection. Keeping this builder pure makes the
 * validation contract testable without mutating process-global constants.
 */
export function buildPublicBranding(
  args: {
    displayName?: string;
    read?: (key: string) => string | undefined;
  } = {},
): PublicBranding {
  const read = args.read ?? readBrandVar;
  const theme = {} as PublicUiTheme;
  for (const key of Object.keys(DEFAULT_UI_THEME) as Array<keyof PublicUiTheme>) {
    theme[key] = publicColor(read(UI_THEME_ENV[key]), DEFAULT_UI_THEME[key]);
  }
  return {
    displayName: publicDisplayName(args.displayName ?? PLATFORM_BRAND),
    logoPath: publicLogoPath(read('BRAND_UI_LOGO_PATH')),
    theme,
  };
}

/**
 * Resolve which frontdesk folder the enterprise autowire path should target.
 * Honors an explicit configured value first, then falls back to the default
 * frontdesk folder (whether or not it exists on disk yet — the autowire
 * caller logs and skips if the group is missing).
 */
export function resolveFrontdeskFolderFromGroups(_groupsDir: string, configured: string | undefined): string {
  const value = configured?.trim();
  return value || DEFAULT_FRONTDESK_FOLDER;
}

/** Build a worker agent group folder name from its local slug. */
export function buildWorkerFolder(localName: string): string {
  return `${DEFAULT_WORKER_FOLDER_PREFIX}-${localName}`;
}
