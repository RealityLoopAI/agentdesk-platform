/**
 * Reusable Feishu Bitable adapter for an operator-owned Backend Gateway.
 *
 * Zero dependencies: Node built-ins + global fetch only. The adapter deliberately
 * lives under the reference Gateway, not under src/channels/feishu: chat ingress
 * must never become a parallel business-data path (ADR-0056).
 *
 * This is a security-focused reference, not a production persistence layer.
 * Production deployments must replace the in-memory idempotency and confirmation
 * stores with durable, transactional storage.
 */
import crypto from 'node:crypto';

export const FEISHU_BITABLE_OPERATION_NAMES = [
  'feishu.bitable.app.get',
  'feishu.bitable.table.list',
  'feishu.bitable.field.list',
  'feishu.bitable.record.list',
  'feishu.bitable.record.get',
  'feishu.bitable.record.create',
  'feishu.bitable.record.update',
  'feishu.bitable.record.delete',
  'feishu.bitable.record.batch_create',
  'feishu.bitable.record.batch_update',
  'feishu.bitable.record.batch_delete',
];

const WRITE_OPERATIONS = new Set([
  'feishu.bitable.record.create',
  'feishu.bitable.record.update',
  'feishu.bitable.record.delete',
  'feishu.bitable.record.batch_create',
  'feishu.bitable.record.batch_update',
  'feishu.bitable.record.batch_delete',
]);
const DELETE_OPERATIONS = new Set(['feishu.bitable.record.delete', 'feishu.bitable.record.batch_delete']);
const COMPUTED_FIELD_TYPES = new Set([19, 20, 1001, 1002, 1003, 1004, 1005, 3001]);
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_BATCH_RECORDS = 100;
const MAX_QUERY_CONDITIONS = 10;
const MAX_ORDER_BY = 3;
const MAX_FILTER_JSON_CHARS = 2_000;
const MAX_SORT_JSON_CHARS = 1_000;
const DEFAULT_SCHEMA_TTL_MS = 5 * 60 * 1000;
const DEFAULT_CURSOR_TTL_MS = 15 * 60 * 1000;
const DEFAULT_CONFIRMATION_TTL_MS = 5 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 30_000;
const STRUCTURED_QUERY_OPERATORS = new Set([
  'eq',
  'ne',
  'isEmpty',
  'isNotEmpty',
  'contains',
  'notContains',
  'startsWith',
  'gt',
  'gte',
  'lt',
  'lte',
]);

const OPERATION_DESCRIPTORS = FEISHU_BITABLE_OPERATION_NAMES.map((name) => {
  const mutating = WRITE_OPERATIONS.has(name);
  const isBatch = name.includes('.batch_');
  const descriptor = {
    name,
    summary: operationSummary(name),
    mutating,
    approval: DELETE_OPERATIONS.has(name)
      ? 'user-confirmation'
      : name === 'feishu.bitable.record.update'
        ? 'user-confirmation'
        : name.endsWith('.batch_update')
          ? 'policy-or-confirmation'
          : mutating
            ? 'policy'
            : undefined,
    requiredFields: requiredFieldsForOperation(name),
    schema: descriptorInputSchema(name),
  };
  if (name.endsWith('.list')) {
    descriptor.pagination = {
      defaultPageSize: DEFAULT_PAGE_SIZE,
      maxPageSize: MAX_PAGE_SIZE,
      opaqueCursor: true,
    };
  }
  if (mutating) {
    descriptor.idempotency = { required: true, replayReturnsFirstCommittedResult: true };
  }
  if (isBatch) {
    descriptor.batch = {
      maxRecords: MAX_BATCH_RECORDS,
      modes: ['atomic', 'best-effort'],
      indexAlignedResults: true,
      partialFlag: true,
    };
  }
  return descriptor;
});

