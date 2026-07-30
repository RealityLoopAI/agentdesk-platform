/**
 * On-demand, read-only VisionCortex archive adapter.
 *
 * Archive files are untrusted business data. The adapter never accesses the
 * filesystem during construction, discovery, authorization, idle time, expiry,
 * or shutdown. Only execute() reaches the operator-mounted read-only root.
 */
import crypto from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import * as defaultFs from 'node:fs/promises';

export const VISION_ARCHIVE_OPERATION_NAMES = [
  'vision.archive.experiment.search',
  'vision.archive.file.list',
  'vision.archive.json.read',
  'vision.archive.json.search',
];

const OPERATION_SET = new Set(VISION_ARCHIVE_OPERATION_NAMES);
const DEFAULT_CATEGORIES = ['关键帧', '关键片段', '专业报告', '结构化数据'];
const DEFAULT_EXTENSIONS = ['.json', '.pdf', '.jpg', '.jpeg', '.png', '.mp4', '.mov'];
const TEMPORARY_NAME = /(^\.|~$|\.tmp$|\.temp$|\.part$|\.partial$|\.crdownload$)/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const ARCHIVE_NAME = /^(.*)_([0-9]{8})$/u;
const LEGACY_ARCHIVE_NAME = /^exp_([0-9]{8})_([0-9]{6})_([a-z0-9-]+)$/iu;
const LEGACY_CATEGORY_COMPONENTS = new Map([
  ['关键帧', ['analysis', 'keyframes']],
  ['关键片段', ['analysis', 'segments']],
  ['专业报告', ['analysis']],
  ['结构化数据', ['analysis']],
]);

export const VISION_ARCHIVE_OPERATION_DESCRIPTORS = [
  descriptor('vision.archive.experiment.search', 'Search bounded first-level experiment archives.', ['resource']),
  descriptor('vision.archive.file.list', 'List bounded regular files in one selected archive.', [
    'resource',
    'archiveHandle',
  ]),
  descriptor('vision.archive.json.read', 'Read a bounded structural projection from one JSON file.', [
    'resource',
    'fileHandle',
  ]),
  descriptor('vision.archive.json.search', 'Search bounded keys and scalar values in one JSON file.', [
    'resource',
    'fileHandle',
    'query',
  ]),
];

function descriptor(name, description, requiredFields) {
  return {
    name,
    description,
    mutating: false,
    requiredFields,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: requiredFields,
      properties: inputProperties(name),
    },
  };
}

function inputProperties(name) {
  const common = { resource: { type: 'string', description: 'Operator-configured logical archive resource.' } };
  if (name.endsWith('experiment.search')) {
    return {
      ...common,
      name: { type: 'string' },
      dateFrom: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      dateTo: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
      relativeDayOffset: { type: 'integer' },
      timezone: { type: 'string' },
      limit: { type: 'integer' },
      cursor: { type: 'integer' },
    };
  }
  if (name.endsWith('file.list')) {
    return {
      ...common,
      archiveHandle: { type: 'string' },
      category: { type: 'string' },
      extensions: { type: 'array', items: { type: 'string' } },
      limit: { type: 'integer' },
      cursor: { type: 'integer' },
    };
  }
  if (name.endsWith('json.read')) {
    return {
      ...common,
      fileHandle: { type: 'string' },
      pointer: { type: 'string' },
      maxDepth: { type: 'integer' },
      maxItems: { type: 'integer' },
    };
  }
  return {
    ...common,
    fileHandle: { type: 'string' },
    query: { type: 'string' },
    maxResults: { type: 'integer' },
    maxNodes: { type: 'integer' },
  };
}

