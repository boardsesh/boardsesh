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
 * Overlap-safe, which `JobDefinition` requires: the mutation takes
 * `pg_try_advisory_xact_lock` before it touches storage, so a second run meeting
 * a first answers `skipped: true` and writes nothing.
 */
export const EXPORT_SPRAY_TRAINING_MUTATION = `
  mutation ExportSprayTrainingDataset {
    exportSprayTrainingDataset {
      exportId imagesWritten exportsRetired skipped durationMs
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
  durationMs: number;
};

/** HTTP 200 alone is insufficient: GraphQL can report resolver errors in it. */
export function readExportResult(payload: unknown): ExportResult {
  if (!isRecord(payload) || payload.errors !== undefined || !isRecord(payload.data)) {
    throw new Error('exportSprayTrainingDataset returned GraphQL errors or an invalid response');
  }
  const exported = payload.data.exportSprayTrainingDataset;
  if (
    !isRecord(exported) ||
    !['imagesWritten', 'exportsRetired', 'durationMs'].every(
      (field) =>
        typeof exported[field] === 'number' && Number.isFinite(exported[field]) && (exported[field] as number) >= 0,
    ) ||
    typeof exported.skipped !== 'boolean' ||
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
      return readExportResult(await response.json());
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
};
