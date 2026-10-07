import { setTimeout as delay } from 'node:timers/promises';
import type { JobRun } from './types';

/**
 * Export the vetted spray wall training set (SW-20, #5471).
 *
 * The work is a backend mutation, like `purge-spray-wall-photos`: the scheduler
 * has no database client and no storage credentials, and the private photo
 * bucket stays behind one service. What it owns is the SCHEDULE, and the
 * schedule is the promise in `docs/spray-walls.md`: a wall whose owner switches
 * "Help train hold finding" off (or deletes it, or an admin hides it) leaves
 * every stored export within 24 hours, because each run first retires any
 * export holding a version that is no longer eligible and approved.
 *
 * Overlap-safe, which `JobDefinition` requires: the mutation takes a lease row
 * before it touches storage, so a second run meeting a first answers
 * `skippedReason: LOCKED` and writes nothing. This job then FAILS, on purpose:
 * a lease still held a day later means a stuck run, and that must not pass as
 * a skip.
 */
export const EXPORT_SPRAY_TRAINING_MUTATION = `
  mutation ExportSprayTrainingDataset {
    exportSprayTrainingDataset {
      exportId imagesWritten exportsRetired skipped skippedReason versionsSkipped durationMs
    }
  }
`;

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

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

const SKIP_REASONS: ReadonlyArray<ExportResult['skippedReason']> = ['LOCKED', 'UNCHANGED', 'NOTHING_TO_EXPORT', null];

/** HTTP 200 alone is insufficient: GraphQL can report resolver errors in it. */
export function readExportResult(payload: unknown): ExportResult {
  if (!isRecord(payload) || payload.errors !== undefined || !isRecord(payload.data)) {
    throw new Error('exportSprayTrainingDataset returned GraphQL errors or an invalid response');
  }
  const exported = payload.data.exportSprayTrainingDataset;
  if (
    !isRecord(exported) ||
    !['imagesWritten', 'exportsRetired', 'versionsSkipped', 'durationMs'].every(
      (field) =>
        typeof exported[field] === 'number' && Number.isFinite(exported[field]) && (exported[field] as number) >= 0,
    ) ||
    typeof exported.skipped !== 'boolean' ||
    !SKIP_REASONS.includes(exported.skippedReason as ExportResult['skippedReason']) ||
    !(exported.exportId === null || typeof exported.exportId === 'string')
  ) {
    throw new Error('exportSprayTrainingDataset returned an invalid result');
  }
  // Narrowed by the checks above, which `Record<string, unknown>` cannot express.
  return exported as ExportResult;
}

export const exportSprayTraining: JobRun = async ({ config, timeoutMs, shutdownSignal, logger }) => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('Spray training export timed out')), timeoutMs);
  const signal = shutdownSignal ? AbortSignal.any([controller.signal, shutdownSignal]) : controller.signal;

  try {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const response = await fetch(config.backendGraphqlUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.cronSecret}`,
          'Content-Type': 'application/json',
          Accept: 'application/graphql-response+json, application/json',
        },
        body: JSON.stringify({ query: EXPORT_SPRAY_TRAINING_MUTATION }),
        signal,
      });
      if (!response.ok) {
        // Consume the response before retrying; never put raw backend pages in
        // logs. A deploy in flight is the one case worth a second try.
        await response.body?.cancel();
        if (attempt === 0 && (response.status === 502 || response.status === 503)) {
          logger.warn('spray training export backend unavailable; retrying once', { status: response.status });
          await delay(2_000, undefined, { signal });
          continue;
        }
        throw new Error(`exportSprayTrainingDataset returned HTTP ${response.status}`);
      }
      const result = readExportResult(await response.json());
      // A held lease means another run is still going, or one died holding it.
      // Either way today's retirement did not happen, and the 24-hour removal
      // promise rests on it, so this is a failed run (lastError and overdue on
      // /health/jobs) rather than a quiet skip.
      if (result.skippedReason === 'LOCKED') {
        throw new Error('exportSprayTrainingDataset skipped: another run holds the export lease');
      }
      return result;
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
};