class ArchiveError extends Error {
  constructor(code, message, status = statusForCode(code), retryable = false) {
    super(message);
    this.name = 'ArchiveError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

/**
 * Return null when entirely unconfigured. Partial or enabled-but-invalid
 * configuration fails closed without touching the configured path.
 */
export function loadVisionArchiveConfigFromEnv(env = process.env) {
  const root = env.VISION_ARCHIVE_ROOT?.trim() || '';
  const policyText = env.VISION_ARCHIVE_RESOURCES_JSON?.trim() || '';
  const readEnabled = parseFlag('VISION_ARCHIVE_READ_ENABLED', env.VISION_ARCHIVE_READ_ENABLED);
  const configured = Boolean(root || policyText || readEnabled);
  if (!configured) return null;
  if (!root || !policyText) {
    throw new Error(
      'incomplete Vision Archive configuration: VISION_ARCHIVE_ROOT and VISION_ARCHIVE_RESOURCES_JSON are required',
    );
  }
  if (!path.isAbsolute(root)) throw new Error('VISION_ARCHIVE_ROOT must be an absolute host mount path');
  let resources;
  try {
    resources = JSON.parse(policyText);
  } catch {
    throw new Error('VISION_ARCHIVE_RESOURCES_JSON must be valid JSON');
  }
  if (!isPlainObject(resources) || Object.keys(resources).length === 0) {
    throw new Error('VISION_ARCHIVE_RESOURCES_JSON must define at least one logical resource');
  }
  return {
    root,
    resources,
    readEnabled,
    categories: parseCsv(env.VISION_ARCHIVE_ALLOWED_CATEGORIES, DEFAULT_CATEGORIES),
    extensions: parseCsv(env.VISION_ARCHIVE_ALLOWED_EXTENSIONS, DEFAULT_EXTENSIONS).map(normalizeExtension),
    maxRootEntries: parseInteger(env, 'VISION_ARCHIVE_MAX_ROOT_ENTRIES', 2_000, 1, 100_000),
    maxListEntries: parseInteger(env, 'VISION_ARCHIVE_MAX_LIST_ENTRIES', 2_000, 1, 100_000),
    maxResults: parseInteger(env, 'VISION_ARCHIVE_MAX_RESULTS', 100, 1, 1_000),
    maxJsonBytes: parseInteger(env, 'VISION_ARCHIVE_MAX_JSON_BYTES', 2 * 1024 * 1024, 1_024, 64 * 1024 * 1024),
    maxJsonDepth: parseInteger(env, 'VISION_ARCHIVE_MAX_JSON_DEPTH', 8, 1, 64),
    maxJsonItems: parseInteger(env, 'VISION_ARCHIVE_MAX_JSON_ITEMS', 500, 1, 100_000),
    maxJsonNodes: parseInteger(env, 'VISION_ARCHIVE_MAX_JSON_NODES', 20_000, 1, 1_000_000),
    handleTtlMs: parseInteger(env, 'VISION_ARCHIVE_HANDLE_TTL_MS', 10 * 60_000, 1_000, 24 * 60 * 60_000),
    maxHandles: parseInteger(env, 'VISION_ARCHIVE_MAX_HANDLES', 5_000, 10, 100_000),
    operationTimeoutMs: parseInteger(env, 'VISION_ARCHIVE_OPERATION_TIMEOUT_MS', 10_000, 100, 120_000),
  };
}

export function createVisionArchiveAdapter(options = {}) {
  const {
    root,
    resources,
    readEnabled = false,
    categories = DEFAULT_CATEGORIES,
    extensions = DEFAULT_EXTENSIONS,
    maxRootEntries = 2_000,
    maxListEntries = 2_000,
    maxResults = 100,
    maxJsonBytes = 2 * 1024 * 1024,
    maxJsonDepth = 8,
    maxJsonItems = 500,
    maxJsonNodes = 20_000,
    handleTtlMs = 10 * 60_000,
    maxHandles = 5_000,
    operationTimeoutMs = 10_000,
    fs = defaultFs,
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID(),
    audit = () => {},
    beforePostReadStat,
  } = options;
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('root must be an absolute mount path');
  if (!isPlainObject(resources) || Object.keys(resources).length === 0) {
    throw new Error('resources must be a non-empty operator policy');
  }
  if (typeof readEnabled !== 'boolean') throw new Error('readEnabled must be boolean');
  const allowedCategories = normalizeClosedSet(categories, 'categories', false);
  const allowedExtensions = normalizeClosedSet(extensions.map(normalizeExtension), 'extensions', true);
  const policies = normalizePolicies(resources, allowedCategories);
  const handles = new Map();
  const limits = {
    maxRootEntries: boundedInteger(maxRootEntries, 1, 100_000, 'maxRootEntries'),
    maxListEntries: boundedInteger(maxListEntries, 1, 100_000, 'maxListEntries'),
    maxResults: boundedInteger(maxResults, 1, 1_000, 'maxResults'),
    maxJsonBytes: boundedInteger(maxJsonBytes, 1_024, 64 * 1024 * 1024, 'maxJsonBytes'),
    maxJsonDepth: boundedInteger(maxJsonDepth, 1, 64, 'maxJsonDepth'),
    maxJsonItems: boundedInteger(maxJsonItems, 1, 100_000, 'maxJsonItems'),
    maxJsonNodes: boundedInteger(maxJsonNodes, 1, 1_000_000, 'maxJsonNodes'),
    handleTtlMs: boundedInteger(handleTtlMs, 1, 24 * 60 * 60_000, 'handleTtlMs'),
    maxHandles: boundedInteger(maxHandles, 1, 100_000, 'maxHandles'),
    operationTimeoutMs: boundedInteger(operationTimeoutMs, 100, 120_000, 'operationTimeoutMs'),
  };

  function isOperation(name) {
    return OPERATION_SET.has(name) && readEnabled;
  }

  function describeOperations() {
    return readEnabled ? structuredClone(VISION_ARCHIVE_OPERATION_DESCRIPTORS) : [];
  }

  async function authorize(req) {
    const validation = authorizeOnly(req);
    return validation.allowed
      ? { allowed: true, obligations: [] }
      : { allowed: false, reason: validation.reason, error: errorBody(validation.error) };
  }

  async function execute(req) {
    const auditId = randomUUID();
    const startedAt = now();
    let resource = safeText(req?.input?.resource);
    let outcome = 'error';
    try {
      const decision = authorizeOnly(req);
      if (!decision.allowed) throw decision.error;
      const input = validateInput(req.operation, req.input, allowedCategories, allowedExtensions, limits, now);
      resource = input.resource;
      const identity = requestIdentity(req);
      const result = await withDeadline(
        dispatch(req.operation, input, identity, decision.policy),
        limits.operationTimeoutMs,
      );
      outcome = 'ok';
      return { ok: true, result, auditId };
    } catch (error) {
      const normalized = normalizeError(error);
      outcome = normalized.code;
      return { status: normalized.status, body: errorBody(normalized) };
    } finally {
      await safeAudit(audit, {
        phase: 'execute',
        auditId,
        operation: safeText(req?.operation),
        resource,
        requesterUserId: canonicalUserId(req),
        agentGroupId: canonicalAgentGroupId(req),
        requesterSource: req?.requesterSource,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
      });
    }
  }

  function authorizeOnly(req) {
    const operation = safeText(req?.operation);
    if (!readEnabled || !OPERATION_SET.has(operation)) {
      const error = new ArchiveError('OPERATION_NOT_FOUND', `operation is disabled or unknown: ${operation}`, 404);
      return { allowed: false, reason: error.message, error };
    }
    if (req?.requesterSource !== 'session') {
      const error = new ArchiveError('BACKEND_UNAUTHORIZED', 'archive reads require a session-trusted requester', 403);
      return { allowed: false, reason: error.message, error };
    }
    const userId = canonicalUserId(req);
    const agentGroupId = canonicalAgentGroupId(req);
    if (!userId || !agentGroupId) {
      const error = new ArchiveError(
        'BACKEND_UNAUTHORIZED',
        'canonical requester.userId and agent.agentGroupId are required',
        403,
      );
      return { allowed: false, reason: error.message, error };
    }
    const resource = safeText(req?.input?.resource);
    const policy = policies.get(resource);
    if (!policy || !matchesPolicy(policy, userId, agentGroupId)) {
      const error = new ArchiveError(
        'BACKEND_UNAUTHORIZED',
        'requester is not allowed to read this archive resource',
        403,
      );
      return { allowed: false, reason: error.message, error };
    }
    return { allowed: true, policy };
  }

  async function dispatch(operation, input, identity, policy) {
    if (operation === 'vision.archive.experiment.search') return searchExperiments(input, identity, policy);
    if (operation === 'vision.archive.file.list') return listFiles(input, identity, policy);
    if (operation === 'vision.archive.json.read') return readJson(input, identity, policy);
    if (operation === 'vision.archive.json.search') return searchJson(input, identity, policy);
    throw new ArchiveError('OPERATION_NOT_FOUND', `unknown operation: ${operation}`, 404);
  }

  async function searchExperiments(input, identity, policy) {
    const rootPath = await resolveRoot();
    const entries = await readDirectory(rootPath, limits.maxRootEntries, 'archive root');
    const matches = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || unsafeEntryName(entry.name)) continue;
      const parsed = parseArchiveName(entry.name);
      if (!parsed) continue;
      if (input.dateFrom && parsed.date < input.dateFrom) continue;
      if (input.dateTo && parsed.date > input.dateTo) continue;
      const experimentName =
        parsed.layout === 'legacy'
          ? await readLegacyExperimentName(rootPath, entry.name, parsed.name)
          : parsed.name;
      if (input.name && !experimentName.normalize('NFC').includes(input.name.normalize('NFC'))) continue;
      if (
        policy.prefixes.length &&
        !policy.prefixes.some((prefix) => experimentName.normalize('NFC').startsWith(prefix))
      ) {
        continue;
      }
      await validateComponents(rootPath, [entry.name], 'directory');
      matches.push({
        archiveHandle: putHandle('archive', [entry.name], identity),
        experimentName,
        date: parsed.date,
        displayName: entry.name.normalize('NFC'),
        layout: parsed.layout,
        untrusted: true,
      });
    }
    matches.sort((a, b) => b.date.localeCompare(a.date) || a.displayName.localeCompare(b.displayName, 'zh-CN'));
    return paginate(matches, input.cursor, input.limit, 'archives');
  }