class AdapterError extends Error {
  constructor(code, message, { status, retryable = false, retryAfterMs } = {}) {
    super(message);
    this.name = 'AdapterError';
    this.code = code;
    this.status = status ?? statusForCode(code);
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Parse the optional environment configuration without ever printing secrets.
 * Returns null when the feature is entirely unconfigured; partial configuration
 * fails closed during process startup.
 */
export function loadFeishuBitableConfigFromEnv(env = process.env) {
  const credentialKeys = [
    'FEISHU_BITABLE_APP_ID',
    'FEISHU_BITABLE_APP_SECRET',
    'FEISHU_BITABLE_RESOURCES_JSON',
    'FEISHU_BITABLE_CURSOR_SECRET',
    'FEISHU_BITABLE_CONFIRMATION_SECRET',
  ];
  const readEnabled = parseOptInFlag('FEISHU_BITABLE_READ_ENABLED', env.FEISHU_BITABLE_READ_ENABLED);
  const writeEnabled = parseOptInFlag('FEISHU_BITABLE_WRITE_ENABLED', env.FEISHU_BITABLE_WRITE_ENABLED);
  const hasCredentialConfig = credentialKeys.some((key) => typeof env[key] === 'string' && env[key].trim());
  if (!hasCredentialConfig) {
    if (readEnabled || writeEnabled) {
      throw new Error('Feishu Bitable feature flag is enabled but Gateway credentials/resources are not configured');
    }
    return null;
  }

  const missing = credentialKeys.filter((key) => !env[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`incomplete Feishu Bitable Gateway configuration: missing ${missing.join(', ')}`);
  }

  let resources;
  try {
    resources = JSON.parse(env.FEISHU_BITABLE_RESOURCES_JSON);
  } catch {
    throw new Error('FEISHU_BITABLE_RESOURCES_JSON must be valid JSON');
  }

  return {
    appId: env.FEISHU_BITABLE_APP_ID,
    appSecret: env.FEISHU_BITABLE_APP_SECRET,
    cursorSecret: env.FEISHU_BITABLE_CURSOR_SECRET,
    confirmationSecret: env.FEISHU_BITABLE_CONFIRMATION_SECRET,
    resources,
    baseUrl: env.FEISHU_BITABLE_BASE_URL?.trim() || undefined,
    readEnabled,
    writeEnabled,
  };
}

/**
 * Create the adapter. All credential/token state remains inside this closure.
 *
 * Resource configuration shape:
 * {
 *   "sales.pipeline": {
 *     appToken: "bas...",
 *     tableId: "tbl...",
 *     name: "销售管道",
 *     readers: ["canonical-user-id"],
 *     writers: ["canonical-user-id"],
 *     requiredFields: ["客户"],
 *     highImpactFields: ["成交金额"],
 *     atomicBatchOperations: ["feishu.bitable.record.batch_create"],
 *     views: { active: "vew..." },
 *     filters: { active: { conjunction: "and", conditions: [...] } },
 *     sorts: { recent: [{ field_name: "更新时间", desc: true }] }
 *   }
 * }
 */
export function createFeishuBitableAdapter(options) {
  const {
    appId,
    appSecret,
    resources,
    cursorSecret,
    confirmationSecret,
    fetchImpl = globalThis.fetch,
    baseUrl = 'https://open.feishu.cn/open-apis',
    timeoutMs = 10_000,
    schemaTtlMs = DEFAULT_SCHEMA_TTL_MS,
    cursorTtlMs = DEFAULT_CURSOR_TTL_MS,
    confirmationTtlMs = DEFAULT_CONFIRMATION_TTL_MS,
    maxSchemaPages = 10,
    maxResponseBytes = 256 * 1024,
    readEnabled = false,
    writeEnabled = false,
    now = () => Date.now(),
    randomUUID = () => crypto.randomUUID(),
    authorize: authorizeHook,
    audit = () => {},
    idempotencyStore = createMemoryStore(),
  } = options ?? {};

  requireSecret('appId', appId, 3);
  requireSecret('appSecret', appSecret, 8);
  requireSecret('cursorSecret', cursorSecret, 32);
  requireSecret('confirmationSecret', confirmationSecret, 32);
  if (typeof fetchImpl !== 'function') throw new Error('fetchImpl must be a function');
  if (!isPlainObject(resources) || Object.keys(resources).length === 0) {
    throw new Error('resources must be a non-empty operator whitelist');
  }

  const normalizedResources = normalizeResources(resources);
  if (typeof readEnabled !== 'boolean' || typeof writeEnabled !== 'boolean') {
    throw new Error('readEnabled and writeEnabled must be booleans');
  }
  const operationNames = new Set(
    FEISHU_BITABLE_OPERATION_NAMES.filter((operation) =>
      WRITE_OPERATIONS.has(operation) ? writeEnabled : readEnabled,
    ),
  );
  const schemaCache = new Map();
  const confirmationUses = new Map();

  // Token is intentionally closure-private. It is never returned by describe,
  // authorize, execute, audit, errors or any public inspection method.
  let tenantToken = null;
  let tenantTokenExpiresAt = 0;

  function isOperation(name) {
    return operationNames.has(name);
  }

  function describeOperations() {
    const enabled = new Set();
    for (const resource of normalizedResources.values()) {
      for (const operation of resource.allowedOperations) {
        if (operationNames.has(operation)) enabled.add(operation);
      }
    }
    return OPERATION_DESCRIPTORS.filter((descriptor) => enabled.has(descriptor.name)).map(cloneJson);
  }

  async function authorizeRequest(req) {
    const startedAt = now();
    const operation = String(req?.operation || '');
    let resourceAlias = safeResourceAlias(req?.input?.resource);
    let outcome = 'denied';
    let reason = 'authorization failed';
    try {
      requireEnabledOperation(operation);
      const input = validateOperationInput(operation, req?.input);
      resourceAlias = input.resource;
      const resource = requireAllowedResource(operation, resourceAlias);
      const decision = await decideAuthorization(req, resource, input);
      outcome = decision.allowed ? 'allowed' : 'denied';
      reason = decision.reason;
      return decision;
    } catch (error) {
      const normalized = normalizeError(error);
      reason = normalized.message;
      return {
        allowed: false,
        reason: normalized.message,
        error: gatewayErrorBody(normalized),
      };
    } finally {
      await safeAudit(audit, {
        phase: 'authorize',
        requesterUserId: canonicalUserId(req),
        requesterSource: req?.requesterSource,
        operation,
        resource: resourceAlias,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
        inputHash: safeInputHash(operation, req?.input),
        reasonCode: reasonCode(reason),
      });
    }
  }

  async function executeRequest(req) {
    const startedAt = now();
    const auditId = randomUUID();
    const operation = String(req?.operation || '');
    let resourceAlias = safeResourceAlias(req?.input?.resource);
    let outcome = 'error';
    let confirmationBindingHash;
    let expectedRecordFingerprint;
    let currentRecordFingerprint;
    let fingerprintResult;
    try {
      requireEnabledOperation(operation);
      const input = validateOperationInput(operation, req?.input);
      resourceAlias = input.resource;
      const resource = requireAllowedResource(operation, resourceAlias);
      const decision = await decideAuthorization(req, resource, input);
      if (!decision.allowed) {
        throw new AdapterError('BACKEND_UNAUTHORIZED', decision.reason || 'business authorization denied', {
          status: 403,
        });
      }

      const dryRun = req?.dryRun === true;
      const mutating = WRITE_OPERATIONS.has(operation);
      const idempotencyKey = typeof req?.idempotencyKey === 'string' ? req.idempotencyKey.trim() : '';
      if (operation === 'feishu.bitable.record.create' && resource.machineIngestRequired && !dryRun) {
        verifyMachineIngestIdempotencyKey(idempotencyKey, input, resource);
      }
      let idempotencyBinding;
      if (mutating && !dryRun) {
        if (!idempotencyKey) {
          throw new AdapterError('VALIDATION_FAILED', 'committing writes require idempotencyKey', { status: 422 });
        }
        if (operation === 'feishu.bitable.record.update' || operation === 'feishu.bitable.record.delete') {
          if (!input.confirmation) {
            throw new AdapterError('CONFIRMATION_REQUIRED', 'a bound user confirmation is required', {
              status: 409,
            });
          }
          requireTaggedSha256(input.expectedRecordFingerprint, 'expectedRecordFingerprint');
          expectedRecordFingerprint = input.expectedRecordFingerprint;
        }
        idempotencyBinding = hashJson({
          requesterUserId: canonicalUserId(req),
          operation,
          resource: resourceAlias,
          input: withoutConfirmation(input),
        });
        const prior = await idempotencyStore.get(idempotencyKey);
        if (prior) {
          if (prior.bindingHash !== idempotencyBinding) {
            throw new AdapterError('CONFLICT', 'idempotencyKey is already bound to a different request', {
              status: 409,
            });
          }
          outcome = 'replayed';
          fingerprintResult =
            operation === 'feishu.bitable.record.update' || operation === 'feishu.bitable.record.delete'
              ? 'replayed'
              : undefined;
          return { ...cloneJson(prior.response), replayed: true };
        }
      }

      if (mutating) {
        await validateWriteInput(operation, input, resource);
      }

      if (operation === 'feishu.bitable.record.update') {
        if (dryRun) {
          const preview = await createUpdatePreview(req, input, resource, auditId);
          confirmationBindingHash = preview.bindingHash;
          expectedRecordFingerprint = preview.expectedRecordFingerprint;
          fingerprintResult = 'previewed';
          outcome = 'preview';
          return { ok: true, preview, auditId };
        }

        const confirmationBinding = verifyUpdateConfirmation(
          input.confirmation,
          req,
          input,
          resource,
          confirmationSecret,
          confirmationUses,
          idempotencyKey,
          now(),
        );
        confirmationBindingHash = taggedHashJson(confirmationBinding);
        expectedRecordFingerprint = confirmationBinding.expectedRecordFingerprint;
        const current = await getRecord(input, resource);
        currentRecordFingerprint = computeFeishuBitableRecordFingerprint(current);
        if (currentRecordFingerprint !== expectedRecordFingerprint) {
          fingerprintResult = 'conflict';
          throw new AdapterError('CONFLICT', 'record changed after preview; generate a new preview and confirmation', {
            status: 409,
          });
        }
        fingerprintResult = 'match';
        const result = await updateAndVerify(input, resource, auditId);
        ensureResponseBound(result, maxResponseBytes);
        const response = { ok: true, result, auditId };
        await idempotencyStore.set(idempotencyKey, {
          bindingHash: idempotencyBinding,
          response: cloneJson(response),
        });
        outcome = 'ok';
        return response;
      }

      if (operation === 'feishu.bitable.record.delete') {
        if (dryRun) {
          const preview = await createDeletePreview(req, input, resource, auditId);
          ensureResponseBound(preview, maxResponseBytes);
          confirmationBindingHash = preview.bindingHash;
          expectedRecordFingerprint = preview.expectedRecordFingerprint;
          fingerprintResult = 'previewed';
          outcome = 'preview';
          return { ok: true, preview, auditId };
        }

        const confirmationBinding = verifyDeleteConfirmation(
          input.confirmation,
          req,
          input,
          resource,
          confirmationSecret,
          confirmationUses,
          idempotencyKey,
          now(),
        );
        confirmationBindingHash = taggedHashJson(confirmationBinding);
        expectedRecordFingerprint = confirmationBinding.expectedRecordFingerprint;
        const current = await getRecord(input, resource);
        currentRecordFingerprint = computeFeishuBitableRecordFingerprint(current);
        if (currentRecordFingerprint !== expectedRecordFingerprint) {
          fingerprintResult = 'conflict';
          throw new AdapterError('CONFLICT', 'record changed after preview; generate a new preview and confirmation', {
            status: 409,
          });
        }
        fingerprintResult = 'match';
        const result = await deleteAndVerify(input, resource, auditId);
        ensureResponseBound(result, maxResponseBytes);
        const response = { ok: true, result, auditId };
        await idempotencyStore.set(idempotencyKey, {
          bindingHash: idempotencyBinding,
          response: cloneJson(response),
        });
        outcome = 'ok';
        return response;
      }

      const confirmationBinding = requiredConfirmationBinding(req, operation, input, resource);
      if (confirmationBinding && !dryRun) {
        verifyConfirmation(
          input.confirmation,
          confirmationBinding,
          confirmationSecret,
          confirmationUses,
          idempotencyKey,
          now(),
        );
      }

      if (dryRun) {
        outcome = 'preview';
        return {
          ok: true,
          preview: {
            operation,
            resource: resourceAlias,
            recordCount: inputRecordCount(operation, input),
            obligations: confirmationBinding
              ? [{ type: 'user-confirmation', bindingHash: hashJson(confirmationBinding) }]
              : [],
          },
          auditId,
        };
      }

      const result = await dispatch(operation, input, resource);
      ensureResponseBound(result, maxResponseBytes);
      const response = { ok: true, result, auditId };
      if (mutating) {
        await idempotencyStore.set(idempotencyKey, {
          bindingHash: idempotencyBinding,
          response: cloneJson(response),
        });
      }
      outcome = result?.partial ? 'partial' : 'ok';
      return response;
    } catch (error) {
      const normalized = normalizeError(error);
      outcome = normalized.code;
      return { status: normalized.status, body: gatewayErrorBody(normalized) };
    } finally {
      await safeAudit(audit, {
        phase: 'execute',
        auditId,
        requesterUserId: canonicalUserId(req),
        requesterSource: req?.requesterSource,
        operation,
        resource: resourceAlias,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
        idempotencyKey:
          WRITE_OPERATIONS.has(operation) && typeof req?.idempotencyKey === 'string' ? req.idempotencyKey : undefined,
        inputHash: safeInputHash(operation, req?.input),
        confirmationBindingHash,
        expectedRecordFingerprint,
        currentRecordFingerprint,
        fingerprintResult,
      });
    }
  }

  /**
   * Trusted confirmation service hook. Never expose this as an Agent tool.
   * The service must first collect an explicit user confirmation.
   */
  function issueConfirmation({
    requesterUserId,
    operation,
    resource,
    recordIds,
    highImpactFields = [],
    ttlMs = confirmationTtlMs,
  }) {
    if (!requesterUserId || !isOperation(operation) || !normalizedResources.has(resource)) {
      throw new Error('invalid confirmation binding');
    }
    const payload = {
      v: 1,
      requesterUserId,
      operation,
      resource,
      recordIds: normalizeStringSet(recordIds),
      highImpactFields: normalizeStringSet(highImpactFields),
      exp: now() + Math.min(Math.max(1_000, ttlMs), confirmationTtlMs),
      nonce: randomUUID(),
    };
    return signOpaque(payload, confirmationSecret);
  }

  /**
   * Exchange a Gateway-created opaque preview request for the execution token.
   * Only the Host signing proxy may call this method/endpoint after resolving
   * the actor from the trusted session.
   */
  async function issueConfirmationRequest(req) {
    const startedAt = now();
    const auditId = randomUUID();
    let resourceAlias = null;
    let bindingHash;
    let outcome = 'error';
    try {
      if (req?.requesterSource !== 'session') {
        throw new AdapterError('BACKEND_UNAUTHORIZED', 'confirmation issuance requires a trusted session actor', {
          status: 403,
        });
      }
      const requesterUserId = canonicalUserId(req);
      const agentGroupId = canonicalAgentGroupId(req);
      if (!requesterUserId || !agentGroupId) {
        throw new AdapterError(
          'BACKEND_UNAUTHORIZED',
          'canonical requester.userId and agent.agentGroupId are required',
          { status: 403 },
        );
      }
      requireString(req?.confirmationRequest, 'confirmationRequest', 16_384);

      let envelope;
      try {
        envelope = verifyOpaque(req.confirmationRequest, confirmationSecret);
      } catch {
        throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation request is invalid', { status: 409 });
      }
      let binding;
      let display;
      let confirmationPurpose;
      if (envelope?.purpose === 'bitable-update-preview') {
        binding = validateUpdateConfirmationBinding(envelope.binding, now());
        display = validateUpdateConfirmationDisplay(req?.display);
        confirmationPurpose = 'bitable-update-confirmation';
      } else if (envelope?.purpose === 'bitable-delete-preview') {
        binding = validateDeleteConfirmationBinding(envelope.binding, now());
        display = validateDeleteConfirmationDisplay(req?.display);
        confirmationPurpose = 'bitable-delete-confirmation';
      } else {
        throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation request has an invalid purpose', {
          status: 409,
        });
      }
      if (!isTaggedSha256(envelope?.displayHash) || envelope.displayHash !== taggedHashJson(display)) {
        throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation display does not match the Gateway preview', {
          status: 409,
        });
      }
      resourceAlias = binding.resource;
      bindingHash = taggedHashJson(binding);
      if (binding.requesterUserId !== requesterUserId || binding.agentGroupId !== agentGroupId) {
        throw new AdapterError('BACKEND_UNAUTHORIZED', 'confirmation actor does not match the preview requester', {
          status: 403,
        });
      }

      requireEnabledOperation(binding.operation);
      const resource = requireAllowedResource(binding.operation, binding.resource);
      const decision = await decideAuthorization(
        {
          ...req,
          operation: binding.operation,
        },
        resource,
        { resource: binding.resource, recordId: binding.recordId, fields: {} },
      );
      if (!decision.allowed) {
        throw new AdapterError('BACKEND_UNAUTHORIZED', decision.reason || 'business authorization denied', {
          status: 403,
        });
      }

