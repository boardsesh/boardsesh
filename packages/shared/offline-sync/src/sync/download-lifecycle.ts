/** Correlation belongs to a request generation, never to whichever request is current at callback time. */
export type ScopeDownloadContext = { requestId: string; attemptId: string; accountGeneration?: number };

export type ScopeDownloadLifecycleEvent = {
  scopeKey: string;
  context: ScopeDownloadContext;
  state: 'started' | 'deferred' | 'paused' | 'completed';
  reason?: string;
  stage?: string;
  completionSource?: 'download' | 'cached';
};

export type ScopeDownloadLifecycleReporter = (event: ScopeDownloadLifecycleEvent) => void;

/** Observational only: neither a broken sink nor absent analytics may affect catalogue writes. */
export function createScopeDownloadLifecycle(
  contexts: ReadonlyMap<string, ScopeDownloadContext>,
  report?: ScopeDownloadLifecycleReporter,
) {
  const active = new Set<string>();
  const settled = new Set<string>();
  const failures = new Map<string, { reason: string; stage?: string }>();
  const emit = (scopeKey: string, event: Omit<ScopeDownloadLifecycleEvent, 'scopeKey' | 'context'>): void => {
    const context = contexts.get(scopeKey);
    if (!context) return;
    try {
      report?.({ ...event, scopeKey, context });
    } catch {
      // Telemetry must never fail a download.
    }
  };
  return {
    start(scopeKey: string) {
      if (active.has(scopeKey) || settled.has(scopeKey)) return;
      active.add(scopeKey);
      emit(scopeKey, { state: 'started' });
    },
    defer(scopeKey: string, reason: string, stage?: string) {
      if (settled.has(scopeKey)) return;
      failures.set(scopeKey, { reason, stage });
      emit(scopeKey, { state: 'deferred', reason, stage });
    },
    deferAll(reason: string) {
      for (const scopeKey of contexts.keys()) {
        if (settled.has(scopeKey)) continue;
        failures.set(scopeKey, { reason, stage: 'preparation' });
        emit(scopeKey, { state: 'deferred', reason, stage: 'preparation' });
      }
    },
    complete(scopeKey: string, completionSource: 'download' | 'cached') {
      if (settled.has(scopeKey)) return;
      settled.add(scopeKey);
      active.delete(scopeKey);
      emit(scopeKey, { state: 'completed', completionSource });
    },
    close(reason: string) {
      // Only work that actually stopped is paused. A background URLSession may
      // continue after an AppState edge; no lifecycle event is sent on that edge.
      for (const scopeKey of contexts.keys()) {
        if (settled.has(scopeKey)) continue;
        const failure = failures.get(scopeKey);
        const paused =
          active.has(scopeKey) &&
          (reason === 'background' || reason === 'offline') &&
          (!failure || failure.reason === 'aborted-background' || failure.reason === 'network');
        emit(scopeKey, {
          state: paused ? 'paused' : 'deferred',
          reason: failure?.reason ?? reason,
          stage: failure?.stage ?? (active.has(scopeKey) ? undefined : 'preparation'),
        });
      }
      active.clear();
    },
  };
}
