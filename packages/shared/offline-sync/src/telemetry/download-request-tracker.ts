/**
 * Durable identities for board-download requests, including requests that never
 * reach the downloader. Platform storage, randomness and analytics are injected.
 *
 * Writes precede reports. A restart keeps the identity, but cannot prove that an
 * analytics SDK delivered a prior report: consent and delivery gaps must remain
 * unknown in the downstream requested → started → completed analysis.
 */
export type DownloadRequestState = 'requested' | 'started' | 'completed' | 'already_available' | 'cancelled';
export type DownloadRequestOutcome = 'completed' | 'already_available' | 'cancelled';

export type DownloadRequestContext = {
  readonly requestId: string;
  readonly batchId: string;
  readonly scopeKey: string;
  readonly trigger: string;
  readonly source: string;
  readonly requestedAt: string;
  readonly requestedScopeCount: number;
  readonly state: DownloadRequestState;
};

/** One current request per scope; retries never append another request. */
export type DownloadRequestLedger = Record<string, DownloadRequestContext>;

export type DownloadRequestEvent = {
  kind: 'requested' | 'started' | 'resolved';
  context: DownloadRequestContext;
};

export type DownloadRequestTrackerOptions = {
  read: () => unknown;
  write: (ledger: DownloadRequestLedger) => void;
  createId: () => string;
  now: () => number;
  report: (event: DownloadRequestEvent) => void;
};

export type DownloadRequestTracker = {
  request: (
    scopes: readonly string[],
    options: { trigger: string; source: string },
  ) => readonly DownloadRequestContext[];
  get: (scopeKey: string) => DownloadRequestContext | undefined;
  started: (scopeKey: string) => DownloadRequestContext | undefined;
  resolve: (scopeKey: string, outcome: DownloadRequestOutcome) => DownloadRequestContext | undefined;
  clear: () => void;
};

const REQUEST_STATES: readonly DownloadRequestState[] = [
  'requested',
  'started',
  'completed',
  'already_available',
  'cancelled',
];

function isNonemptyString(candidate: unknown): candidate is string {
  return typeof candidate === 'string' && candidate.trim().length > 0;
}

function parseContext(candidate: unknown, scopeKey: string): DownloadRequestContext | undefined {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const context = candidate as Record<string, unknown>;
  if (
    !isNonemptyString(scopeKey) ||
    context.scopeKey !== scopeKey ||
    !isNonemptyString(context.requestId) ||
    !isNonemptyString(context.batchId) ||
    !isNonemptyString(context.trigger) ||
    !isNonemptyString(context.source) ||
    typeof context.requestedAt !== 'string' ||
    !Number.isFinite(Date.parse(context.requestedAt)) ||
    new Date(context.requestedAt).toISOString() !== context.requestedAt ||
    typeof context.requestedScopeCount !== 'number' ||
    !Number.isSafeInteger(context.requestedScopeCount) ||
    context.requestedScopeCount < 1 ||
    typeof context.state !== 'string' ||
    !REQUEST_STATES.includes(context.state as DownloadRequestState)
  ) {
    return undefined;
  }
  return {
    requestId: context.requestId,
    batchId: context.batchId,
    scopeKey,
    trigger: context.trigger,
    source: context.source,
    requestedAt: context.requestedAt,
    requestedScopeCount: context.requestedScopeCount,
    state: context.state as DownloadRequestState,
  };
}

/** Ignore malformed entries without trusting newer or corrupt persisted shapes. */
function readLedger(read: () => unknown): DownloadRequestLedger {
  const candidate = read();
  const ledger = Object.create(null) as DownloadRequestLedger;
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) return ledger;
  const entries: [string, DownloadRequestContext][] = [];
  for (const [scopeKey, storedContext] of Object.entries(candidate)) {
    const context = parseContext(storedContext, scopeKey);
    if (context) entries.push([scopeKey, context]);
  }
  return Object.assign(ledger, Object.fromEntries(entries));
}

function isOpen(context: DownloadRequestContext): boolean {
  return context.state === 'requested' || context.state === 'started';
}

export function createDownloadRequestTracker(options: DownloadRequestTrackerOptions): DownloadRequestTracker {
  const report = (event: DownloadRequestEvent): void => {
    try {
      options.report(event);
    } catch {
      // Analytics cannot prevent a board from downloading. Persistence still
      // records the transition; a missing delivered event is not a success.
    }
  };

  return {
    request(scopes, { trigger, source }) {
      const ledger = readLedger(options.read);
      const uniqueScopes = [...new Set(scopes.filter(isNonemptyString))];
      const newScopes = uniqueScopes.filter((scopeKey) => !ledger[scopeKey] || ledger[scopeKey].state === 'cancelled');
      if (newScopes.length > 0) {
        const batchId = options.createId();
        const requestedAt = new Date(options.now()).toISOString();
        const contexts = newScopes.map((scopeKey): DownloadRequestContext => ({
          requestId: options.createId(),
          batchId,
          scopeKey,
          trigger,
          source,
          requestedAt,
          requestedScopeCount: newScopes.length,
          state: 'requested',
        }));
        for (const context of contexts) {
          Object.defineProperty(ledger, context.scopeKey, {
            value: context,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
        // Persist the whole batch before the first report or sync kick, so a
        // reporter that re-enters request() cannot create duplicate identities.
        options.write(ledger);
        for (const context of contexts) report({ kind: 'requested', context });
      }
      return uniqueScopes.map((scopeKey) => ledger[scopeKey]);
    },

    get(scopeKey) {
      return readLedger(options.read)[scopeKey];
    },

    started(scopeKey) {
      const ledger = readLedger(options.read);
      const context = ledger[scopeKey];
      if (!context || context.state !== 'requested') return context;
      const startedContext: DownloadRequestContext = { ...context, state: 'started' };
      options.write({ ...ledger, [scopeKey]: startedContext });
      report({ kind: 'started', context: startedContext });
      return startedContext;
    },

    resolve(scopeKey, outcome) {
      const ledger = readLedger(options.read);
      const context = ledger[scopeKey];
      if (!context || !isOpen(context)) return context;
      const resolvedContext: DownloadRequestContext = { ...context, state: outcome };
      options.write({ ...ledger, [scopeKey]: resolvedContext });
      report({ kind: 'resolved', context: resolvedContext });
      return resolvedContext;
    },

    clear() {
      options.write({});
    },
  };
}
