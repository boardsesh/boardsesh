import type { JobRun } from './types';
import { hasNonNegativeCounts, runBackendCronMutation } from './backend-cron-mutation';

/**
 * Export the vetted spray wall training set (SW-20, #5471).
 *
 * The work is a backend mutation, like `purge-spray-wall-photos`: the scheduler
 * has no database client and no storage credentials, and the private photo
 * bucket stays behind one service. What it owns is the SCHEDULE, and the
 * schedule is the promise in `docs/spray-walls.md`: a wall whose owner switches
 * "Help train hold finding" off (or deletes it, or an admin hides it) leaves
 * every stored export within 24 hours, because each run first retires any
 * export holding a version that is no longer eligible and approved. The job
 * runs every six hours, so the promise survives two failed runs in a row.
 *
 * Running four times a day costs little, because a run with nothing to do stops
 * early. The backend reads the approved set, lists the export prefix and reads
 * each stored export's manifest (it keeps two exports); when none is stale and
 * the fingerprint matches the newest, it answers `skipped: true` (`UNCHANGED`,
 * or `NOTHING_TO_EXPORT` when nothing is approved) having downloaded no photo,
 * deleted nothing and written nothing. Both are successful runs here.
 *
 * Overlap-safe, which `JobDefinition` requires: the mutation takes a lease row
 * before it touches storage, so a second run meeting a first answers
 * `skippedReason: LOCKED` and writes nothing. This job then FAILS, on purpose.
 * The lease lasts 20 minutes, so a tick that meets one found a run that began
 * in that window and has not let go: one still going (started by hand, or by a
 * request whose answer never arrived), or one that died. Either way this tick
 * retired nothing, and that must not pass as a skip.
 *
 * The request, the 502/503 retry and the GraphQL-errors check belong to
 * `runBackendCronMutation`. What is this job's own is below: the result's shape
 * and the LOCKED rule.
 */
export const EXPORT_SPRAY_TRAINING_MUTATION = `
  mutation ExportSprayTrainingDataset {
    exportSprayTrainingDataset {
      exportId imagesWritten exportsRetired skipped skippedReason versionsSkipped durationMs
    }
  }
`;

/** What one export run reports back. Mirrors `SprayTrainingExportResult` in the backend. */
export type ExportResult = {
  exportId: string | null;
  imagesWritten: number;
  exportsRetired: number;
  skipped: boolean;
  skippedReason: 'LOCKED' | 'UNCHANGED' | 'NOTHING_TO_EXPORT' | null;
  versionsSkipped: number;
  durationMs: number;
};

/** Every value `skippedReason` may carry. `unknown` so an unvalidated field can be looked up in it. */
const SKIP_REASONS: readonly unknown[] = ['LOCKED', 'UNCHANGED', 'NOTHING_TO_EXPORT', null] satisfies ReadonlyArray<
  ExportResult['skippedReason']
>;

export const exportSprayTraining: JobRun = async (context) => {
  const exported = await runBackendCronMutation({
    context,
    mutationName: 'exportSprayTrainingDataset',
    mutation: EXPORT_SPRAY_TRAINING_MUTATION,
  });
  if (
    !hasNonNegativeCounts(exported, ['imagesWritten', 'exportsRetired', 'versionsSkipped', 'durationMs']) ||
    typeof exported.skipped !== 'boolean' ||
    !SKIP_REASONS.includes(exported.skippedReason) ||
    !(exported.exportId === null || typeof exported.exportId === 'string')
  ) {
    throw new Error('exportSprayTrainingDataset returned an invalid result');
  }
  // Another run holds the lease, so this one retired nothing. The 24-hour
  // removal promise rests on retirement, so that is a failed run (`lastError`
  // on /health/jobs) rather than a quiet skip.
  if (exported.skippedReason === 'LOCKED') {
    throw new Error('exportSprayTrainingDataset skipped: another run holds the export lease');
  }
  // Narrowed by the checks above, which `Record<string, unknown>` cannot express.
  return exported as ExportResult;
};
