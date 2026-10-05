import type { BoardName } from '@boardsesh/shared-schema';

// Tick status type matching the database enum.
export type TickStatus = 'flash' | 'send' | 'attempt';

// Logbook entry representing a user's tick on a climb. snake_case lives
// here because it matches the pre-existing wire / cache shape both web and
// mobile already render against — changing it would be a separate change.
export type LogbookEntry = {
  uuid: string;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  tries: number;
  quality: number | null;
  // COALESCE(quality, the climber's own synced star rating from
  // board_climb_ratings). Read this for star DISPLAY — it falls back to the
  // Kilter-synced rating when a pulled tick has no per-tick quality. `quality`
  // stays the raw per-tick value so edit-draft prefills don't adopt the synced
  // rating. 1-5 native (no rescaling); null when neither exists.
  effectiveQuality?: number | null;
  difficulty: number | null;
  comment: string;
  climbed_at: string;
  is_ascent: boolean;
  status?: TickStatus;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  /**
   * The version of the climb this was logged on (`Tick.climbRevision`), 1 on a
   * climb nobody has edited. Three states (see `isTickOnCurrentHolds` in
   * `@boardsesh/logbook`):
   *
   * - a number: that version.
   * - `null`: the tick is known to carry none (an import, or older than the
   *   field). Reads as version 1.
   * - absent: not known. The row came from `GetTicks`, which cannot select the
   *   field yet, and the platform's local copy of the tick
   *   (`BoardAdapter.readLocalTickRevisions`) had no row for it. Such a tick
   *   still counts as sent.
   */
  climb_revision?: number | null;
};

/**
 * Index key for a climb's ticks at a given angle. Used to group the logbook
 * into `BoardContextType.logbookByClimbAngle` so per-row consumers (e.g. the
 * climb-list ascent-status glyph) do an O(1) lookup instead of scanning the
 * whole logbook on every render. Keep the reader and the index builder using
 * this same helper so the keys can't drift.
 */
export function logbookClimbAngleKey(climbUuid: string, angle: number): string {
  return `${climbUuid}:${angle}`;
}

// The camelCase server-side shape (matches `GetTicksQueryResponse['ticks'][n]`
// and `SaveTickMutationResponse['saveTick']`). Kept structural so the helper
// works regardless of which GraphQL operation produced it.
export type LogbookSourceTick = {
  uuid: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  effectiveQuality?: number | null;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
  upvotes?: number | null;
  downvotes?: number | null;
  commentCount?: number | null;
  climbRevision?: number | null;
};

export function toLogbookEntry(tick: LogbookSourceTick): LogbookEntry {
  return {
    uuid: tick.uuid,
    climb_uuid: tick.climbUuid,
    angle: tick.angle,
    is_mirror: tick.isMirror,
    tries: tick.attemptCount,
    quality: tick.quality,
    // Falls back to the tick's own raw quality when the server didn't send a
    // synced rating (e.g. saveTick mutation responses), so display stays
    // correct on optimistic writes.
    effectiveQuality: tick.effectiveQuality ?? tick.quality,
    difficulty: tick.difficulty,
    comment: tick.comment,
    climbed_at: tick.climbedAt,
    is_ascent: tick.status === 'flash' || tick.status === 'send',
    status: tick.status,
    upvotes: tick.upvotes ?? 0,
    downvotes: tick.downvotes ?? 0,
    commentCount: tick.commentCount ?? 0,
    // `null` is kept: it says the source looked and the tick has no version.
    // An absent field stays absent, which says nobody looked.
    ...(tick.climbRevision === undefined ? {} : { climb_revision: tick.climbRevision }),
  };
}

/**
 * Which of two readings of one tick's version to keep. A later reading can know
 * more than an earlier one (the phone pulled the tick in between), never less:
 * a number beats everything, "known to have none" beats "not known", and
 * nothing replaces a value with `undefined`.
 */
export function mergeTickRevision(
  existing: number | null | undefined,
  incoming: number | null | undefined,
): number | null | undefined {
  if (typeof incoming === 'number') return incoming;
  if (incoming === null && existing === undefined) return null;
  return existing;
}

/**
 * Put the platform's local reading of each tick's version onto logbook entries.
 *
 * The map holds a number for a tick with a version, `null` for a tick the
 * platform holds a copy of that has none, and no key for a tick it holds no
 * copy of. An entry never loses what it already knows (`mergeTickRevision`).
 * Returns the same array when nothing changed.
 */
export function withTickRevisions(
  entries: LogbookEntry[],
  revisionByTickUuid: ReadonlyMap<string, number | null>,
): LogbookEntry[] {
  if (revisionByTickUuid.size === 0) return entries;
  let changed = false;
  const next = entries.map((entry) => {
    const revision = mergeTickRevision(entry.climb_revision, revisionByTickUuid.get(entry.uuid));
    if (revision === entry.climb_revision) return entry;
    changed = true;
    return { ...entry, climb_revision: revision };
  });
  return changed ? next : entries;
}

/**
 * Add a fetched batch to the accumulated logbook. A row already there stays as
 * it is, with one exception: its climb version. A later read of the same tick
 * can know the version when the first did not (the platform pulled the tick in
 * between), and a row that kept "not known" for the rest of the session would
 * misread a send (#6023). The upgrade only ever adds knowledge
 * (`mergeTickRevision`). Returns the same array when nothing changed.
 */
export function mergeLogbookEntries(existing: LogbookEntry[], incoming: LogbookEntry[]): LogbookEntry[] {
  if (incoming.length === 0) return existing;

  const incomingByUuid = new Map(incoming.map((entry) => [entry.uuid, entry]));
  let upgraded = false;
  const merged = existing.map((entry) => {
    const later = incomingByUuid.get(entry.uuid);
    if (!later) return entry;
    incomingByUuid.delete(entry.uuid);
    const revision = mergeTickRevision(entry.climb_revision, later.climb_revision);
    if (revision === entry.climb_revision) return entry;
    upgraded = true;
    return { ...entry, climb_revision: revision };
  });

  // What is left in the map is new. `incoming` order is kept.
  const uniqueIncoming = incoming.filter((entry) => incomingByUuid.get(entry.uuid) === entry);
  if (uniqueIncoming.length === 0) return upgraded ? merged : existing;
  return [...merged, ...uniqueIncoming];
}

// `boardName | null` so a not-yet-resolved board (mobile boot, web's loose
// route param) maps to a distinct, inert key that's never fetched into.
export function accumulatedLogbookQueryKey(boardName: BoardName | null) {
  return ['logbook', boardName, 'accumulated'] as const;
}

export function fetchLogbookQueryKeyPrefix(boardName: BoardName | null) {
  return ['logbook', boardName, 'fetch'] as const;
}

/**
 * Authoritative coverage marker: the climbs the accumulated rows answer for.
 * Read by every `useLogbook` on the board and by first-send optimistic stats.
 * `useLogbook` removes it whenever the accumulated rows are removed.
 */
export function fetchedLogbookClimbUuidsQueryKey(boardName: BoardName | null) {
  return ['logbook', boardName, 'fetched-climb-uuids'] as const;
}

export function fetchLogbookQueryKey(boardName: BoardName | null, climbUuids: string[]) {
  return [...fetchLogbookQueryKeyPrefix(boardName), [...climbUuids].sort().join(',')] as const;
}

// Pre-extraction key shape — retained for callers that built keys directly
// before the prefix split. New code should prefer the prefixed builders above.
export function logbookQueryKey(boardName: BoardName | null, climbUuids: string[]) {
  return ['logbook', boardName, [...climbUuids].sort().join(',')] as const;
}