      const confirmation = signOpaque(
        {
          purpose: confirmationPurpose,
          binding,
        },
        confirmationSecret,
      );
      outcome = 'issued';
      return {
        ok: true,
        confirmation,
        expiresAt: binding.exp,
        bindingHash,
        auditId,
      };
    } catch (error) {
      const normalized = normalizeError(error);
      outcome = normalized.code;
      return { status: normalized.status, body: gatewayErrorBody(normalized) };
    } finally {
      await safeAudit(audit, {
        phase: 'confirmation_issue',
        auditId,
        requesterUserId: canonicalUserId(req),
        requesterSource: req?.requesterSource,
        agentGroupId: canonicalAgentGroupId(req),
        resource: resourceAlias,
        outcome,
        durationMs: Math.max(0, now() - startedAt),
        confirmationBindingHash: bindingHash,
      });
    }
  }

  function requireEnabledOperation(operation) {
    if (!isOperation(operation)) {
      throw new AdapterError('OPERATION_NOT_FOUND', `operation is disabled or unknown: ${operation}`, {
        status: 404,
      });
    }
  }

  async function decideAuthorization(req, resource, input) {
    const operation = String(req?.operation || '');
    const userId = canonicalUserId(req);
    const write = WRITE_OPERATIONS.has(operation);
    if (!userId) return { allowed: false, reason: 'canonical requester.userId is required' };
    if (write && req?.requesterSource !== 'session') {
      return { allowed: false, reason: 'agent-asserted requesters may not perform Bitable writes' };
    }
    const permitted = write ? resource.writers : resource.readers;
    if (!permitted.has('*') && !permitted.has(userId)) {
      return { allowed: false, reason: `requester is not allowed to ${write ? 'write' : 'read'} this resource` };
    }
    if (typeof authorizeHook === 'function') {
      const externalDecision = await authorizeHook({
        requester: cloneJson(req?.requester ?? {}),
        requesterSource: req?.requesterSource,
        operation,
        resource: resource.alias,
        recordIds: recordIdsForOperation(operation, input),
      });
      if (!externalDecision || externalDecision.allowed !== true) {
        return {
          allowed: false,
          reason: externalDecision?.reason || 'operator business policy denied the request',
        };
      }
    }

    if (operation === 'feishu.bitable.record.update' || operation === 'feishu.bitable.record.delete') {
      return {
        allowed: true,
        obligations: [
          {
            type: 'user-confirmation',
            previewRequired: true,
            expiresInMs: confirmationTtlMs,
          },
        ],
      };
    }

    const confirmationBinding = requiredConfirmationBinding(req, operation, input, resource);
    return {
      allowed: true,
      obligations: confirmationBinding
        ? [
            {
              type: 'user-confirmation',
              bindingHash: hashJson(confirmationBinding),
              expiresInMs: confirmationTtlMs,
            },
          ]
        : [],
    };
  }

  function requireAllowedResource(operation, alias) {
    if (!isOperation(operation)) {
      throw new AdapterError('OPERATION_NOT_FOUND', `unknown operation: ${operation}`, { status: 404 });
    }
    const resource = normalizedResources.get(alias);
    if (!resource || !resource.allowedOperations.has(operation)) {
      throw new AdapterError('RESOURCE_NOT_ALLOWED', 'logical resource is not configured for this operation', {
        status: 403,
      });
    }
    if (operationNeedsTable(operation) && !resource.tableId) {
      throw new AdapterError('RESOURCE_NOT_ALLOWED', 'operation requires a table-scoped logical resource', {
        status: 403,
      });
    }
    return resource;
  }

  async function dispatch(operation, input, resource) {
    switch (operation) {
      case 'feishu.bitable.app.get':
        return getApp(resource);
      case 'feishu.bitable.table.list':
        return listTables(input, resource);
      case 'feishu.bitable.field.list':
        return listFields(input, resource);
      case 'feishu.bitable.record.list':
        return listRecords(input, resource);
      case 'feishu.bitable.record.get':
        return getRecord(input, resource);
      case 'feishu.bitable.record.create':
        return createRecord(input, resource);
      case 'feishu.bitable.record.update':
        return updateRecord(input, resource);
      case 'feishu.bitable.record.delete':
        return deleteRecord(input, resource);
      case 'feishu.bitable.record.batch_create':
        return batchCreate(input, resource);
      case 'feishu.bitable.record.batch_update':
        return batchUpdate(input, resource);
      case 'feishu.bitable.record.batch_delete':
        return batchDelete(input, resource);
      default:
        throw new AdapterError('OPERATION_NOT_FOUND', `unknown operation: ${operation}`, { status: 404 });
    }
  }

  async function getApp(resource) {
    const payload = await feishuRequest(`/bitable/v1/apps/${encodeURIComponent(resource.appToken)}`);
    const app = payload?.data?.app ?? payload?.data ?? {};
    return {
      resource: resource.alias,
      name: resource.name || stringOr(app.name, resource.alias),
      revision: optionalString(app.revision),
    };
  }

  async function listTables(input, resource) {
    const cursor = decodePageCursor(input.cursor, 'table', resource.alias, {}, cursorSecret, now());
    const payload = await feishuRequest(`/bitable/v1/apps/${encodeURIComponent(resource.appToken)}/tables`, {
      query: { page_size: boundedPageSize(input.pageSize), page_token: cursor?.pageToken },
    });
    const configuredByTableId = new Map(
      [...normalizedResources.values()]
        .filter((entry) => entry.appToken === resource.appToken && entry.tableId)
        .map((entry) => [entry.tableId, entry]),
    );
    const providerItems = arrayOr(payload?.data?.items, payload?.data?.tables);
    const items = providerItems
      .map((table) => {
        const configured = configuredByTableId.get(table?.table_id);
        if (!configured) return null;
        return {
          resource: configured.alias,
          name: configured.name || stringOr(table?.name, configured.alias),
          revision: optionalString(table?.revision),
        };
      })
      .filter(Boolean);
    return pageResult(items, payload?.data, 'table', resource.alias, {}, cursorSecret, cursorTtlMs, now());
  }

  async function listFields(input, resource) {
    const cursor = decodePageCursor(input.cursor, 'field', resource.alias, {}, cursorSecret, now());
    const payload = await feishuRequest(tablePath(resource, '/fields'), {
      query: { page_size: boundedPageSize(input.pageSize), page_token: cursor?.pageToken },
    });
    const items = arrayOr(payload?.data?.items, payload?.data?.fields).map((field) => normalizeField(field, resource));
    return pageResult(items, payload?.data, 'field', resource.alias, {}, cursorSecret, cursorTtlMs, now());
  }

  async function listRecords(input, resource) {
    const queryBinding = {
      resource: resource.alias,
      viewAlias: input.viewAlias ?? null,
      filterAlias: input.filterAlias ?? null,
      sortAlias: input.sortAlias ?? null,
      fields: input.fields ?? null,
      query: input.query ?? null,
      orderBy: input.orderBy ?? null,
    };
    const cursor = decodePageCursor(input.cursor, 'record', resource.alias, queryBinding, cursorSecret, now());
    const body = {};
    if (input.viewAlias) body.view_id = policyAlias(resource.views, input.viewAlias, 'viewAlias');
    if (input.filterAlias) body.filter = policyAlias(resource.filters, input.filterAlias, 'filterAlias');
    if (input.sortAlias) body.sort = policyAlias(resource.sorts, input.sortAlias, 'sortAlias');
    let schema;
    if (input.fields || input.query || input.orderBy) {
      schema = await getFieldSchema(resource);
    }
    if (input.query) {
      body.filter = compileStructuredQuery(input.query, schema);
      if (JSON.stringify(body.filter).length > MAX_FILTER_JSON_CHARS) {
        throw new AdapterError('VALIDATION_FAILED', 'structured query exceeds the provider filter bound', {
          status: 422,
        });
      }
    }
    if (input.orderBy) {
      body.sort = compileStructuredOrder(input.orderBy, schema);
      if (JSON.stringify(body.sort).length > MAX_SORT_JSON_CHARS) {
        throw new AdapterError('VALIDATION_FAILED', 'structured order exceeds the provider sort bound', {
          status: 422,
        });
      }
    }
    if (input.fields) {
      for (const name of input.fields) {
        if (!schema.byName.has(name)) {
          throw new AdapterError('VALIDATION_FAILED', `unknown requested field: ${name}`, { status: 422 });
        }
      }
      body.field_names = input.fields;
    }
    const pageSize = boundedPageSize(input.pageSize);
    const payload = await feishuRequest(tablePath(resource, '/records/search'), {
      method: 'POST',
      query: { page_size: pageSize, page_token: cursor?.pageToken },
      body,
    });
    let items = arrayOr(payload?.data?.items, payload?.data?.records).map(normalizeRecord);
    if (items.length > pageSize) {
      throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu returned more records than the requested page bound', {
        status: 502,
        retryable: true,
      });
    }
    if (input.fields) {
      items = items.map((record) => projectRecordFields(record, input.fields));
    }
    return pageResult(items, payload?.data, 'record', resource.alias, queryBinding, cursorSecret, cursorTtlMs, now());
  }

  async function getRecord(input, resource) {
    const payload = await feishuRequest(tablePath(resource, `/records/${encodeURIComponent(input.recordId)}`));
    return normalizeRecord(payload?.data?.record ?? payload?.data);
  }

  async function createRecord(input, resource) {
    const payload = await feishuRequest(tablePath(resource, '/records'), {
      method: 'POST',
      body: { fields: input.fields },
    });
    return normalizeRecord(payload?.data?.record ?? payload?.data);
  }

  async function updateRecord(input, resource) {
    const payload = await feishuRequest(tablePath(resource, `/records/${encodeURIComponent(input.recordId)}`), {
      method: 'PUT',
      body: { fields: input.fields },
    });
    return normalizeRecord(payload?.data?.record ?? payload?.data);
  }

  async function createUpdatePreview(req, input, resource, auditId) {
    const requesterUserId = canonicalUserId(req);
    const agentGroupId = canonicalAgentGroupId(req);
    if (req?.requesterSource !== 'session' || !requesterUserId || !agentGroupId) {
      throw new AdapterError(
        'BACKEND_UNAUTHORIZED',
        'Update preview requires a trusted canonical user and Agent Group',
        { status: 403 },
      );
    }

    const current = await getRecord(input, resource);
    const expectedRecordFingerprint = computeFeishuBitableRecordFingerprint(current);
    const diff = Object.keys(input.fields)
      .sort()
      .filter((field) => stableStringify(current.fields[field]) !== stableStringify(input.fields[field]))
      .map((field) => ({
        field,
        before: Object.prototype.hasOwnProperty.call(current.fields, field) ? cloneJson(current.fields[field]) : null,
        after: cloneJson(input.fields[field]),
        highImpact: resource.highImpactFields.has(field),
      }));
    if (diff.length === 0) {
      throw new AdapterError('VALIDATION_FAILED', 'Update patch does not change any field', { status: 422 });
    }

    const binding = {
      v: 2,
      requesterUserId,
      agentGroupId,
      operation: 'feishu.bitable.record.update',
      resource: resource.alias,
      recordId: input.recordId,
      patchHash: taggedHashJson(input.fields),
      expectedRecordFingerprint,
      exp: now() + confirmationTtlMs,
      nonce: randomUUID(),
    };
    const bindingHash = taggedHashJson(binding);
    const display = {
      recordId: input.recordId,
      diff,
      expectedRecordFingerprint,
      expiresAt: binding.exp,
      highImpactFields: diff.filter((item) => item.highImpact).map((item) => item.field),
    };
    return {
      ...display,
      bindingHash,
      confirmationRequest: signOpaque(
        {
          purpose: 'bitable-update-preview',
          binding,
          displayHash: taggedHashJson(display),
        },
        confirmationSecret,
      ),
      auditId,
    };
  }

  async function updateAndVerify(input, resource, updateAuditId) {
    await updateRecord(input, resource);
    const getAuditId = randomUUID();
    const verified = await getRecord(input, resource);
    const mismatchedFields = Object.entries(input.fields)
      .filter(([field, value]) => stableStringify(verified.fields[field]) !== stableStringify(value))
      .map(([field]) => field);
    await safeAudit(audit, {
      phase: 'update_verify_get',
      auditId: getAuditId,
      parentAuditId: updateAuditId,
      operation: 'feishu.bitable.record.get',
      resource: resource.alias,
      recordIdHash: taggedHashJson(input.recordId),
      expectedPatchHash: taggedHashJson(input.fields),
      outcome: mismatchedFields.length === 0 ? 'verified' : 'mismatch',
    });
    if (mismatchedFields.length > 0) {
      throw new AdapterError('BACKEND_UNAVAILABLE', 'Update verification did not match the committed patch', {
        status: 502,
        retryable: true,
      });
    }
    return {
      ...verified,
      verification: {
        verified: true,
        updateAuditId,
        getAuditId,
      },
    };
  }

  async function createDeletePreview(req, input, resource, auditId) {
    const requesterUserId = canonicalUserId(req);
    const agentGroupId = canonicalAgentGroupId(req);
    if (req?.requesterSource !== 'session' || !requesterUserId || !agentGroupId) {
      throw new AdapterError(
        'BACKEND_UNAUTHORIZED',
        'Delete preview requires a trusted canonical user and Agent Group',
        { status: 403 },
      );
    }

    const current = await getRecord(input, resource);
    if (Object.keys(current.fields).length > 200) {
      throw new AdapterError('BACKEND_UNAVAILABLE', 'Delete preview exceeds the safe field bound', {
        status: 502,
      });
    }
    const expectedRecordFingerprint = computeFeishuBitableRecordFingerprint(current);
    const binding = {
      v: 2,
      requesterUserId,
      agentGroupId,
      operation: 'feishu.bitable.record.delete',
      resource: resource.alias,
      recordId: input.recordId,
      expectedRecordFingerprint,
      exp: now() + confirmationTtlMs,
      nonce: randomUUID(),
    };
    const bindingHash = taggedHashJson(binding);
    const display = {
      recordId: input.recordId,
      fields: cloneJson(current.fields),
      expectedRecordFingerprint,
      expiresAt: binding.exp,
    };
    return {
      ...display,
      bindingHash,
      confirmationRequest: signOpaque(
        {
          purpose: 'bitable-delete-preview',
          binding,
          displayHash: taggedHashJson(display),
        },
        confirmationSecret,
      ),
      auditId,
    };
  }

  async function deleteAndVerify(input, resource, deleteAuditId) {
    await deleteRecord(input, resource);
    const getAuditId = randomUUID();
    let outcome = 'present';
    try {
      await getRecord(input, resource);
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === 'NOT_FOUND') {
        outcome = 'not_found';
        await safeAudit(audit, {
          phase: 'delete_verify_get',
          auditId: getAuditId,
          parentAuditId: deleteAuditId,
          operation: 'feishu.bitable.record.get',
          resource: resource.alias,
          recordIdHash: taggedHashJson(input.recordId),
          outcome,
        });
        return {
          recordId: input.recordId,
          deleted: true,
          verification: {
            verified: true,
            deleteAuditId,
            getAuditId,
          },
        };
      }
      outcome = normalized.code;
      await safeAudit(audit, {
        phase: 'delete_verify_get',
        auditId: getAuditId,
        parentAuditId: deleteAuditId,
        operation: 'feishu.bitable.record.get',
        resource: resource.alias,
        recordIdHash: taggedHashJson(input.recordId),
        outcome,
      });
      throw normalized;
    }
    await safeAudit(audit, {
      phase: 'delete_verify_get',
      auditId: getAuditId,
      parentAuditId: deleteAuditId,
      operation: 'feishu.bitable.record.get',
      resource: resource.alias,
      recordIdHash: taggedHashJson(input.recordId),
      outcome,
    });
    throw new AdapterError('BACKEND_UNAVAILABLE', 'Delete verification found the record still present', {
      status: 502,
      retryable: true,
    });
  }

  async function deleteRecord(input, resource) {
    await feishuRequest(tablePath(resource, `/records/${encodeURIComponent(input.recordId)}`), {
      method: 'DELETE',
    });
    return { recordId: input.recordId, deleted: true };
  }

  async function batchCreate(input, resource) {
    if (input.mode === 'atomic') {
      requireAtomicBatchSupport(resource, 'feishu.bitable.record.batch_create');
      const payload = await feishuRequest(tablePath(resource, '/records/batch_create'), {
        method: 'POST',
        body: { records: input.records.map((entry) => ({ fields: entry.fields })) },
      });
      const records = arrayOr(payload?.data?.records, payload?.data?.items).map(normalizeRecord);
      if (records.length !== input.records.length) {
        throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu returned a misaligned atomic batch result', {
          status: 502,
          retryable: true,
        });
      }
      return batchSuccess(
        'atomic',
        records.map((record, index) => ({ index, ok: true, record })),
      );
    }
    return bestEffortBatch(
      input.records,
      async (entry) => {
        await validateFieldsWithRefresh(entry.fields, resource, true);
        return createRecord({ resource: input.resource, fields: entry.fields }, resource);
      },
      (record, index) => ({ index, ok: true, record }),
    );
  }

  async function batchUpdate(input, resource) {
    if (input.mode === 'atomic') {
      requireAtomicBatchSupport(resource, 'feishu.bitable.record.batch_update');
      const payload = await feishuRequest(tablePath(resource, '/records/batch_update'), {
        method: 'POST',
        body: {
          records: input.records.map((entry) => ({ record_id: entry.recordId, fields: entry.fields })),
        },
      });
      const records = arrayOr(payload?.data?.records, payload?.data?.items).map(normalizeRecord);
      if (records.length !== input.records.length) {
        throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu returned a misaligned atomic batch result', {
          status: 502,
          retryable: true,
        });
      }
      return batchSuccess(
        'atomic',
        records.map((record, index) => ({ index, ok: true, record })),
      );
    }
    return bestEffortBatch(
      input.records,
      async (entry) => {
        await validateFieldsWithRefresh(entry.fields, resource, false);
        return updateRecord({ resource: input.resource, recordId: entry.recordId, fields: entry.fields }, resource);
      },
      (record, index) => ({ index, ok: true, record }),
    );
  }

  async function batchDelete(input, resource) {
    if (input.mode === 'atomic') {
      requireAtomicBatchSupport(resource, 'feishu.bitable.record.batch_delete');
      await feishuRequest(tablePath(resource, '/records/batch_delete'), {
        method: 'POST',
        body: { records: input.recordIds },
      });
      return batchSuccess(
        'atomic',
        input.recordIds.map((recordId, index) => ({ index, ok: true, recordId })),
      );
    }
    return bestEffortBatch(
      input.recordIds,
      async (recordId) => deleteRecord({ resource: input.resource, recordId }, resource),
      (result, index) => ({ index, ok: true, recordId: result.recordId }),
    );
  }

  async function bestEffortBatch(entries, run, successItem) {
    const results = [];
    for (let index = 0; index < entries.length; index += 1) {
      try {
        const result = await run(entries[index]);
        results.push(successItem(result, index));
      } catch (error) {
        results.push({ index, ok: false, error: gatewayErrorBody(normalizeError(error)) });
      }
    }
    const anySuccess = results.some((item) => item.ok);
    const anyFailure = results.some((item) => !item.ok);
    return {
      mode: 'best-effort',
      ok: !anyFailure,
      partial: anySuccess && anyFailure,
      results,
    };
  }

  async function validateWriteInput(operation, input, resource) {
    if (operation === 'feishu.bitable.record.create') {
      await validateFieldsWithRefresh(input.fields, resource, true);
      return;
    }
    if (operation === 'feishu.bitable.record.update') {
      await validateFieldsWithRefresh(input.fields, resource, false);
      return;
    }
    if (operation === 'feishu.bitable.record.batch_create') {
      if (input.mode === 'atomic') {
        for (const entry of input.records) await validateFieldsWithRefresh(entry.fields, resource, true);
      }
      return;
    }
    if (operation === 'feishu.bitable.record.batch_update') {
      if (input.mode === 'atomic') {
        for (const entry of input.records) await validateFieldsWithRefresh(entry.fields, resource, false);
      }
    }
  }

  async function validateFieldsWithRefresh(fields, resource, creating) {
    let schema = await getFieldSchema(resource);
    try {
      validateFields(fields, schema, creating);
    } catch (firstError) {
      // A newly-added/changed field may not be in the TTL cache. Refresh once
      // before rejecting; no write has reached Feishu yet, so this retry cannot
      // duplicate a commit.
      schemaCache.delete(resource.alias);
      schema = await getFieldSchema(resource, true);
      try {
        validateFields(fields, schema, creating);
      } catch {
        throw firstError;
      }
    }
  }

  async function getFieldSchema(resource, force = false) {
    const cached = schemaCache.get(resource.alias);
    if (!force && cached && cached.expiresAt > now()) return cached.schema;

    const fields = [];
    let pageToken;
    for (let page = 0; page < maxSchemaPages; page += 1) {
      const payload = await feishuRequest(tablePath(resource, '/fields'), {
        query: { page_size: MAX_PAGE_SIZE, page_token: pageToken },
      });
      fields.push(...arrayOr(payload?.data?.items, payload?.data?.fields));
      if (!payload?.data?.has_more || !payload?.data?.page_token) {
        const normalized = fields.map((field) => normalizeField(field, resource));
        const schema = { fields: normalized, byName: new Map(normalized.map((field) => [field.name, field])) };
        for (const required of resource.requiredFields) {
          if (!schema.byName.has(required)) {
            throw new AdapterError('BACKEND_UNAVAILABLE', 'configured required field is absent from Feishu schema', {
              status: 502,
            });
          }
        }
        schemaCache.set(resource.alias, { schema, expiresAt: now() + schemaTtlMs });
        return schema;
      }
      pageToken = payload.data.page_token;
    }
    throw new AdapterError('BACKEND_UNAVAILABLE', 'field schema pagination exceeded configured bound', {
      status: 502,
    });
  }

  async function getTenantToken() {
    if (tenantToken && tenantTokenExpiresAt > now() + 60_000) return tenantToken;
    const payload = await rawFetch('/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      body: { app_id: appId, app_secret: appSecret },
      withAuthorization: false,
    });
    const token = payload?.tenant_access_token;
    const expireSeconds = Number(payload?.expire);
    if (typeof token !== 'string' || !token || !Number.isFinite(expireSeconds)) {
      throw new AdapterError('UPSTREAM_AUTHENTICATION_FAILED', 'Feishu token response was invalid', {
        status: 502,
      });
    }
    tenantToken = token;
    tenantTokenExpiresAt = now() + Math.max(0, expireSeconds) * 1000;
    return tenantToken;
  }

  async function feishuRequest(path, request = {}) {
    const token = await getTenantToken();
    try {
      return await rawFetch(path, { ...request, token, withAuthorization: true });
    } catch (error) {
      const normalized = normalizeError(error);
      if (normalized.code === 'UPSTREAM_AUTHENTICATION_FAILED') {
        tenantToken = null;
        tenantTokenExpiresAt = 0;
      }
      throw normalized;
    }
  }

  async function rawFetch(path, { method = 'GET', query, body, token, withAuthorization }) {
    const url = new URL(`${baseUrl.replace(/\/+$/, '')}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      const headers = { accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json; charset=utf-8';
      if (withAuthorization) headers.authorization = `Bearer ${token}`;
      response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted || error?.name === 'AbortError') {
        throw new AdapterError('TIMEOUT', 'Feishu request timed out', { status: 504, retryable: true });
      }
      throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu request failed', {
        status: 503,
        retryable: true,
      });
    } finally {
      clearTimeout(timer);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu returned a non-JSON response', {
        status: 502,
        retryable: response.status >= 500,
      });
    }
    const providerCode = Number(payload?.code);
    if (!response.ok || (Number.isFinite(providerCode) && providerCode !== 0)) {
      throw mapFeishuError(response.status, providerCode, response.headers);
    }
    return payload;
  }

  return Object.freeze({
    isOperation,
    describeOperations,
    authorize: authorizeRequest,
    execute: executeRequest,
    issueConfirmation,
    issueConfirmationRequest,
  });
}

function createMemoryStore() {
  const values = new Map();
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

function parseOptInFlag(name, value) {
  if (value === undefined || String(value).trim() === '') return false;
  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean (true/false, 1/0, yes/no, on/off)`);
}

