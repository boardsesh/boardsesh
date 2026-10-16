import { createSnapshotProgressThrottle } from './snapshot-progress';

export type ScopeDownloadPhase = 'preparing' | 'downloading' | 'unpacking' | 'grades' | 'finishing';

export type ScopeDownloadProgress = {
  scopeKey: string;
  phase: ScopeDownloadPhase;
  fraction: number | null;
  wireBytes: number | null;
  wireBytesDone: number | null;
  queuedScopes: number;
  pendingScopeKeys?: readonly string[];
  rowsProcessed?: number;
};

export const DOWNLOAD_PHASE_WEIGHTS = {
  preparing: 0.01,
  downloading: 0.44,
  unpacking: 0.31,
  grades: 0.09,
  finishing: 0.15,
} as const;

const PHASES: readonly ScopeDownloadPhase[] = ['preparing', 'downloading', 'unpacking', 'grades', 'finishing'];

/** One tracker per scope and cycle; callers retain its high-water mark across phases. */
export function createScopeDownloadProgress(options: { scopeKey: string; hasGrades: boolean; now: () => number }) {
  const throttle = createSnapshotProgressThrottle({ now: options.now });
  let greatestFraction = 0;
  let lastPhase: ScopeDownloadPhase | null = null;
  let lastQueuedScopes: number | null = null;
  let lastPendingScopeKeys: string | undefined;
  let lastRows: number | undefined;
  let lastRowsAt = -Infinity;
  let cancelled = false;
  const weights = {
    ...DOWNLOAD_PHASE_WEIGHTS,
    unpacking: DOWNLOAD_PHASE_WEIGHTS.unpacking + (options.hasGrades ? 0 : DOWNLOAD_PHASE_WEIGHTS.grades),
    grades: options.hasGrades ? DOWNLOAD_PHASE_WEIGHTS.grades : 0,
  };

  return {
    offer(input: {
      phase: ScopeDownloadPhase;
      phaseFraction: number | null;
      wireBytes?: number | null;
      wireBytesDone?: number | null;
      queuedScopes: number;
      pendingScopeKeys?: readonly string[];
      rowsProcessed?: number;
      hasGrades?: boolean;
    }): ScopeDownloadProgress | null {
      if (cancelled) return null;
      // A failed snapshot can fall back to paged downloads (unknown fraction).
      // Otherwise, late transfer callbacks must not replace an import caption.
      const pagedFallback =
        input.phase === 'downloading' && input.phaseFraction === null && input.rowsProcessed !== undefined;
      if (!pagedFallback && lastPhase !== null && PHASES.indexOf(input.phase) < PHASES.indexOf(lastPhase)) {
        return null;
      }
      if (input.hasGrades !== undefined) {
        weights.grades = input.hasGrades ? DOWNLOAD_PHASE_WEIGHTS.grades : 0;
        weights.unpacking = DOWNLOAD_PHASE_WEIGHTS.unpacking + (input.hasGrades ? 0 : DOWNLOAD_PHASE_WEIGHTS.grades);
      }
      let fraction: number | null = null;
      if (input.phaseFraction !== null && Number.isFinite(input.phaseFraction)) {
        const phaseIndex = PHASES.indexOf(input.phase);
        const offset = PHASES.slice(0, phaseIndex).reduce((sum, phase) => sum + weights[phase], 0);
        fraction = Math.min(
          1,
          Math.max(greatestFraction, offset + weights[input.phase] * Math.min(1, Math.max(0, input.phaseFraction))),
        );
        greatestFraction = fraction;
      }
      const frame = {
        scopeKey: options.scopeKey,
        stage: 'download' as const,
        fraction,
        wireBytes: input.wireBytes ?? null,
        wireBytesDone: input.wireBytesDone ?? null,
      };
      const pendingScopeKeys = input.pendingScopeKeys ? JSON.stringify(input.pendingScopeKeys) : undefined;
      const rowsChanged = fraction === null && input.rowsProcessed !== lastRows && options.now() - lastRowsAt >= 400;
      const emitted =
        input.phase !== lastPhase ||
        input.queuedScopes !== lastQueuedScopes ||
        pendingScopeKeys !== lastPendingScopeKeys ||
        rowsChanged
          ? throttle.flush(frame)
          : throttle.offer(frame);
      if (!emitted) return null;
      lastPhase = input.phase;
      lastQueuedScopes = input.queuedScopes;
      lastPendingScopeKeys = pendingScopeKeys;
      lastRows = input.rowsProcessed;
      lastRowsAt = options.now();
      return {
        scopeKey: options.scopeKey,
        phase: input.phase,
        fraction,
        wireBytes: frame.wireBytes,
        wireBytesDone: frame.wireBytesDone,
        queuedScopes: input.queuedScopes,
        ...(input.pendingScopeKeys ? { pendingScopeKeys: [...input.pendingScopeKeys] } : {}),
        ...(input.rowsProcessed !== undefined ? { rowsProcessed: input.rowsProcessed } : {}),
      };
    },
    cancel: () => {
      cancelled = true;
      throttle.cancel();
    },
  };
}
