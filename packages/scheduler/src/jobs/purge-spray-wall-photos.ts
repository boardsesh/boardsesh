import { setTimeout as delay } from 'node:timers/promises';
import type { JobRun } from './types';

/**
 * Delete the photographs of spray walls that were soft-deleted more than 30 days
 * ago (`SPRAY_WALL_PHOTO_RETENTION_DAYS`, epic #5346 / SW-17).
 *
 * The work itself is a backend mutation, not SQL in here, for the same reason
 * `refreshGymActivityStats` is: the scheduler has no database client and no
 * storage credentials, and giving it either would put the private photo bucket
 * behind a second service. What it owns is the SCHEDULE.
 *
 * Deleting a wall is a soft delete — the catalogue rows and every climb ever set
 * on it stay behind, because a deleted wall stops being reachable and does not
 * un-set anybody's climbs. The photographs are the part that must not linger:
 * they are the inside of somebody's home, and after the wall is gone nothing
 * reads them again. Thirty days is the undo window, not a retention policy.
 *
 * Overlap-safe, which `JobDefinition` requires: the mutation takes a batch of
 * walls, deletes objects and then clears `photo_key`, so a second run meeting a
 * first finds the same walls and re-lists prefixes that are already empty. It
 * deletes nothing twice and never fails on a missing object.
 */
export const PURGE_SPRAY_WALL_PHOTOS_MUTATION = `
  mutation PurgeDeletedSprayWallPhotos {
    purgeDeletedSprayWallPhotos {
      wallsPurged objectsDeleted wallsConsidered durationMs
    }
  }
`;

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === 'object' && candidate !== null && !Array.isArray(candidate);
}

/** What one purge run reports back. Mirrors `SprayWallPhotoPurgeResult` in the backend. */
export type PurgeResult = {
  wallsPurged: number;
  objectsDeleted: number;
  wallsConsidered: number;
  durationMs: number;
};

/** HTTP 200 alone is insufficient: GraphQL can report resolver errors in it. */
function readPurgeResult(payload: unknown): PurgeResult {
  if (!isRecord(payload) || payload.errors !== undefined || !isRecord(payload.data)) {
    throw new Error('purgeDeletedSprayWallPhotos returned GraphQL errors or an invalid response');
  }
  const purge = payload.data.purgeDeletedSprayWallPhotos;
  if (
    !isRecord(purge) ||
    !['wallsPurged', 'objectsDeleted', 'wallsConsidered', 'durationMs'].every(
      (field) => typeof purge[field] === 'number' && Number.isFinite(purge[field]) && (purge[field] as number) >= 0,
    )
  ) {
    throw new Error('purgeDeletedSprayWallPhotos returned an invalid result');
  }
  // Narrowed by the checks above, which `Record<string, unknown>` cannot express.
  return purge as PurgeResult;
}

export const purgeSprayWallPhotos: JobRun = async ({ config, timeoutMs, shutdownSignal, logger }) => {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(new Error('Spray wall photo purge timed out')), timeoutMs);
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
        body: JSON.stringify({ query: PURGE_SPRAY_WALL_PHOTOS_MUTATION }),
        signal,
      });
      if (!response.ok) {
        // Consume the response before retrying; never put raw backend pages in
        // logs. A deploy in flight is the one case worth a second try.
        await response.body?.cancel();
        if (attempt === 0 && (response.status === 502 || response.status === 503)) {
          logger.warn('spray wall purge backend unavailable; retrying once', { status: response.status });
          await delay(2_000, undefined, { signal });
          continue;
        }
        throw new Error(`purgeDeletedSprayWallPhotos returned HTTP ${response.status}`);
      }
      return readPurgeResult(await response.json());
    }
  } finally {
    clearTimeout(timeoutHandle);
  }
};
