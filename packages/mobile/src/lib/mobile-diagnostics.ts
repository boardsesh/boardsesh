import type { FeedbackDiagnosticsInput } from '@boardsesh/shared-schema';

export type DiagnosticFlow = 'ble' | 'auth' | 'data' | 'render' | 'navigation';
export type DiagnosticOutcome = 'success' | 'failure' | 'cancelled' | 'superseded';
export type DiagnosticAttributes = Record<string, string | number | boolean | null | undefined>;

export type DiagnosticOperationSnapshot = {
  id: string;
  parentId?: string;
  flow: DiagnosticFlow;
  name: string;
  phase: string;
  startedAt: number;
  updatedAt: number;
  durationMs: number;
  outcome?: DiagnosticOutcome;
  attributes: DiagnosticAttributes;
};

export type DiagnosticBreadcrumb = {
  category: string;
  message: string;
  timestamp: number;
  data: DiagnosticAttributes;
};

export type DiagnosticSnapshot = {
  schemaVersion: 1;
  launch: FeedbackDiagnosticsInput;
  active: DiagnosticOperationSnapshot[];
  completed: Partial<Record<DiagnosticFlow, DiagnosticOperationSnapshot>>;
  breadcrumbs: DiagnosticBreadcrumb[];
  overflowCount: number;
};

export type DiagnosticOperation = {
  id: string;
  step: (phase: string, attributes?: DiagnosticAttributes) => void;
  finish: (outcome: DiagnosticOutcome, attributes?: DiagnosticAttributes) => void;
};

export type DiagnosticSink = (snapshot: DiagnosticSnapshot, breadcrumb?: DiagnosticBreadcrumb) => void;

// Explicit scalar fields only: a caller cannot accidentally ship credentials,
// query variables, renderer JSON, peripheral addresses or raw BLE packets.
const ATTRIBUTE_KEYS = new Set([
  'operationId',
  'parentId',
  'flow',
  'phase',
  'outcome',
  'durationMs',
  'source',
  'boardName',
  'layoutId',
  'sizeId',
  'angle',
  'climbUuid',
  'sessionId',
  'route',
  'appState',
  'operationName',
  'status',
  'attempt',
  'retryCount',
  'errorCode',
  'failureCategory',
  'androidErrorCode',
  'iosErrorCode',
  'bleErrorCode',
  'permission',
  'adapter',
  'scanFamily',
  'devicesFound',
  'targeted',
  'mtu',
  'chunkSize',
  'chunkCount',
  'byteCount',
  'writeType',
  'supportsWriteWithResponse',
  'supportsWriteWithoutResponse',
  'characteristicProperties',
  'maxWriteWithResponse',
  'maxWriteWithoutResponse',
  'discoveredServiceCount',
  'cacheHit',
  'renderMode',
  'foreground',
  'queued',
  'completedCount',
  'failedCount',
  'table',
  'rowCount',
  'pendingCount',
  'downloadScope',
  'generation',
  'degraded',
  'updateId',
  'branch',
  'runtimeVersion',
  'isEmbeddedLaunch',
  'testRunId',
  'kind',
]);
const FLOWS: DiagnosticFlow[] = ['ble', 'auth', 'data', 'render', 'navigation'];
export const DIAGNOSTIC_LIMITS = { breadcrumbs: 100, active: 16, contextBytes: 32 * 1024 } as const;

function sanitizeAttributes(attributes: DiagnosticAttributes = {}): DiagnosticAttributes {
  const sanitized: DiagnosticAttributes = {};
  for (const [key, attribute] of Object.entries(attributes)) {
    if (!ATTRIBUTE_KEYS.has(key) || attribute === undefined || Object.keys(sanitized).length >= 12) continue;
    if (typeof attribute === 'string') sanitized[key] = attribute.slice(0, 128);
    else if (typeof attribute === 'number' && Number.isFinite(attribute)) sanitized[key] = attribute;
    else if (typeof attribute === 'boolean' || attribute === null) sanitized[key] = attribute;
  }
  return sanitized;
}

const LAUNCH_STRING_KEYS = [
  'launchId',
  'previousLaunchId',
  'nativeStartupId',
  'reportId',
  'lastUserOperationId',
  'posthogDistinctId',
  'posthogSessionId',
  'easClientId',
  'otaUpdateId',
  'otaBranch',
  'otaRuntimeVersion',
] as const;
function sanitizeLaunch(fields: Partial<FeedbackDiagnosticsInput>): FeedbackDiagnosticsInput {
  const sanitized: FeedbackDiagnosticsInput = { schemaVersion: 1 };
  for (const key of LAUNCH_STRING_KEYS) {
    const field = fields[key];
    if (typeof field === 'string') sanitized[key] = field.slice(0, 200);
    else if (field === null) sanitized[key] = null;
  }
  for (const key of ['previousLaunchCrashed', 'otaIsEmbedded'] as const) {
    const field = fields[key];
    if (typeof field === 'boolean' || field === null) sanitized[key] = field;
  }
  return sanitized;
}