  async function listFiles(input, identity, policy) {
    const archive = getHandle(input.archiveHandle, 'archive', identity);
    const rootPath = await resolveRoot();
    await validateComponents(rootPath, archive.components, 'directory');
    const category = input.category;
    if (category && !policy.categories.has(category)) {
      throw new ArchiveError('BACKEND_UNAUTHORIZED', 'category is not allowed by this resource policy', 403);
    }
    const parsedArchive = parseArchiveName(archive.components[0]);
    const categoryPath =
      category && parsedArchive?.layout === 'legacy'
        ? LEGACY_CATEGORY_COMPONENTS.get(category)
        : category
          ? [category]
          : [];
    if (category && !categoryPath) {
      throw new ArchiveError('RESOURCE_NOT_READY', 'requested legacy archive category is not available', 409, true);
    }
    const baseComponents = [...archive.components, ...categoryPath];
    let basePath;
    try {
      basePath = await validateComponents(rootPath, baseComponents, 'directory');
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new ArchiveError('RESOURCE_NOT_READY', 'requested archive category is not present yet', 409, true);
      throw error;
    }
    const entries = await readDirectory(basePath, limits.maxListEntries, 'archive category');
    const files = [];
    for (const entry of entries) {
      if (!entry.isFile() || unsafeEntryName(entry.name)) continue;
      const extension = path.extname(entry.name).toLowerCase();
      if (!allowedExtensions.has(extension) || (input.extensions && !input.extensions.includes(extension))) continue;
      const components = [...baseComponents, entry.name];
      const filePath = await validateComponents(rootPath, components, 'file');
      const stat = await mapFs(() => fs.stat(filePath));
      files.push({
        fileHandle: putHandle('file', components, identity),
        name: entry.name.normalize('NFC'),
        category: category ?? null,
        extension,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        untrusted: true,
      });
    }
    files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    return paginate(files, input.cursor, input.limit, 'files');
  }