function normalizeResources(resources) {
  const normalized = new Map();
  for (const [alias, value] of Object.entries(resources)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(alias) || !isPlainObject(value)) {
      throw new Error(`invalid logical resource alias: ${alias}`);
    }
    requireSecret(`resources.${alias}.appToken`, value.appToken, 3);
    const tableId = typeof value.tableId === 'string' && value.tableId.trim() ? value.tableId.trim() : null;
    const allowedOperations = new Set(
      Array.isArray(value.allowedOperations)
        ? value.allowedOperations
        : FEISHU_BITABLE_OPERATION_NAMES.filter((operation) =>
            tableId ? operation !== 'feishu.bitable.table.list' : !operationNeedsTable(operation),
          ),
    );
    for (const operation of allowedOperations) {
      if (!FEISHU_BITABLE_OPERATION_NAMES.includes(operation)) {
        throw new Error(`resource ${alias} enables unknown operation: ${operation}`);
      }
    }
    const atomicBatchOperations = new Set(normalizeStringSet(value.atomicBatchOperations));
    for (const operation of atomicBatchOperations) {
      if (!operation.includes('.record.batch_') || !allowedOperations.has(operation)) {
        throw new Error(`resource ${alias} has invalid atomic batch operation: ${operation}`);
      }
    }
    if (value.machineIngestRequired !== undefined && typeof value.machineIngestRequired !== 'boolean') {
      throw new Error(`resources.${alias}.machineIngestRequired must be a boolean`);
    }
    if (value.machineIngestRequired !== true && value.machineIngestHmacKey !== undefined) {
      throw new Error(`resources.${alias}.machineIngestHmacKey requires machineIngestRequired=true`);
    }
    normalized.set(alias, {
      alias,
      appToken: value.appToken.trim(),
      tableId,
      name: typeof value.name === 'string' ? value.name : alias,
      readers: new Set(normalizeAccessList(value.readers)),
      writers: new Set(normalizeAccessList(value.writers)),
      requiredFields: new Set(normalizeStringSet(value.requiredFields)),
      highImpactFields: new Set(normalizeStringSet(value.highImpactFields)),
      views: normalizeAliasMap(value.views),
      filters: normalizeAliasMap(value.filters),
      sorts: normalizeAliasMap(value.sorts),
      atomicBatchOperations,
      allowedOperations,
      machineIngestRequired: value.machineIngestRequired === true,
      machineIngestHmacKey:
        value.machineIngestRequired === true
          ? (requireSecret(`resources.${alias}.machineIngestHmacKey`, value.machineIngestHmacKey, 32),
            value.machineIngestHmacKey.trim())
          : null,
    });
  }
  return normalized;
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function verifyMachineIngestIdempotencyKey(idempotencyKey, input, resource) {
  const match = /^voice-photo-json-v1:([a-f0-9]{64}):([a-f0-9]{64})$/.exec(idempotencyKey);
  if (!match) {
    throw new AdapterError(
      'MACHINE_INGEST_PROOF_REQUIRED',
      'this logical resource requires a valid machine-ingest proof for record creation',
      { status: 403 },
    );
  }
  const [, digest, suppliedSignature] = match;
  const payload = canonicalJson({
    version: 'voice-photo-json.v1',
    digest,
    resource: resource.alias,
    fields: input.fields,
  });
  const expected = crypto.createHmac('sha256', resource.machineIngestHmacKey).update(payload).digest();
  const supplied = Buffer.from(suppliedSignature, 'hex');
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    throw new AdapterError(
      'MACHINE_INGEST_PROOF_INVALID',
      'machine-ingest proof does not match the requested resource and fields',
      { status: 403 },
    );
  }
}

