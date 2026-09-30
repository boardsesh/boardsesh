import type { DiagnosticSnapshot } from './mobile-diagnostics';

type AtomicAbortModule = {
  nativeAbortVersion?: number;
  crashNativeAbort?: (testRunId: string, snapshotJson: string) => boolean;
};

export function canRunNativeAbort(enabled: boolean, nativeModule: AtomicAbortModule | null): boolean {
  return (
    enabled && (nativeModule?.nativeAbortVersion ?? 0) >= 2 && typeof nativeModule?.crashNativeAbort === 'function'
  );
}

export function runNativeAbort(
  enabled: boolean,
  nativeModule: AtomicAbortModule | null,
  testRunId: string,
  snapshot: DiagnosticSnapshot,
): boolean {
  if (!canRunNativeAbort(enabled, nativeModule)) return false;
  try {
    // The native boundary enforces a 32KB UTF-8 limit before stamping or crashing.
    const { breadcrumbs: _breadcrumbs, ...context } = snapshot;
    return nativeModule?.crashNativeAbort?.(testRunId, JSON.stringify(context)) === true;
  } catch {
    return false;
  }
}