  async function readJson(input, identity) {
    const { value, metadata } = await loadStableJson(input.fileHandle, identity);
    const selected = resolvePointer(value, input.pointer);
    const budget = { remaining: input.maxItems, truncated: false };
    const projection = projectValue(selected, 0, input.maxDepth, budget);
    return {
      pointer: input.pointer,
      value: projection,
      type: jsonType(selected),
      truncated: budget.truncated,
      file: metadata,
      untrusted: true,
    };
  }

  async function searchJson(input, identity) {
    const { value, metadata } = await loadStableJson(input.fileHandle, identity);
    const query = input.query.normalize('NFC').toLocaleLowerCase();
    const stack = [{ value, pointer: '' }];
    const matches = [];
    let visited = 0;
    let truncated = false;
    while (stack.length) {
      if (visited >= input.maxNodes || matches.length >= input.maxResults) {
        truncated = true;
        break;
      }
      const current = stack.pop();
      visited += 1;
      if (Array.isArray(current.value)) {
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          stack.push({ value: current.value[index], pointer: `${current.pointer}/${index}` });
        }
      } else if (isPlainObject(current.value)) {
        for (const [key, child] of Object.entries(current.value).reverse()) {
          const pointer = `${current.pointer}/${escapePointer(key)}`;
          if (key.normalize('NFC').toLocaleLowerCase().includes(query)) {
            matches.push({ pointer, match: 'key', preview: previewScalar(child), untrusted: true });
            if (matches.length >= input.maxResults) break;
          }
          stack.push({ value: child, pointer });
        }
      } else {
        const scalar = String(current.value);
        if (scalar.normalize('NFC').toLocaleLowerCase().includes(query)) {
          matches.push({ pointer: current.pointer, match: 'value', preview: scalar.slice(0, 200), untrusted: true });
        }
      }
    }
    return { matches, visitedNodes: visited, truncated, file: metadata, untrusted: true };
  }

  async function loadStableJson(handleValue, identity) {
    const handle = getHandle(handleValue, 'file', identity);
    if (path.extname(handle.components.at(-1)).toLowerCase() !== '.json') {
      throw new ArchiveError('VALIDATION_FAILED', 'fileHandle does not identify an allowed JSON file', 422);
    }
    return loadStableJsonComponents(handle.components);
  }

  async function readLegacyExperimentName(rootPath, archiveName, fallback) {
    try {
      const { value } = await loadStableJsonComponents(
        [archiveName, 'experiment_manifest.json'],
        rootPath,
      );
      const name = value?.experiment_name;
      return typeof name === 'string' &&
        name.trim() &&
        name.length <= 200 &&
        !CONTROL.test(name)
        ? name.trim().normalize('NFC')
        : fallback;
    } catch (error) {
      if (
        error?.code === 'ENOENT' ||
        (error instanceof ArchiveError &&
          [
            'RESOURCE_NOT_READY',
            'BACKEND_BUSY',
            'PAYLOAD_TOO_LARGE',
            'BACKEND_UNAVAILABLE',
          ].includes(error.code))
      ) {
        return fallback;
      }
      throw error;
    }
  }

  async function loadStableJsonComponents(components, resolvedRoot) {
    const rootPath = resolvedRoot ?? (await resolveRoot());
    const filePath = await validateComponents(rootPath, components, 'file');
    let file;
    try {
      file = await mapFs(() => fs.open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)));
      const before = await mapFs(() => file.stat());
      if (!before.isFile() || before.nlink !== 1) {
        throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'archive JSON must be a single-link regular file', 403);
      }
      if (before.size > limits.maxJsonBytes) {
        throw new ArchiveError('PAYLOAD_TOO_LARGE', 'JSON file exceeds the configured byte limit', 413);
      }
      const bytes = await mapFs(() => file.readFile());
      if (bytes.byteLength > limits.maxJsonBytes) {
        throw new ArchiveError('PAYLOAD_TOO_LARGE', 'JSON file exceeds the configured byte limit', 413);
      }
      if (typeof beforePostReadStat === 'function') await beforePostReadStat(filePath);
      const after = await mapFs(() => file.stat());
      await validateComponents(rootPath, components, 'file');
      const current = await mapFs(() => fs.stat(filePath));
      if (!sameFile(before, after) || !sameFile(after, current) || bytes.byteLength !== before.size) {
        throw new ArchiveError('BACKEND_BUSY', 'archive file changed while it was read', 409, true);
      }
      let value;
      try {
        value = JSON.parse(bytes.toString('utf8'));
      } catch {
        throw new ArchiveError('RESOURCE_NOT_READY', 'JSON is malformed or still being written', 409, true);
      }
      return {
        value,
        metadata: {
          name: components.at(-1).normalize('NFC'),
          size: after.size,
          modifiedAt: after.mtime.toISOString(),
        },
      };
    } catch (error) {
      if (error?.code === 'ENOENT')
        throw new ArchiveError('RESOURCE_NOT_READY', 'archive file disappeared or is not ready', 409, true);
      throw error;
    } finally {
      await file?.close().catch(() => {});
    }
  }

  async function resolveRoot() {
    try {
      const rootStat = await fs.lstat(root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'archive root must be a real directory', 403);
      }
      return await fs.realpath(root);
    } catch (error) {
      if (error instanceof ArchiveError) throw error;
      throw fsUnavailable(error, 'archive root is unavailable');
    }
  }

  async function validateComponents(rootPath, components, expected) {
    let current = rootPath;
    for (const component of components) {
      validateComponent(component);
      current = path.join(current, component);
      const stat = await mapFs(() => fs.lstat(current));
      if (stat.isSymbolicLink()) throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'symbolic links are not allowed', 403);
      if (component !== components.at(-1) && !stat.isDirectory()) {
        throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'archive path component is not a directory', 403);
      }
    }
    const finalStat = await mapFs(() => fs.lstat(current));
    if (expected === 'directory' && !finalStat.isDirectory()) {
      throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'selected archive resource is not a directory', 403);
    }
    if (expected === 'file' && !finalStat.isFile()) {
      throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'selected archive resource is not a regular file', 403);
    }
    const canonical = await mapFs(() => fs.realpath(current));
    if (canonical !== rootPath && !canonical.startsWith(`${rootPath}${path.sep}`)) {
      throw new ArchiveError('RESOURCE_NOT_ALLOWED', 'archive resource is outside the configured root', 403);
    }
    return canonical;
  }

  async function readDirectory(directory, maximum, label) {
    const entries = await mapFs(() => fs.readdir(directory, { withFileTypes: true }));
    if (entries.length > maximum) {
      throw new ArchiveError('RESULT_LIMIT_EXCEEDED', `${label} exceeds the configured entry limit`, 422);
    }
    return entries;
  }

  function putHandle(type, components, identity) {
    purgeExpiredHandles();
    while (handles.size >= limits.maxHandles) handles.delete(handles.keys().next().value);
    const token = `vah_${randomUUID().replaceAll('-', '')}`;
    handles.set(token, { type, components: [...components], ...identity, expiresAt: now() + limits.handleTtlMs });
    return token;
  }

  function getHandle(token, type, identity) {
    purgeExpiredHandles();
    const handle = typeof token === 'string' ? handles.get(token) : null;
    if (!handle) throw new ArchiveError('INVALID_HANDLE', 'handle is unknown or expired', 422);
    if (handle.type !== type) throw new ArchiveError('INVALID_HANDLE', `handle is not a ${type} handle`, 422);
    if (handle.userId !== identity.userId || handle.agentGroupId !== identity.agentGroupId) {
      throw new ArchiveError('BACKEND_UNAUTHORIZED', 'handle belongs to a different requester or Agent Group', 403);
    }
    return handle;
  }

  function purgeExpiredHandles() {
    const timestamp = now();
    for (const [token, handle] of handles) {
      if (handle.expiresAt <= timestamp) handles.delete(token);
    }
  }

  return {
    isOperation,
    describeOperations,
    authorize,
    execute,
    inspection: {
      handleCount: () => handles.size,
    },
  };
}

