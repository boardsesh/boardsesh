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
  /**
   * Immutable community send count from the climb snapshot that opened the
   * tick form. Mobile uses it to raise a first-send display floor even when no
   * live-stat selector is mounted on the saving surface. This is local-only and
   * is never sent in SaveTickInput.
   */
  baseAscensionistCount?: number;
  sizeId?: number;
  setIds?: string;
  /**
   * Specific board entity this tick is on, by uuid. When provided, takes
   * precedence over `(layoutId, sizeId, setIds)` resolution and lets ticks
   * attach to a board the climber doesn't own (e.g. a seeded gym board).
   */
  boardUuid?: string;
  // Resolved shared board id (from resolveBoardForSerial) for the BLE-connected
  // wall; used when no boardUuid is given.
  boardId?: number | null;
  videoUrl?: string;
  /**
   * The version of the climb the climber was looking at (`Climb.revisionNumber`),
   * sent as `SaveTickInput.climbRevision`. Pass it only when it is known: a
   * missing or non-positive value sends no key at all, and the server stores
   * the version that was live when the climb was climbed (#6023).
   */
  climbRevision?: number | null;
};

/**
 * The `climbRevision` to put on the wire, or undefined to leave the key out.
 * Only a positive integer is sent. An older backend rejects an input field it
 * does not know, so an unknown version must be an absent key, never a null.
 */
export function climbRevisionToSend(climbRevision: number | null | undefined): number | undefined {
  return typeof climbRevision === 'number' && Number.isInteger(climbRevision) && climbRevision >= 1
    ? climbRevision
    : undefined;
}

/** Builds the optimistic logbook entry written on mutate, keyed by a temp uuid. */
export function buildOptimisticTickEntry(options: SaveTickOptions, tempUuid: string): LogbookEntry {
  const climbRevision = climbRevisionToSend(options.climbRevision);
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
    // The version this tick is being sent with, so the row can say "Earlier
    // version" (or not) before the server answers. Absent when unknown.
    ...(climbRevision === undefined ? {} : { climb_revision: climbRevision }),
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