function validateOperationInput(operation, rawInput) {
  if (!FEISHU_BITABLE_OPERATION_NAMES.includes(operation)) {
    throw new AdapterError('OPERATION_NOT_FOUND', `unknown operation: ${operation}`, { status: 404 });
  }
  if (!isPlainObject(rawInput)) {
    throw new AdapterError('VALIDATION_FAILED', 'input must be an object', { status: 422 });
  }
  const allowedKeys = allowedInputKeys(operation);
  for (const key of Object.keys(rawInput)) {
    if (!allowedKeys.has(key)) {
      throw new AdapterError('VALIDATION_FAILED', `unexpected input field: ${key}`, { status: 422 });
    }
  }
  const input = cloneJson(rawInput);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.resource ?? '')) {
    throw new AdapterError('VALIDATION_FAILED', 'resource must be a logical alias', { status: 422 });
  }
  if (operation.endsWith('.list')) {
    if (input.pageSize !== undefined && !isIntegerBetween(input.pageSize, 1, MAX_PAGE_SIZE)) {
      throw new AdapterError('VALIDATION_FAILED', `pageSize must be between 1 and ${MAX_PAGE_SIZE}`, {
        status: 422,
      });
    }
    if (input.cursor !== undefined) requireString(input.cursor, 'cursor', 4096);
  }
  if (operation === 'feishu.bitable.record.list') {
    for (const key of ['viewAlias', 'filterAlias', 'sortAlias']) {
      if (input[key] !== undefined) requireString(input[key], key, 128);
    }
    if (input.fields !== undefined) {
      requireArray(input.fields, 'fields', 0, 200);
      input.fields.forEach((name) => requireString(name, 'fields[]', 256));
    }
    if ((input.filterAlias !== undefined || input.sortAlias !== undefined) && (input.query || input.orderBy)) {
      throw new AdapterError(
        'VALIDATION_FAILED',
        'filterAlias/sortAlias cannot be combined with structured query/orderBy',
        { status: 422 },
      );
    }
    if (input.query !== undefined) validateStructuredQueryShape(input.query);
    if (input.orderBy !== undefined) validateStructuredOrderShape(input.orderBy);
  }
  if (operation.includes('.record.') && !operation.endsWith('.list')) {
    validateRecordOperationInput(operation, input);
  }
  return input;
}

function validateRecordOperationInput(operation, input) {
  if (
    ['feishu.bitable.record.get', 'feishu.bitable.record.update', 'feishu.bitable.record.delete'].includes(operation)
  ) {
    requireString(input.recordId, 'recordId', 128);
  }
  if (['feishu.bitable.record.create', 'feishu.bitable.record.update'].includes(operation)) {
    requireFields(input.fields);
  }
  if (
    (operation === 'feishu.bitable.record.update' || operation === 'feishu.bitable.record.delete') &&
    input.expectedRecordFingerprint !== undefined
  ) {
    requireTaggedSha256(input.expectedRecordFingerprint, 'expectedRecordFingerprint');
  }
  if (operation.includes('.batch_')) {
    if (!['atomic', 'best-effort'].includes(input.mode)) {
      throw new AdapterError('VALIDATION_FAILED', 'batch mode must be atomic or best-effort', { status: 422 });
    }
    if (operation === 'feishu.bitable.record.batch_delete') {
      requireArray(input.recordIds, 'recordIds', 1, MAX_BATCH_RECORDS);
      input.recordIds.forEach((recordId) => requireString(recordId, 'recordIds[]', 128));
    } else {
      requireArray(input.records, 'records', 1, MAX_BATCH_RECORDS);
      input.records.forEach((record, index) => {
        if (!isPlainObject(record)) {
          throw new AdapterError('VALIDATION_FAILED', `records[${index}] must be an object`, { status: 422 });
        }
        const keys = operation.endsWith('batch_create') ? new Set(['fields']) : new Set(['recordId', 'fields']);
        for (const key of Object.keys(record)) {
          if (!keys.has(key)) {
            throw new AdapterError('VALIDATION_FAILED', `unexpected records[${index}] field: ${key}`, {
              status: 422,
            });
          }
        }
        if (!operation.endsWith('batch_create')) requireString(record.recordId, `records[${index}].recordId`, 128);
        requireFields(record.fields, `records[${index}].fields`);
      });
    }
  }
  if (input.confirmation !== undefined) requireString(input.confirmation, 'confirmation', 4096);
}

function validateFields(fields, schema, creating) {
  for (const [name, value] of Object.entries(fields)) {
    const field = schema.byName.get(name);
    if (!field) throw new AdapterError('VALIDATION_FAILED', `unknown field: ${name}`, { status: 422 });
    if (!field.writable) {
      throw new AdapterError('VALIDATION_FAILED', `field is read-only: ${name}`, { status: 422 });
    }
    if (!valueMatchesField(value, field)) {
      throw new AdapterError('VALIDATION_FAILED', `invalid value type for field: ${name}`, { status: 422 });
    }
    if (field.options && field.options.length > 0) {
      const selected = Array.isArray(value) ? value : [value];
      if (selected.some((entry) => typeof entry === 'string' && !field.options.includes(entry))) {
        throw new AdapterError('VALIDATION_FAILED', `field has an unknown option: ${name}`, { status: 422 });
      }
    }
  }
  if (creating) {
    for (const field of schema.fields) {
      if (
        field.required &&
        (fields[field.name] === undefined || fields[field.name] === null || fields[field.name] === '')
      ) {
        throw new AdapterError('VALIDATION_FAILED', `required field is missing: ${field.name}`, { status: 422 });
      }
    }
  }
}