function validateInput(operation, raw, categories, extensions, limits, now) {
  if (!isPlainObject(raw)) throw new ArchiveError('VALIDATION_FAILED', 'input must be an object', 422);
  const schemas = {
    'vision.archive.experiment.search': [
      'resource',
      'name',
      'dateFrom',
      'dateTo',
      'relativeDayOffset',
      'timezone',
      'limit',
      'cursor',
    ],
    'vision.archive.file.list': ['resource', 'archiveHandle', 'category', 'extensions', 'limit', 'cursor'],
    'vision.archive.json.read': ['resource', 'fileHandle', 'pointer', 'maxDepth', 'maxItems'],
    'vision.archive.json.search': ['resource', 'fileHandle', 'query', 'maxResults', 'maxNodes'],
  };
  const allowed = schemas[operation];
  if (!allowed) throw new ArchiveError('OPERATION_NOT_FOUND', `unknown operation: ${operation}`, 404);
  const unknown = Object.keys(raw).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new ArchiveError('VALIDATION_FAILED', `unknown input fields: ${unknown.join(', ')}`, 422);
  const resource = requiredText(raw.resource, 'resource', 128);
  const base = { resource };
  if (operation.endsWith('experiment.search')) {
    const name = optionalText(raw.name, 'name', 200);
    const relative = raw.relativeDayOffset;
    const hasExplicit = raw.dateFrom !== undefined || raw.dateTo !== undefined;
    if (relative !== undefined && hasExplicit) {
      throw new ArchiveError('VALIDATION_FAILED', 'relativeDayOffset cannot be combined with dateFrom/dateTo', 422);
    }
    let dateFrom = raw.dateFrom === undefined ? undefined : validateIsoDate(raw.dateFrom, 'dateFrom');
    let dateTo = raw.dateTo === undefined ? undefined : validateIsoDate(raw.dateTo, 'dateTo');
    if (relative !== undefined) {
      const offset = boundedInteger(relative, -3660, 3660, 'relativeDayOffset');
      const timezone = requiredText(raw.timezone, 'timezone', 100);
      dateFrom = dateTo = relativeDate(offset, timezone, now());
    } else if (raw.timezone !== undefined) {
      throw new ArchiveError('VALIDATION_FAILED', 'timezone is only valid with relativeDayOffset', 422);
    }
    if (dateFrom && dateTo && dateFrom > dateTo) {
      throw new ArchiveError('VALIDATION_FAILED', 'dateFrom must not be after dateTo', 422);
    }
    return {
      ...base,
      name,
      dateFrom,
      dateTo,
      limit: boundedOptional(raw.limit, 1, limits.maxResults, Math.min(20, limits.maxResults), 'limit'),
      cursor: boundedOptional(raw.cursor, 0, Number.MAX_SAFE_INTEGER, 0, 'cursor'),
    };
  }
  if (operation.endsWith('file.list')) {
    const category = optionalText(raw.category, 'category', 100);
    if (category && !categories.has(category.normalize('NFC'))) {
      throw new ArchiveError('VALIDATION_FAILED', 'category is not in the configured closed allowlist', 422);
    }
    let requestedExtensions;
    if (raw.extensions !== undefined) {
      if (!Array.isArray(raw.extensions) || raw.extensions.length === 0 || raw.extensions.length > extensions.size) {
        throw new ArchiveError('VALIDATION_FAILED', 'extensions must be a non-empty bounded array', 422);
      }
      requestedExtensions = [...new Set(raw.extensions.map(normalizeExtension))];
      if (requestedExtensions.some((extension) => !extensions.has(extension))) {
        throw new ArchiveError('VALIDATION_FAILED', 'extension is not in the configured closed allowlist', 422);
      }
    }
    return {
      ...base,
      archiveHandle: requiredHandle(raw.archiveHandle, 'archiveHandle'),
      category: category?.normalize('NFC'),
      extensions: requestedExtensions,
      limit: boundedOptional(raw.limit, 1, limits.maxResults, Math.min(50, limits.maxResults), 'limit'),
      cursor: boundedOptional(raw.cursor, 0, Number.MAX_SAFE_INTEGER, 0, 'cursor'),
    };
  }
  if (operation.endsWith('json.read')) {
    const pointer = raw.pointer === undefined ? '' : validatePointer(raw.pointer);
    return {
      ...base,
      fileHandle: requiredHandle(raw.fileHandle, 'fileHandle'),
      pointer,
      maxDepth: boundedOptional(raw.maxDepth, 1, limits.maxJsonDepth, limits.maxJsonDepth, 'maxDepth'),
      maxItems: boundedOptional(raw.maxItems, 1, limits.maxJsonItems, limits.maxJsonItems, 'maxItems'),
    };
  }
  return {
    ...base,
    fileHandle: requiredHandle(raw.fileHandle, 'fileHandle'),
    query: requiredText(raw.query, 'query', 200).normalize('NFC'),
    maxResults: boundedOptional(raw.maxResults, 1, limits.maxResults, Math.min(20, limits.maxResults), 'maxResults'),
    maxNodes: boundedOptional(raw.maxNodes, 1, limits.maxJsonNodes, limits.maxJsonNodes, 'maxNodes'),
  };
}

