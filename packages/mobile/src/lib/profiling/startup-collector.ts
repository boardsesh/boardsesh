/** Local attribution only. These JS marks are never host launch timestamps. */
export type StartupMarkName =
  | 'collector.loaded'
  | 'root.module.ready'
  | 'root.commit'
  | 'fonts.start'
  | 'fonts.ready'
  | 'sqlite.initial.start'
  | 'sqlite.initial.gate'
  | 'sqlite.recovery.start'
  | 'sqlite.recovery.end'
  | 'auth.initial.start'
  | 'auth.initial.ready'
  | 'splash.hide.request'
  | 'splash.hide.resolved'
  | 'home.useful.commit';
export type StartupOutcome =
  | 'ready'
  | 'error'
  | 'degraded'
  | 'authenticated'
  | 'anonymous'
  | 'content'
  | 'empty'
  | 'offline';
export type StartupMark = { name: StartupMarkName; timestampMs: number; outcome?: StartupOutcome };

export function createStartupCollector(enabled: boolean, now: () => number) {
  // One entry per fixed phase: retries, navigation, and StrictMode cannot grow it.
  const marks = new Map<StartupMarkName, StartupMark>();
  return {
    mark(name: StartupMarkName, outcome?: StartupOutcome): boolean {
      if (!enabled || marks.has(name)) return false;
      marks.set(name, { name, timestampMs: now(), ...(outcome ? { outcome } : {}) });
      return true;
    },
    snapshot(): StartupMark[] {
      return [...marks.values()].map((mark) => ({ ...mark }));
    },
  };
}

/** Mirrors Home's visible empty-state precedence; skeletons are not useful. */
export function homeEmptyStartupOutcome({
  authenticated,
  blockedReason,
  loading,
  scopeReady,
  error,
}: {
  authenticated: boolean;
  blockedReason: string | null;
  loading: boolean;
  scopeReady: boolean;
  error: boolean;
}): StartupOutcome | null {
  if (!authenticated) return 'empty';
  if (blockedReason) return blockedReason === 'error' ? 'error' : 'offline';
  if (loading || !scopeReady) return null;
  if (error) return 'error';
  return 'empty';
}