function utf8Size(input: string): number {
  let bytes = 0;
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

function copyOperation(operation: DiagnosticOperationSnapshot): DiagnosticOperationSnapshot {
  return { ...operation, attributes: { ...operation.attributes } };
}

export function createDiagnosticRecorder(
  options: {
    now?: () => number;
    makeId?: () => string;
    sink?: DiagnosticSink;
  } = {},
) {
  const now = options.now ?? Date.now;
  let sequence = 0;
  const makeId =
    options.makeId ?? (() => `${launch.launchId ?? 'prelaunch'}-${now().toString(36)}-${(++sequence).toString(36)}`);
  let launch: FeedbackDiagnosticsInput = { schemaVersion: 1 };
  let sink = options.sink;
  let identityReader: (() => Partial<FeedbackDiagnosticsInput>) | undefined;
  const active = new Map<string, DiagnosticOperationSnapshot>();
  const completed: Partial<Record<DiagnosticFlow, DiagnosticOperationSnapshot>> = {};
  const latestStartedByFlow: Partial<Record<DiagnosticFlow, string>> = {};
  const breadcrumbs: DiagnosticBreadcrumb[] = [];
  let overflowCount = 0;

  function snapshot(): DiagnosticSnapshot {
    const copiedCompleted: DiagnosticSnapshot['completed'] = {};
    for (const flow of FLOWS) {
      const operation = completed[flow];
      if (operation) copiedCompleted[flow] = copyOperation(operation);
    }
    const result: DiagnosticSnapshot = {
      schemaVersion: 1,
      launch: { ...launch },
      active: [...active.values()].map(copyOperation),
      completed: copiedCompleted,
      breadcrumbs: [],
      overflowCount,
    };
    // Drop oldest timeline entries first, then optional attributes. Keep the
    // operation IDs/phases/outcomes even when callers saturate the buffer.
    if (utf8Size(JSON.stringify(result)) > DIAGNOSTIC_LIMITS.contextBytes) {
      for (const operation of [...result.active, ...Object.values(result.completed)]) operation.attributes = {};
    }
    let remainingBytes = DIAGNOSTIC_LIMITS.contextBytes - utf8Size(JSON.stringify(result));
    for (let index = breadcrumbs.length - 1; index >= 0; index -= 1) {
      const breadcrumb = breadcrumbs[index];
      const bytes = utf8Size(JSON.stringify(breadcrumb)) + 1;
      if (bytes > remainingBytes) break;
      remainingBytes -= bytes;
      result.breadcrumbs.unshift({ ...breadcrumb, data: { ...breadcrumb.data } });
    }
    return result;
  }

  function publish(breadcrumb?: DiagnosticBreadcrumb): void {
    if (!sink) return;
    try {
      sink(snapshot(), breadcrumb);
    } catch {
      /* Diagnostics never changes app behavior. */
    }
  }

  function record(operation: DiagnosticOperationSnapshot): void {
    const breadcrumb: DiagnosticBreadcrumb = {
      category: `diagnostics.${operation.flow}`,
      message: `${operation.name}.${operation.phase}`,
      timestamp: operation.updatedAt / 1000,
      data: {
        ...operation.attributes,
        operationId: operation.id,
        ...(operation.parentId ? { parentId: operation.parentId } : {}),
        phase: operation.phase,
        ...(operation.outcome ? { outcome: operation.outcome } : {}),
        durationMs: operation.durationMs,
      },
    };
    breadcrumbs.push(breadcrumb);
    if (breadcrumbs.length > DIAGNOSTIC_LIMITS.breadcrumbs) breadcrumbs.shift();
    publish(breadcrumb);
  }

  function begin(
    flow: DiagnosticFlow,
    name: string,
    args: {
      parentId?: string;
      userInitiated?: boolean;
      attributes?: DiagnosticAttributes;
    } = {},
  ): DiagnosticOperation {
    const startedAt = now();
    const operation: DiagnosticOperationSnapshot = {
      id: makeId().slice(0, 200),
      parentId: args.parentId?.slice(0, 200),
      flow,
      name: name.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64),
      phase: 'begin',
      startedAt,
      updatedAt: startedAt,
      durationMs: 0,
      attributes: sanitizeAttributes(args.attributes),
    };
    if (active.size >= DIAGNOSTIC_LIMITS.active) {
      // Do not evict live operations: an overflow operation cannot overwrite
      // their final state when its delayed callback eventually settles.
      overflowCount += 1;
      publish();
      return { id: operation.id, step: () => {}, finish: () => {} };
    }
    active.set(operation.id, operation);
    latestStartedByFlow[flow] = operation.id;
    if (args.userInitiated) launch.lastUserOperationId = operation.id;
    record(operation);
    return {
      id: operation.id,
      step(phase, attributes) {
        if (!active.has(operation.id)) return;
        operation.phase = phase.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 64);
        operation.updatedAt = now();
        operation.durationMs = Math.max(0, operation.updatedAt - startedAt);
        operation.attributes = sanitizeAttributes({ ...operation.attributes, ...attributes });
        record(operation);
      },
      finish(outcome, attributes) {
        if (!active.delete(operation.id)) return;
        operation.phase = 'finish';
        operation.outcome = outcome;
        operation.updatedAt = now();
        operation.durationMs = Math.max(0, operation.updatedAt - startedAt);
        operation.attributes = sanitizeAttributes({ ...operation.attributes, ...attributes });
        if (latestStartedByFlow[flow] === operation.id) completed[flow] = copyOperation(operation);
        record(operation);
      },
    };
  }

  return {
    begin,
    snapshot,
    initialize(this: void, fields: FeedbackDiagnosticsInput) {
      launch = sanitizeLaunch(fields);
      publish();
    },
    setSink(this: void, next?: DiagnosticSink) {
      sink = next;
      publish();
    },
    setIdentityReader(this: void, next?: () => Partial<FeedbackDiagnosticsInput>) {
      identityReader = next;
    },
    feedback(this: void): FeedbackDiagnosticsInput {
      let identity: Partial<FeedbackDiagnosticsInput> = {};
      try {
        identity = identityReader?.() ?? {};
      } catch {
        /* Optional SDKs may be unavailable. */
      }
      return sanitizeLaunch({ ...launch, ...identity });
    },
    analyticsFields(this: void): Record<string, string | number | boolean | null> {
      return {
        diagnostic_schema_version: 1,
        launch_id: launch.launchId ?? null,
        native_startup_id: launch.nativeStartupId ?? null,
        eas_client_id: launch.easClientId ?? null,
        ota_update_id: launch.otaUpdateId ?? null,
        ota_branch: launch.otaBranch ?? null,
        ota_runtime_version: launch.otaRuntimeVersion ?? null,
        ota_is_embedded: launch.otaIsEmbedded ?? null,
      };
    },
    updateLaunch(this: void, fields: Partial<FeedbackDiagnosticsInput>) {
      launch = sanitizeLaunch({ ...launch, ...fields });
      publish();
    },
  };
}