function normalizePolicies(resources, categories) {
  const result = new Map();
  for (const [alias, value] of Object.entries(resources)) {
    validateComponent(alias);
    if (!isPlainObject(value)) throw new Error(`resource policy ${alias} must be an object`);
    const readers = normalizePolicySet(value.readers, `${alias}.readers`);
    const agentGroups = normalizePolicySet(value.agentGroups, `${alias}.agentGroups`);
    const prefixes = Array.isArray(value.experimentPrefixes)
      ? value.experimentPrefixes.map((item) => requiredText(item, 'experimentPrefix', 200).normalize('NFC'))
      : [];
    const policyCategories =
      value.categories === undefined
        ? new Set(categories)
        : normalizeClosedSet(value.categories, `${alias}.categories`, false);
    for (const category of policyCategories) {
      if (!categories.has(category))
        throw new Error(`resource policy ${alias} contains a category outside the global allowlist`);
    }
    result.set(alias, { readers, agentGroups, prefixes, categories: policyCategories });
  }
  return result;
}

function matchesPolicy(policy, userId, agentGroupId) {
  return (
    (policy.readers.has('*') || policy.readers.has(userId)) &&
    (policy.agentGroups.has('*') || policy.agentGroups.has(agentGroupId))
  );
}

function requestIdentity(req) {
  return { userId: canonicalUserId(req), agentGroupId: canonicalAgentGroupId(req) };
}

