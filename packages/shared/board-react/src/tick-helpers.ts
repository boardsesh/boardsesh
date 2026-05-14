import type { LogbookEntry, TickStatus } from './logbook-keys';

// Options for saving a tick. `quality` / `difficulty` accept `null` so call
// sites can pass an explicit "no rating" without juggling undefined — both
// the optimistic cache entry and the GraphQL input treat null as absent.
export type SaveTickOptions = {
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality?: number | null;
  difficulty?: number | null;
  // Climb's consensus grade id, looked up client-side from board grade tables.
  // Used only to seed the optimistic entry's `effectiveDifficulty` so a tick
  // logged without a personal grade override (`difficulty` undefined) doesn't
  // appear gradeless in chart consumers between optimistic insert and the
  // server response. Not forwarded to the GraphQL mutation.
  consensusDifficulty?: number | null;
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  sessionId?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  videoUrl?: string;
};

/** Builds the optimistic logbook entry written on mutate, keyed by a temp uuid. */
export function buildOptimisticTickEntry(options: SaveTickOptions, tempUuid: string): LogbookEntry {
  return {
    uuid: tempUuid,
    climb_uuid: options.climbUuid,
    angle: options.angle,
    is_mirror: options.isMirror,
    tries: options.attemptCount,
    quality: options.quality ?? null,
    difficulty: options.difficulty ?? null,
    effectiveDifficulty: options.difficulty ?? options.consensusDifficulty ?? null,
    comment: options.comment,
    climbed_at: options.climbedAt,
    is_ascent: options.status === 'flash' || options.status === 'send',
    status: options.status,
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
  };
}

/**
 * Reconciles the server-saved entry into the accumulated logbook: replaces the
 * optimistic temp entry in place (de-duplicating if the real uuid was already
 * present), or prepends when there is no temp / the entry is new.
 */
export function applySavedTickToLogbook(
  existing: LogbookEntry[],
  savedEntry: LogbookEntry,
  tempUuid: string | undefined,
): LogbookEntry[] {
  if (!tempUuid) {
    return existing.some((entry) => entry.uuid === savedEntry.uuid) ? existing : [savedEntry, ...existing];
  }

  let replaced = false;
  const next = existing.map((entry) => {
    if (entry.uuid !== tempUuid) return entry;
    replaced = true;
    return savedEntry;
  });

  if (replaced) {
    const seen = new Set<string>();
    return next.filter((entry) => {
      if (seen.has(entry.uuid)) return false;
      seen.add(entry.uuid);
      return true;
    });
  }
  return existing.some((entry) => entry.uuid === savedEntry.uuid) ? existing : [savedEntry, ...existing];
}

/** Removes the optimistic temp entry on error. */
export function rollbackOptimisticTick(existing: LogbookEntry[], tempUuid: string): LogbookEntry[] {
  return existing.filter((entry) => entry.uuid !== tempUuid);
}