const recorder = createDiagnosticRecorder();
export const beginDiagnosticOperation = recorder.begin;
export const getDiagnosticSnapshot = recorder.snapshot;
export const initializeMobileDiagnostics = recorder.initialize;
export const setDiagnosticSink = recorder.setSink;
export const setDiagnosticIdentityReader = recorder.setIdentityReader;
export const getFeedbackDiagnostics = recorder.feedback;
export const updateDiagnosticLaunch = recorder.updateLaunch;
export const getDiagnosticAnalyticsProperties = recorder.analyticsFields;

export function diagnosticErrorAttributes(error: unknown): DiagnosticAttributes {
  if (typeof error !== 'object' || error === null) return {};
  const codes = error as { androidErrorCode?: unknown; iosErrorCode?: unknown; errorCode?: unknown; code?: unknown };
  const attributes: DiagnosticAttributes = {};
  for (const key of ['androidErrorCode', 'iosErrorCode', 'errorCode'] as const) {
    const code = codes[key];
    if (typeof code === 'number' || typeof code === 'string') attributes[key] = code;
  }
  if (typeof codes.code === 'string' || typeof codes.code === 'number') attributes.errorCode ??= codes.code;
  return attributes;
}

export async function runDiagnosticOperation<T>(
  flow: DiagnosticFlow,
  name: string,
  run: (operation: DiagnosticOperation) => Promise<T>,
  attributes?: DiagnosticAttributes,
): Promise<T> {
  const operation = beginDiagnosticOperation(flow, name, { attributes });
  try {
    const result = await run(operation);
    operation.finish('success');
    return result;
  } catch (error) {
    const cancelled = error instanceof Error && ['AbortError', 'CancelledError'].includes(error.name);
    operation.finish(cancelled ? 'cancelled' : 'failure', diagnosticErrorAttributes(error));
    throw error;
  }
}