function canonicalUserId(req) {
  return typeof req?.requester?.userId === 'string' && req.requester.userId.trim() ? req.requester.userId.trim() : '';
}

function canonicalAgentGroupId(req) {
  return typeof req?.agent?.agentGroupId === 'string' && req.agent.agentGroupId.trim()
    ? req.agent.agentGroupId.trim()
    : '';
}

function parseArchiveName(name) {
  const legacyMatch = LEGACY_ARCHIVE_NAME.exec(name);
  if (legacyMatch) {
    const compactDate = legacyMatch[1];
    const date = `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
    try {
      validateIsoDate(date, 'archive date');
    } catch {
      return null;
    }
    return { name: name.normalize('NFC'), date, layout: 'legacy' };
  }
  const match = ARCHIVE_NAME.exec(name);
  if (!match || !match[1]) return null;
  const date = `${match[2].slice(0, 4)}-${match[2].slice(4, 6)}-${match[2].slice(6, 8)}`;
  try {
    validateIsoDate(date, 'archive date');
  } catch {
    return null;
  }
  return { name: match[1].normalize('NFC'), date, layout: 'readable' };
}

function validateIsoDate(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ArchiveError('VALIDATION_FAILED', `${field} must use YYYY-MM-DD`, 422);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new ArchiveError('VALIDATION_FAILED', `${field} is not a valid calendar date`, 422);
  }
  return value;
}

function relativeDate(offset, timezone, timestamp) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(timestamp))
      .reduce((all, part) => ({ ...all, [part.type]: part.value }), {});
  } catch {
    throw new ArchiveError('VALIDATION_FAILED', 'timezone must be a valid IANA timezone', 422);
  }
  const target = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset));
  return `${target.getUTCFullYear().toString().padStart(4, '0')}-${(target.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}-${target.getUTCDate().toString().padStart(2, '0')}`;
}

function resolvePointer(value, pointer) {
  if (pointer === '') return value;
  let current = value;
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) {
        throw new ArchiveError('RESOURCE_NOT_FOUND', 'JSON Pointer does not exist', 404);
      }
      current = current[Number(key)];
    } else if (isPlainObject(current) && Object.hasOwn(current, key)) {
      current = current[key];
    } else {
      throw new ArchiveError('RESOURCE_NOT_FOUND', 'JSON Pointer does not exist', 404);
    }
  }
  return current;
}

function projectValue(value, depth, maxDepth, budget) {
  if (value === null || typeof value !== 'object') return previewScalar(value);
  if (depth >= maxDepth || budget.remaining <= 0) {
    budget.truncated = true;
    return Array.isArray(value)
      ? { type: 'array', count: value.length }
      : { type: 'object', count: Object.keys(value).length, keys: Object.keys(value).slice(0, 20) };
  }
  if (Array.isArray(value)) {
    const items = [];
    for (const item of value) {
      if (budget.remaining-- <= 0) {
        budget.truncated = true;
        break;
      }
      items.push(projectValue(item, depth + 1, maxDepth, budget));
    }
    if (items.length < value.length) budget.truncated = true;
    return { type: 'array', count: value.length, items };
  }
  const entries = {};
  for (const [key, item] of Object.entries(value)) {
    if (budget.remaining-- <= 0) {
      budget.truncated = true;
      break;
    }
    entries[key] = projectValue(item, depth + 1, maxDepth, budget);
  }
  if (Object.keys(entries).length < Object.keys(value).length) budget.truncated = true;
  return { type: 'object', count: Object.keys(value).length, entries };
}

function previewScalar(value) {
  if (typeof value === 'string') return value.slice(0, 200);
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  return `[${jsonType(value)}]`;
}

function jsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function sameFile(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

function paginate(items, cursor, limit, key) {
  const selected = items.slice(cursor, cursor + limit);
  const nextCursor = cursor + selected.length < items.length ? cursor + selected.length : null;
  return { [key]: selected, nextCursor, truncated: nextCursor !== null, untrusted: true };
}

function unsafeEntryName(name) {
  return TEMPORARY_NAME.test(name) || CONTROL.test(name) || name === '.' || name === '..';
}

function validateComponent(value) {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    path.isAbsolute(value) ||
    value.includes('/') ||
    value.includes('\\') ||
    CONTROL.test(value) ||
    TEMPORARY_NAME.test(value)
  ) {
    throw new ArchiveError('VALIDATION_FAILED', 'unsafe archive path component', 422);
  }
}

function requiredHandle(value, field) {
  const text = requiredText(value, field, 128);
  if (!/^vah_[a-f0-9]{16,64}$/i.test(text)) {
    throw new ArchiveError('VALIDATION_FAILED', `${field} is not a valid opaque handle`, 422);
  }
  return text;
}

function validatePointer(value) {
  if (
    typeof value !== 'string' ||
    value.length > 1_000 ||
    CONTROL.test(value) ||
    (value !== '' && (!value.startsWith('/') || /~(?![01])/u.test(value)))
  ) {
    throw new ArchiveError('VALIDATION_FAILED', 'pointer must be a valid bounded JSON Pointer', 422);
  }
  return value;
}

function requiredText(value, field, maximum) {
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || CONTROL.test(value)) {
    throw new ArchiveError('VALIDATION_FAILED', `${field} must be a non-empty bounded string`, 422);
  }
  return value.trim();
}

function optionalText(value, field, maximum) {
  return value === undefined ? undefined : requiredText(value, field, maximum);
}

function safeText(value) {
  return typeof value === 'string' ? value.slice(0, 128) : '';
}

function boundedOptional(value, min, max, fallback, field) {
  return value === undefined ? fallback : boundedInteger(value, min, max, field);
}

function boundedInteger(value, min, max, field) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ArchiveError('VALIDATION_FAILED', `${field} must be an integer from ${min} to ${max}`, 422);
  }
  return value;
}

function parseInteger(env, key, fallback, min, max) {
  if (env[key] === undefined || env[key] === '') return fallback;
  const value = Number(env[key]);
  try {
    return boundedInteger(value, min, max, key);
  } catch (error) {
    throw new Error(error.message);
  }
}

function parseFlag(name, value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be exactly "true" or "false"`);
}

function parseCsv(value, fallback) {
  if (!value?.trim()) return [...fallback];
  const values = value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  if (!values.length) throw new Error('configured allowlist must not be empty');
  return values;
}

function normalizeExtension(value) {
  if (typeof value !== 'string') throw new ArchiveError('VALIDATION_FAILED', 'extension must be a string', 422);
  const normalized = value.trim().toLowerCase();
  if (!/^\.[a-z0-9]{1,10}$/.test(normalized)) {
    throw new ArchiveError('VALIDATION_FAILED', 'extension must be a simple dot suffix', 422);
  }
  return normalized;
}

function normalizeClosedSet(values, name, lower) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${name} must be a non-empty array`);
  return new Set(
    values.map((value) => {
      if (typeof value !== 'string' || !value.trim() || CONTROL.test(value))
        throw new Error(`${name} contains an invalid value`);
      return lower ? value.trim().toLowerCase() : value.trim().normalize('NFC');
    }),
  );
}

function normalizePolicySet(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must be a non-empty array`);
  return new Set(value.map((item) => requiredText(item, name, 256)));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function escapePointer(value) {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

async function withDeadline(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new ArchiveError('BACKEND_TIMEOUT', 'archive operation timed out', 504, true)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function mapFs(operation) {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    if (error?.code === 'ENOENT') throw error;
    throw fsUnavailable(error, 'archive filesystem is unavailable');
  }
}

function fsUnavailable(error, message) {
  const code = ['EACCES', 'EPERM', 'ELOOP'].includes(error?.code) ? 'RESOURCE_NOT_ALLOWED' : 'BACKEND_UNAVAILABLE';
  return new ArchiveError(code, message, code === 'RESOURCE_NOT_ALLOWED' ? 403 : 503, code === 'BACKEND_UNAVAILABLE');
}

function normalizeError(error) {
  return error instanceof ArchiveError
    ? error
    : new ArchiveError('BACKEND_UNAVAILABLE', 'archive operation failed', 503, true);
}

function statusForCode(code) {
  if (code === 'BACKEND_UNAUTHORIZED' || code === 'RESOURCE_NOT_ALLOWED') return 403;
  if (code === 'OPERATION_NOT_FOUND' || code === 'RESOURCE_NOT_FOUND') return 404;
  if (code === 'PAYLOAD_TOO_LARGE') return 413;
  if (code === 'BACKEND_BUSY' || code === 'RESOURCE_NOT_READY') return 409;
  if (code === 'BACKEND_TIMEOUT') return 504;
  if (code === 'BACKEND_UNAVAILABLE') return 503;
  return 422;
}

function errorBody(error) {
  return {
    code: error.code,
    message: error.message,
    ...(error.retryable ? { retryable: true } : {}),
  };
}

async function safeAudit(audit, event) {
  try {
    await audit(event);
  } catch {
    // Audit sinks must not change the operation result in this reference adapter.
  }
}