function validateStructuredQueryShape(query) {
  if (!isPlainObject(query)) {
    throw new AdapterError('VALIDATION_FAILED', 'query must be an object', { status: 422 });
  }
  for (const key of Object.keys(query)) {
    if (!['conjunction', 'conditions'].includes(key)) {
      throw new AdapterError('VALIDATION_FAILED', `unexpected query field: ${key}`, { status: 422 });
    }
  }
  if (!['and', 'or'].includes(query.conjunction)) {
    throw new AdapterError('VALIDATION_FAILED', 'query.conjunction must be and or or', { status: 422 });
  }
  requireArray(query.conditions, 'query.conditions', 1, MAX_QUERY_CONDITIONS);
  query.conditions.forEach((condition, index) => {
    if (!isPlainObject(condition)) {
      throw new AdapterError('VALIDATION_FAILED', `query.conditions[${index}] must be an object`, { status: 422 });
    }
    for (const key of Object.keys(condition)) {
      if (!['field', 'operator', 'value'].includes(key)) {
        throw new AdapterError('VALIDATION_FAILED', `unexpected query.conditions[${index}] field: ${key}`, {
          status: 422,
        });
      }
    }
    requireString(condition.field, `query.conditions[${index}].field`, 256);
    if (!STRUCTURED_QUERY_OPERATORS.has(condition.operator)) {
      throw new AdapterError('VALIDATION_FAILED', `unsupported query operator: ${condition.operator}`, {
        status: 422,
      });
    }
    const emptyOperator = condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty';
    const hasValue = Object.prototype.hasOwnProperty.call(condition, 'value') && condition.value !== undefined;
    if (emptyOperator === hasValue) {
      throw new AdapterError(
        'VALIDATION_FAILED',
        emptyOperator
          ? `query.conditions[${index}].value must be omitted for ${condition.operator}`
          : `query.conditions[${index}].value is required for ${condition.operator}`,
        { status: 422 },
      );
    }
  });
}

function validateStructuredOrderShape(orderBy) {
  requireArray(orderBy, 'orderBy', 1, MAX_ORDER_BY);
  orderBy.forEach((item, index) => {
    if (!isPlainObject(item)) {
      throw new AdapterError('VALIDATION_FAILED', `orderBy[${index}] must be an object`, { status: 422 });
    }
    for (const key of Object.keys(item)) {
      if (!['field', 'direction'].includes(key)) {
        throw new AdapterError('VALIDATION_FAILED', `unexpected orderBy[${index}] field: ${key}`, { status: 422 });
      }
    }
    requireString(item.field, `orderBy[${index}].field`, 256);
    if (!['asc', 'desc'].includes(item.direction)) {
      throw new AdapterError('VALIDATION_FAILED', `orderBy[${index}].direction must be asc or desc`, {
        status: 422,
      });
    }
  });
}

function normalizeField(field, resource) {
  const typeNumber = Number(field?.type);
  const name = String(field?.field_name ?? field?.name ?? '');
  if (!name) {
    throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu returned a field without a name', { status: 502 });
  }
  const options = Array.isArray(field?.property?.options)
    ? field.property.options.map((option) => String(option?.name ?? '')).filter(Boolean)
    : undefined;
  return {
    name,
    type: fieldTypeName(typeNumber, field?.ui_type),
    typeNumber,
    required: resource.requiredFields.has(name),
    writable: !COMPUTED_FIELD_TYPES.has(typeNumber),
    multiple:
      typeNumber === 4 ||
      typeNumber === 11 ||
      typeNumber === 17 ||
      typeNumber === 18 ||
      typeNumber === 21 ||
      field?.property?.multiple === true,
    options,
  };
}

function valueMatchesField(value, field) {
  if (value === null) return true;
  switch (field.typeNumber) {
    case 1:
    case 13:
      return typeof value === 'string' || Array.isArray(value);
    case 2:
      return typeof value === 'number' && Number.isFinite(value);
    case 3:
    case 24:
      return typeof value === 'string';
    case 4:
      return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
    case 5:
      return typeof value === 'number' || typeof value === 'string';
    case 7:
      return typeof value === 'boolean';
    case 11:
    case 17:
    case 18:
    case 21:
    case 23:
      return Array.isArray(value);
    case 15:
    case 22:
      return typeof value === 'string' || isPlainObject(value);
    default:
      return isJsonValue(value);
  }
}

function requiredConfirmationBinding(req, operation, input, resource) {
  // Single-record Update/Delete use the v2 Preview → Host issue → commit flow.
  // Keep the legacy v1 binding only for unopened batch policies.
  if (operation === 'feishu.bitable.record.update' || operation === 'feishu.bitable.record.delete') {
    return null;
  }
  let highImpactFields = [];
  if (operation === 'feishu.bitable.record.batch_update') {
    highImpactFields = [
      ...new Set(
        input.records
          .flatMap((entry) => Object.keys(entry.fields))
          .filter((field) => resource.highImpactFields.has(field)),
      ),
    ];
  }
  if (!DELETE_OPERATIONS.has(operation) && highImpactFields.length === 0) return null;
  return {
    v: 1,
    requesterUserId: canonicalUserId(req),
    operation,
    resource: resource.alias,
    recordIds: recordIdsForOperation(operation, input),
    highImpactFields: normalizeStringSet(highImpactFields),
  };
}

function verifyConfirmation(token, expectedBinding, secret, uses, idempotencyKey, currentTime) {
  if (typeof token !== 'string' || !token) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'a bound user confirmation is required', { status: 409 });
  }
  let payload;
  try {
    payload = verifyOpaque(token, secret);
  } catch {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation is invalid', { status: 409 });
  }
  if (!payload || payload.v !== 1 || !Number.isFinite(payload.exp) || payload.exp <= currentTime) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation has expired', { status: 409 });
  }
  const actualBinding = {
    v: payload.v,
    requesterUserId: payload.requesterUserId,
    operation: payload.operation,
    resource: payload.resource,
    recordIds: normalizeStringSet(payload.recordIds),
    highImpactFields: normalizeStringSet(payload.highImpactFields),
  };
  if (hashJson(actualBinding) !== hashJson(expectedBinding)) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation does not match this operation', { status: 409 });
  }
  const priorKey = uses.get(payload.nonce);
  if (priorKey && priorKey !== idempotencyKey) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation was already used by another request', {
      status: 409,
    });
  }
  uses.set(payload.nonce, idempotencyKey);
}

function validateUpdateConfirmationBinding(binding, currentTime) {
  if (
    !isPlainObject(binding) ||
    binding.v !== 2 ||
    binding.operation !== 'feishu.bitable.record.update' ||
    !canonicalBindingString(binding.requesterUserId) ||
    !canonicalBindingString(binding.agentGroupId) ||
    !safeResourceAlias(binding.resource) ||
    !canonicalBindingString(binding.recordId) ||
    !isTaggedSha256(binding.patchHash) ||
    !isTaggedSha256(binding.expectedRecordFingerprint) ||
    !Number.isSafeInteger(binding.exp) ||
    binding.exp <= currentTime ||
    !canonicalBindingString(binding.nonce)
  ) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation has expired or contains an invalid binding', {
      status: 409,
    });
  }
  const allowedKeys = new Set([
    'v',
    'requesterUserId',
    'agentGroupId',
    'operation',
    'resource',
    'recordId',
    'patchHash',
    'expectedRecordFingerprint',
    'exp',
    'nonce',
  ]);
  if (Object.keys(binding).some((key) => !allowedKeys.has(key))) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation contains an invalid binding', { status: 409 });
  }
  return cloneJson(binding);
}

function validateUpdateConfirmationDisplay(display) {
  if (!isPlainObject(display)) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation display is invalid', { status: 409 });
  }
  const allowedKeys = new Set(['recordId', 'diff', 'expectedRecordFingerprint', 'expiresAt', 'highImpactFields']);
  if (
    Object.keys(display).some((key) => !allowedKeys.has(key)) ||
    !canonicalBindingString(display.recordId) ||
    !isTaggedSha256(display.expectedRecordFingerprint) ||
    !Number.isSafeInteger(display.expiresAt) ||
    !Array.isArray(display.diff) ||
    display.diff.length < 1 ||
    display.diff.length > 200 ||
    !Array.isArray(display.highImpactFields) ||
    display.highImpactFields.some((field) => !canonicalBindingString(field))
  ) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation display is invalid', { status: 409 });
  }
  for (const item of display.diff) {
    if (
      !isPlainObject(item) ||
      Object.keys(item).some((key) => !['field', 'before', 'after', 'highImpact'].includes(key)) ||
      !canonicalBindingString(item.field) ||
      typeof item.highImpact !== 'boolean' ||
      !Object.prototype.hasOwnProperty.call(item, 'before') ||
      !Object.prototype.hasOwnProperty.call(item, 'after')
    ) {
      throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation display is invalid', { status: 409 });
    }
  }
  return cloneJson(display);
}

function validateDeleteConfirmationBinding(binding, currentTime) {
  if (
    !isPlainObject(binding) ||
    binding.v !== 2 ||
    binding.operation !== 'feishu.bitable.record.delete' ||
    !canonicalBindingString(binding.requesterUserId) ||
    !canonicalBindingString(binding.agentGroupId) ||
    !safeResourceAlias(binding.resource) ||
    !canonicalBindingString(binding.recordId) ||
    !isTaggedSha256(binding.expectedRecordFingerprint) ||
    !Number.isSafeInteger(binding.exp) ||
    binding.exp <= currentTime ||
    !canonicalBindingString(binding.nonce)
  ) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation has expired or contains an invalid binding', {
      status: 409,
    });
  }
  const allowedKeys = new Set([
    'v',
    'requesterUserId',
    'agentGroupId',
    'operation',
    'resource',
    'recordId',
    'expectedRecordFingerprint',
    'exp',
    'nonce',
  ]);
  if (Object.keys(binding).some((key) => !allowedKeys.has(key))) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation contains an invalid binding', { status: 409 });
  }
  return cloneJson(binding);
}

function validateDeleteConfirmationDisplay(display) {
  if (!isPlainObject(display)) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation display is invalid', { status: 409 });
  }
  const allowedKeys = new Set(['recordId', 'fields', 'expectedRecordFingerprint', 'expiresAt']);
  if (
    Object.keys(display).some((key) => !allowedKeys.has(key)) ||
    !canonicalBindingString(display.recordId) ||
    !isPlainObject(display.fields) ||
    Object.keys(display.fields).length > 200 ||
    !Object.values(display.fields).every(isJsonValue) ||
    !isTaggedSha256(display.expectedRecordFingerprint) ||
    !Number.isSafeInteger(display.expiresAt)
  ) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation display is invalid', { status: 409 });
  }
  return cloneJson(display);
}

function verifyUpdateConfirmation(token, req, input, resource, secret, uses, idempotencyKey, currentTime) {
  if (typeof token !== 'string' || !token) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'a bound user confirmation is required', { status: 409 });
  }
  let envelope;
  try {
    envelope = verifyOpaque(token, secret);
  } catch {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation is invalid', { status: 409 });
  }
  if (envelope?.purpose !== 'bitable-update-confirmation') {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation has an invalid purpose', { status: 409 });
  }
  const binding = validateUpdateConfirmationBinding(envelope.binding, currentTime);
  const expected = {
    requesterUserId: canonicalUserId(req),
    agentGroupId: canonicalAgentGroupId(req),
    operation: 'feishu.bitable.record.update',
    resource: resource.alias,
    recordId: input.recordId,
    patchHash: taggedHashJson(input.fields),
    expectedRecordFingerprint: input.expectedRecordFingerprint,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!value || binding[key] !== value) {
      throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation does not match this Update', { status: 409 });
    }
  }
  const priorKey = uses.get(binding.nonce);
  if (priorKey && priorKey !== idempotencyKey) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation was already used by another request', {
      status: 409,
    });
  }
  uses.set(binding.nonce, idempotencyKey);
  return binding;
}

