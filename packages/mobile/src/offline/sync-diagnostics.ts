import type { SyncProgress } from '@boardsesh/offline-sync';
import {
  beginDiagnosticOperation,
  diagnosticErrorAttributes,
  type DiagnosticOperation,
} from '../lib/mobile-diagnostics';

/** One cycle, not one progress callback: row/chunk counters never emit breadcrumbs. */
export function createSyncDiagnostics(name: string) {
  let operation: DiagnosticOperation | undefined;
  let lastPhase: string | undefined;
  let disposed = false;
  return {
    begin(initialPhase = 'outbox') {
      if (disposed) return;
      operation?.finish('superseded');
      operation = beginDiagnosticOperation('data', name);
      lastPhase = undefined;
      operation.step(initialPhase);
    },
    progress(progress: SyncProgress) {
      if (disposed || !operation) return;
      if (progress.phase === 'idle') {
        operation.finish(progress.failed ? 'failure' : progress.interrupted ? 'cancelled' : 'success', {
          completedCount: progress.documentsProcessed,
        });
        operation = undefined;
      } else {
        const phase = progress.snapshot ? `snapshot_${progress.snapshot.stage}` : progress.phase;
        const transition = `${phase}:${progress.snapshot?.scopeKey ?? ''}`;
        if (transition === lastPhase) return;
        lastPhase = transition;
        operation.step(phase, progress.snapshot ? { downloadScope: progress.snapshot.scopeKey } : undefined);
      }
    },
    error(error: unknown) {
      operation?.finish(
        error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failure',
        diagnosticErrorAttributes(error),
      );
      operation = undefined;
    },
    complete() {
      operation?.finish('success');
      operation = undefined;
    },
    dispose() {
      disposed = true;
      operation?.finish('cancelled');
      operation = undefined;
    },
  };
}
