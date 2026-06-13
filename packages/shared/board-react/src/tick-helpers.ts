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
  isBenchmark: boolean;
  comment: string;
  climbedAt: string;
  sessionId?: string;
  layoutId?: number;
  sizeId?: number;
  setIds?: string;
  /**
   * Specific board entity this tick is on, by uuid. When provided, takes
   * precedence over `(layoutId, sizeId, setIds)` resolution and lets ticks
   * attach to a board the climber doesn't own (e.g. a seeded gym board).
   */
  boardUuid?: string;
  // Numeric user_boards.id for the selected or connected board; used when no
  // boardUuid is given.
  boardId?: number | null;
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