function verifyDeleteConfirmation(token, req, input, resource, secret, uses, idempotencyKey, currentTime) {
  if (typeof token !== 'string' || !token) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'a bound user confirmation is required', { status: 409 });
  }
  let envelope;
  try {
    envelope = verifyOpaque(token, secret);
  } catch {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation is invalid', { status: 409 });
  }
  if (envelope?.purpose !== 'bitable-delete-confirmation') {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation has an invalid purpose', { status: 409 });
  }
  const binding = validateDeleteConfirmationBinding(envelope.binding, currentTime);
  const expected = {
    requesterUserId: canonicalUserId(req),
    agentGroupId: canonicalAgentGroupId(req),
    operation: 'feishu.bitable.record.delete',
    resource: resource.alias,
    recordId: input.recordId,
    expectedRecordFingerprint: input.expectedRecordFingerprint,
  };
  for (const [key, value] of Object.entries(expected)) {
    if (!value || binding[key] !== value) {
      throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation does not match this Delete', { status: 409 });
    }
  }
  const priorKey = uses.get(binding.nonce);
  if (priorKey && priorKey !== idempotencyKey) {
    throw new AdapterError('CONFIRMATION_REQUIRED', 'confirmation was already used by another request', {
      status: 409,
    });
  }
  uses.set(binding.nonce, idempotencyKey);
  return binding;
}

function pageResult(items, data, kind, resource, queryBinding, secret, ttlMs, currentTime) {
  const hasMore = data?.has_more === true && typeof data?.page_token === 'string' && data.page_token.length > 0;
  return {
    items,
    hasMore,
    nextCursor: hasMore
      ? signOpaque(
          {
            v: 1,
            kind,
            resource,
            queryHash: hashJson(queryBinding),
            pageToken: data.page_token,
            exp: currentTime + ttlMs,
          },
          secret,
        )
      : null,
  };
}

function compileStructuredQuery(query, schema) {
  return {
    conjunction: query.conjunction,
    conditions: query.conditions.map((condition) => compileStructuredCondition(condition, schema)),
  };
}

function compileStructuredCondition(condition, schema) {
  const field = schema.byName.get(condition.field);
  if (!field) {
    throw new AdapterError('VALIDATION_FAILED', `unknown query field: ${condition.field}`, { status: 422 });
  }
  const allowed = queryOperatorsForField(field);
  if (!allowed.has(condition.operator)) {
    throw new AdapterError(
      'VALIDATION_FAILED',
      `query operator ${condition.operator} is not supported for field type ${field.type}: ${field.name}`,
      { status: 422 },
    );
  }

  if (condition.operator === 'isEmpty' || condition.operator === 'isNotEmpty') {
    return {
      field_name: field.name,
      operator: condition.operator,
      value: [],
    };
  }

  validateStructuredConditionValue(condition.value, field);
  let providerOperator = {
    eq: 'is',
    ne: 'isNot',
    contains: 'contains',
    notContains: 'doesNotContain',
    gt: 'isGreater',
    gte: 'isGreaterEqual',
    lt: 'isLess',
    lte: 'isLessEqual',
  }[condition.operator];
  let value = condition.value;
  if (isDateField(field)) {
    // Feishu's structured filter supports strict date comparisons but not
    // inclusive ones. Millisecond values let the Gateway preserve inclusive
    // semantics without falling back to a provider formula string.
    if (condition.operator === 'gte') {
      providerOperator = 'isGreater';
      value -= 1;
    } else if (condition.operator === 'lte') {
      providerOperator = 'isLess';
      value += 1;
    }
    return {
      field_name: field.name,
      operator: providerOperator,
      value: ['ExactDate', String(value)],
    };
  }
  return {
    field_name: field.name,
    operator: providerOperator,
    value: [String(value)],
  };
}

function compileStructuredOrder(orderBy, schema) {
  return orderBy.map((item) => {
    if (!schema.byName.has(item.field)) {
      throw new AdapterError('VALIDATION_FAILED', `unknown order field: ${item.field}`, { status: 422 });
    }
    return { field_name: item.field, desc: item.direction === 'desc' };
  });
}

function queryOperatorsForField(field) {
  const empty = ['isEmpty', 'isNotEmpty'];
  if ([1, 13, 15].includes(field.typeNumber)) {
    return new Set(['eq', 'ne', 'contains', 'notContains', ...empty]);
  }
  if (field.typeNumber === 2) {
    return new Set(['eq', 'ne', 'gt', 'gte', 'lt', 'lte', ...empty]);
  }
  if ([3, 24].includes(field.typeNumber)) {
    return new Set(['eq', 'ne', ...empty]);
  }
  if (field.typeNumber === 4) {
    return new Set(['eq', 'ne', 'contains', 'notContains', ...empty]);
  }
  if (isDateField(field)) {
    return new Set(['eq', 'gt', 'gte', 'lt', 'lte', ...empty]);
  }
  if (field.typeNumber === 7) {
    return new Set(['eq', 'ne', ...empty]);
  }
  return new Set();
}

function validateStructuredConditionValue(value, field) {
  if ([1, 3, 4, 13, 15, 24].includes(field.typeNumber)) {
    requireString(value, `query value for ${field.name}`, 1_000);
    if (field.options?.length > 0 && !field.options.includes(value)) {
      throw new AdapterError('VALIDATION_FAILED', `query field has an unknown option: ${field.name}`, {
        status: 422,
      });
    }
    return;
  }
  if (field.typeNumber === 2) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new AdapterError('VALIDATION_FAILED', `query value must be a finite number: ${field.name}`, {
        status: 422,
      });
    }
    return;
  }
  if (isDateField(field)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AdapterError(
        'VALIDATION_FAILED',
        `query date value must be a positive Unix millisecond integer: ${field.name}`,
        { status: 422 },
      );
    }
    return;
  }
  if (field.typeNumber === 7) {
    if (typeof value !== 'boolean') {
      throw new AdapterError('VALIDATION_FAILED', `query value must be boolean: ${field.name}`, { status: 422 });
    }
    return;
  }
  throw new AdapterError('VALIDATION_FAILED', `field type is not queryable: ${field.name}`, { status: 422 });
}

function isDateField(field) {
  return [5, 1001, 1002].includes(field.typeNumber);
}

function decodePageCursor(cursor, kind, resource, queryBinding, secret, currentTime) {
  if (!cursor) return null;
  let payload;
  try {
    payload = verifyOpaque(cursor, secret);
  } catch {
    throw new AdapterError('VALIDATION_FAILED', 'cursor is invalid', { status: 422 });
  }
  if (
    payload?.v !== 1 ||
    payload.kind !== kind ||
    payload.resource !== resource ||
    payload.queryHash !== hashJson(queryBinding) ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= currentTime ||
    typeof payload.pageToken !== 'string'
  ) {
    throw new AdapterError('VALIDATION_FAILED', 'cursor does not match this query or has expired', { status: 422 });
  }
  return payload;
}

function mapFeishuError(httpStatus, providerCode, headers) {
  const retryAfterMs = boundedRetryAfter(headers);
  if (providerCode === 1254290 || httpStatus === 429) {
    return new AdapterError('RATE_LIMITED', 'Feishu rate limit exceeded', {
      status: 429,
      retryable: true,
      retryAfterMs,
    });
  }
  if (providerCode === 1254291 || httpStatus === 409) {
    return new AdapterError('CONFLICT', 'Feishu rejected a conflicting write', {
      status: 409,
      retryable: true,
      retryAfterMs: retryAfterMs ?? 500,
    });
  }
  if (providerCode === 1255040 || httpStatus === 504) {
    return new AdapterError('TIMEOUT', 'Feishu request timed out', { status: 504, retryable: true });
  }
  if ([99991661, 99991663, 99991664, 99991668].includes(providerCode) || httpStatus === 401) {
    return new AdapterError('UPSTREAM_AUTHENTICATION_FAILED', 'Feishu application authentication failed', {
      status: 502,
    });
  }
  if ([1254301, 1254302].includes(providerCode) || httpStatus === 403) {
    return new AdapterError('BACKEND_UNAUTHORIZED', 'Feishu application lacks permission for this resource', {
      status: 403,
    });
  }
  if ([1254040, 1254041, 1254042, 1254043, 1254044].includes(providerCode) || httpStatus === 404) {
    return new AdapterError('NOT_FOUND', 'Feishu resource or record was not found', { status: 404 });
  }
  if ((providerCode >= 1254000 && providerCode < 1254200) || [400, 422].includes(httpStatus)) {
    return new AdapterError('VALIDATION_FAILED', 'Feishu rejected the request data', { status: 422 });
  }
  if (httpStatus >= 500 || (providerCode >= 1255000 && providerCode < 1256000)) {
    return new AdapterError('BACKEND_UNAVAILABLE', 'Feishu service is unavailable', {
      status: 503,
      retryable: true,
    });
  }
  return new AdapterError('UNKNOWN', 'Feishu returned an unclassified error', { status: 502 });
}

function boundedRetryAfter(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(250, Math.round(seconds * 1000)));
}

function normalizeError(error) {
  if (error instanceof AdapterError) return error;
  return new AdapterError('BACKEND_UNAVAILABLE', 'Bitable Gateway operation failed', {
    status: 500,
    retryable: false,
  });
}

function gatewayErrorBody(error) {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(Number.isFinite(error.retryAfterMs) ? { retryAfterMs: error.retryAfterMs } : {}),
  };
}

function statusForCode(code) {
  if (code === 'BACKEND_UNAUTHORIZED' || code === 'RESOURCE_NOT_ALLOWED') return 403;
  if (code === 'OPERATION_NOT_FOUND' || code === 'NOT_FOUND') return 404;
  if (code === 'CONFLICT' || code === 'CONFIRMATION_REQUIRED') return 409;
  if (code === 'RATE_LIMITED') return 429;
  if (code === 'VALIDATION_FAILED') return 422;
  if (code === 'TIMEOUT') return 504;
  return 502;
}

function operationNeedsTable(operation) {
  return operation !== 'feishu.bitable.app.get' && operation !== 'feishu.bitable.table.list';
}

function tablePath(resource, suffix) {
  return `/bitable/v1/apps/${encodeURIComponent(resource.appToken)}/tables/${encodeURIComponent(resource.tableId)}${suffix}`;
}

function normalizeRecord(record) {
  const recordId = String(record?.record_id ?? record?.recordId ?? '');
  if (!recordId) {
    throw new AdapterError('BACKEND_UNAVAILABLE', 'Feishu returned a record without an id', {
      status: 502,
      retryable: true,
    });
  }
  return {
    recordId,
    fields: isPlainObject(record?.fields) ? cloneJson(record.fields) : {},
    revision: optionalString(record?.revision),
    createdAt: optionalTimestamp(record?.created_time),
    updatedAt: optionalTimestamp(record?.last_modified_time),
  };
}

