import { setTimeout as delay } from 'node:timers/promises';
import type { JobContext } from './types';

/**
 * POST one cron-authenticated mutation to the backend and return the field it
 * names, the shape the active-user jobs share. Same contract as
 * `purge-spray-wall-photos.ts`: the work lives in the backend, the scheduler
 * holds the schedule and the cron bearer.
 *
 * - HTTP 200 is not success: GraphQL reports resolver errors inside it, so a
 *   body with `errors` (or without the field) fails the run.
 * - Only 502/503 is retried, once after two seconds: those mean "a deploy is in
 *   flight", every other status means "the server said no".
 * - Raw backend pages never reach the logs.
 */
export async function runBackendCronMutation({
  context: { config, timeoutMs, shutdownSignal, logger },
  mutationName,
  mutation,
}: {
  context: JobContext;
  /** The top-level field the mutation selects, e.g. `snapshotActiveUsers`. */
  mutationName: string;
  mutation: string;
}): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error(`${mutationName} timed out`)), timeoutMs);
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
        body: JSON.stringify({ query: mutation }),
        signal,
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (attempt === 0 && (response.status === 502 || response.status === 503)) {
          logger.warn(`${mutationName} backend unavailable; retrying once`, { status: response.status });
          await delay(2_000, undefined, { signal });
          continue;
        }
        throw new Error(`${mutationName} returned HTTP ${response.status}`);
      }
      return readMutationField(await response.json(), mutationName);
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

function readMutationField(payload: unknown, mutationName: string): Record<string, unknown> {
  if (!isRecord(payload) || payload.errors !== undefined || !isRecord(payload.data)) {
    throw new Error(`${mutationName} returned GraphQL errors or an invalid response`);
  }
  const field = payload.data[mutationName];
  if (!isRecord(field)) throw new Error(`${mutationName} returned an invalid result`);
  return field;
}

/** True when every named field is a finite, non-negative number. */
export function hasNonNegativeCounts(result: Record<string, unknown>, fieldNames: readonly string[]): boolean {
  return fieldNames.every((fieldName) => {
    const fieldValue = result[fieldName];
    return typeof fieldValue === 'number' && Number.isFinite(fieldValue) && fieldValue >= 0;
  });
}
