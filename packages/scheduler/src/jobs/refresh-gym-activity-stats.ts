import { setTimeout as delay } from 'node:timers/promises';
import type { JobRun } from './types';

export const REFRESH_GYM_ACTIVITY_STATS_MUTATION = `
  mutation RefreshGymActivityStats {
    refreshGymActivityStats {
      gymCount previousGymCount forced scanDurationMs writeDurationMs durationMs timestamp
    }
  }
`;

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/** HTTP 200 alone is insufficient: GraphQL can report resolver errors in it. */
function readRefreshResult(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload) || payload.errors !== undefined || !isRecord(payload.data)) {
    throw new Error('refreshGymActivityStats returned GraphQL errors or an invalid response');
  }
  const refresh = payload.data.refreshGymActivityStats;
  if (
    !isRecord(refresh) ||
    !['gymCount', 'previousGymCount', 'scanDurationMs', 'writeDurationMs', 'durationMs'].every(
      (field) => typeof refresh[field] === 'number' && Number.isFinite(refresh[field]) && refresh[field] >= 0,
    ) ||
    typeof refresh.forced !== 'boolean' ||
    typeof refresh.timestamp !== 'string'
  ) {
    throw new Error('refreshGymActivityStats returned an invalid result');
  }
  return refresh;
}

export const refreshGymActivityStats: JobRun = async ({ config, timeoutMs, shutdownSignal, logger }) => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('Gym activity refresh timed out')), timeoutMs);
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
        body: JSON.stringify({ query: REFRESH_GYM_ACTIVITY_STATS_MUTATION }),
        signal,
      });
      if (!response.ok) {
        // Consume the response before retrying; never include raw backend pages
        // in logs. A 409/504 may mean another writer is running, so do not retry.
        await response.body?.cancel();
        if (attempt === 0 && (response.status === 502 || response.status === 503)) {
          logger.warn('gym activity backend unavailable; retrying once', { status: response.status });
          await delay(2_000, undefined, { signal });
          continue;
        }
        throw new Error(`refreshGymActivityStats returned HTTP ${response.status}`);
      }
      return readRefreshResult(await response.json());
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
};