function projectRecordFields(record, fieldNames) {
  const allowed = new Set(fieldNames);
  return {
    ...record,
    fields: Object.fromEntries(Object.entries(record.fields).filter(([name]) => allowed.has(name))),
  };
}

function fieldTypeName(type, uiType) {
  const known = {
    1: 'text',
    2: 'number',
    3: 'single-select',
    4: 'multi-select',
    5: 'date',
    7: 'boolean',
    11: 'user',
    13: 'phone',
    15: 'url',
    17: 'attachment',
    18: 'relation',
    19: 'lookup',
    20: 'formula',
    21: 'relation',
    22: 'location',
    23: 'group',
    24: 'stage',
    1001: 'created-time',
    1002: 'modified-time',
    1003: 'created-user',
    1004: 'modified-user',
    1005: 'auto-number',
    3001: 'button',
  };
  return typeof uiType === 'string' && uiType ? uiType : (known[type] ?? `unknown-${type}`);
}

function policyAlias(mapping, alias, fieldName) {
  if (!Object.prototype.hasOwnProperty.call(mapping, alias)) {
    throw new AdapterError('RESOURCE_NOT_ALLOWED', `${fieldName} is not allowed for this resource`, { status: 403 });
  }
  return cloneJson(mapping[alias]);
}

function batchSuccess(mode, results) {
  return { mode, ok: true, partial: false, results };
}

function requireAtomicBatchSupport(resource, operation) {
  if (!resource.atomicBatchOperations.has(operation)) {
    throw new AdapterError(
      'VALIDATION_FAILED',
      'atomic mode is not enabled for this resource; use best-effort or configure a verified atomic provider path',
      { status: 422 },
    );
  }
}

function recordIdsForOperation(operation, input) {
  if (operation === 'feishu.bitable.record.delete' || operation === 'feishu.bitable.record.update') {
    return [input.recordId];
  }
  if (operation === 'feishu.bitable.record.batch_delete') return normalizeStringSet(input.recordIds);
  if (operation === 'feishu.bitable.record.batch_update') {
    return normalizeStringSet(input.records.map((entry) => entry.recordId));
  }
  return [];
}

function inputRecordCount(operation, input) {
  if (operation === 'feishu.bitable.record.batch_delete') return input.recordIds.length;
  if (operation.endsWith('.batch_create') || operation.endsWith('.batch_update')) return input.records.length;
  return operation.includes('.record.') ? 1 : 0;
}

function allowedInputKeys(operation) {
  const common = ['resource'];
  if (operation === 'feishu.bitable.app.get') return new Set(common);
  if (operation === 'feishu.bitable.table.list' || operation === 'feishu.bitable.field.list') {
    return new Set([...common, 'pageSize', 'cursor']);
  }
  if (operation === 'feishu.bitable.record.list') {
    return new Set([
      ...common,
      'pageSize',
      'cursor',
      'viewAlias',
      'filterAlias',
      'sortAlias',
      'fields',
      'query',
      'orderBy',
    ]);
  }
  if (operation === 'feishu.bitable.record.get') return new Set([...common, 'recordId']);
  if (operation === 'feishu.bitable.record.create') return new Set([...common, 'fields']);
  if (operation === 'feishu.bitable.record.update') {
    return new Set([...common, 'recordId', 'fields', 'expectedRecordFingerprint', 'confirmation']);
  }
  if (operation === 'feishu.bitable.record.delete') {
    return new Set([...common, 'recordId', 'expectedRecordFingerprint', 'confirmation']);
  }
  if (operation === 'feishu.bitable.record.batch_create') return new Set([...common, 'mode', 'records']);
  if (operation === 'feishu.bitable.record.batch_update') {
    return new Set([...common, 'mode', 'records', 'confirmation']);
  }
  return new Set([...common, 'mode', 'recordIds', 'confirmation']);
}

function requiredFieldsForOperation(operation) {
  if (operation === 'feishu.bitable.app.get') return ['resource'];
  if (operation.endsWith('.list')) return ['resource'];
  if (operation === 'feishu.bitable.record.get' || operation === 'feishu.bitable.record.delete') {
    return ['resource', 'recordId'];
  }
  if (operation === 'feishu.bitable.record.create') return ['resource', 'fields'];
  if (operation === 'feishu.bitable.record.update') return ['resource', 'recordId', 'fields'];
  if (operation === 'feishu.bitable.record.batch_delete') return ['resource', 'mode', 'recordIds'];
  return ['resource', 'mode', 'records'];
}

function descriptorInputSchema(operation) {
  const required = requiredFieldsForOperation(operation);
  const properties = { resource: { type: 'string', description: 'operator-configured logical alias' } };
  for (const field of allowedInputKeys(operation)) {
    if (field === 'resource') continue;
    properties[field] =
      field === 'query'
        ? {
            type: 'object',
            additionalProperties: false,
            properties: {
              conjunction: { type: 'string', enum: ['and', 'or'] },
              conditions: {
                type: 'array',
                minItems: 1,
                maxItems: MAX_QUERY_CONDITIONS,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    field: { type: 'string' },
                    operator: { type: 'string', enum: [...STRUCTURED_QUERY_OPERATORS] },
                    value: {},
                  },
                  required: ['field', 'operator'],
                },
              },
            },
            required: ['conjunction', 'conditions'],
          }
        : field === 'orderBy'
          ? {
              type: 'array',
              minItems: 1,
              maxItems: MAX_ORDER_BY,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  field: { type: 'string' },
                  direction: { type: 'string', enum: ['asc', 'desc'] },
                },
                required: ['field', 'direction'],
              },
            }
          : field === 'pageSize'
            ? { type: 'integer', minimum: 1, maximum: MAX_PAGE_SIZE }
            : field === 'mode'
              ? { type: 'string', enum: ['atomic', 'best-effort'] }
              : field === 'records' || field === 'recordIds' || field === 'fields'
                ? { type: field === 'fields' ? 'object' : 'array' }
                : { type: 'string' };
  }
  return { type: 'object', additionalProperties: false, properties, required };
}

function operationSummary(operation) {
  const summaries = {
    'feishu.bitable.app.get': 'Read approved Bitable app metadata',
    'feishu.bitable.table.list': 'List approved logical tables',
    'feishu.bitable.field.list': 'Discover the current table field schema',
    'feishu.bitable.record.list': 'List records using bounded, schema-validated structured filters',
    'feishu.bitable.record.get': 'Read one record',
    'feishu.bitable.record.create': 'Create one validated record',
    'feishu.bitable.record.update': 'Preview or update one record with bound user confirmation',
    'feishu.bitable.record.delete': 'Delete one explicitly confirmed record',
    'feishu.bitable.record.batch_create': 'Create a bounded record batch',
    'feishu.bitable.record.batch_update': 'Update a bounded record batch',
    'feishu.bitable.record.batch_delete': 'Delete a bounded confirmed record batch',
  };
  return summaries[operation];
}

function signOpaque(payload, secret) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyOpaque(token, secret) {
  const [encoded, signature, extra] = String(token).split('.');
  if (!encoded || !signature || extra !== undefined) throw new Error('bad opaque token');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('bad opaque token signature');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
}

function hashJson(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function taggedHashJson(value) {
  return `sha256:${hashJson(value)}`;
}

export function computeFeishuBitableRecordFingerprint(record) {
  if (!isPlainObject(record) || !canonicalBindingString(record.recordId) || !isPlainObject(record.fields)) {
    throw new AdapterError('BACKEND_UNAVAILABLE', 'cannot fingerprint an invalid Feishu record', {
      status: 502,
      retryable: true,
    });
  }
  return taggedHashJson({
    recordId: record.recordId,
    fields: record.fields,
    revision: record.revision ?? null,
    updatedAt: record.updatedAt ?? null,
  });
}

function safeInputHash(operation, input) {
  try {
    return hashJson({ operation, input: withoutConfirmation(input) });
  } catch {
    return hashJson({ operation, input: '<unhashable>' });
  }
}

function withoutConfirmation(input) {
  if (!isPlainObject(input)) return input;
  const clone = { ...input };
  delete clone.confirmation;
  return clone;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function safeAudit(audit, event) {
  try {
    await audit(event);
  } catch {
    // Observability is read-only and must never change authorization/execution.
  }
}

function ensureResponseBound(result, maxBytes) {
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > maxBytes) {
    throw new AdapterError(
      'VALIDATION_FAILED',
      'response exceeds the configured Agent context bound; request a smaller page or field set',
      { status: 422 },
    );
  }
}

function boundedPageSize(value) {
  return value === undefined ? DEFAULT_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, Math.max(1, value));
}

function requireSecret(name, value, minLength) {
  if (typeof value !== 'string' || value.trim().length < minLength) {
    throw new Error(`${name} must be a non-empty secret/configuration value`);
  }
}

function requireString(value, name, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw new AdapterError('VALIDATION_FAILED', `${name} must be a non-empty string`, { status: 422 });
  }
}

function requireTaggedSha256(value, name) {
  if (!isTaggedSha256(value)) {
    throw new AdapterError('VALIDATION_FAILED', `${name} must be a tagged SHA-256 fingerprint`, { status: 422 });
  }
}

function isTaggedSha256(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalBindingString(value) {
  return typeof value === 'string' && value.trim() && value === value.trim() && value.length <= 256 ? value : null;
}

function requireFields(value, name = 'fields') {
  if (!isPlainObject(value) || Object.keys(value).length === 0) {
    throw new AdapterError('VALIDATION_FAILED', `${name} must be a non-empty object`, { status: 422 });
  }
}

function requireArray(value, name, min, max) {
  if (!Array.isArray(value) || value.length < min || value.length > max) {
    throw new AdapterError('VALIDATION_FAILED', `${name} must contain ${min}-${max} items`, { status: 422 });
  }
}

function normalizeAccessList(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  return value.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim());
}

function normalizeStringSet(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((entry) => typeof entry === 'string' && entry).map(String))].sort();
}

function normalizeAliasMap(value) {
  return isPlainObject(value) ? cloneJson(value) : {};
}

function canonicalUserId(req) {
  return typeof req?.requester?.userId === 'string' && req.requester.userId.trim() ? req.requester.userId.trim() : null;
}

function canonicalAgentGroupId(req) {
  return typeof req?.agent?.agentGroupId === 'string' && req.agent.agentGroupId.trim()
    ? req.agent.agentGroupId.trim()
    : null;
}

function safeResourceAlias(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isJsonValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return true;
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isPlainObject(value) && Object.values(value).every(isJsonValue);
}

function isIntegerBetween(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function arrayOr(...values) {
  return values.find(Array.isArray) ?? [];
}

function optionalString(value) {
  return typeof value === 'string' && value ? value : undefined;
}

function optionalTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  return optionalString(value);
}

function stringOr(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function reasonCode(reason) {
  return crypto
    .createHash('sha256')
    .update(String(reason || ''))
    .digest('hex')
    .slice(0, 12);
}
