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
  difficulty: number | null;
  // COALESCE(difficulty, climb consensus). Mirrors the backend `effectiveDifficulty`
  // field — chart/aggregate consumers should prefer this so a NULL-difficulty
  // tick still buckets at the climb's consensus grade. Null when neither the
  // user nor the climb has a grade. See docs/ascents-and-attempts.md.
  effectiveDifficulty: number | null;
  comment: string;
  climbed_at: string;
  is_ascent: boolean;
  status?: TickStatus;
  upvotes: number;
  downvotes: number;
  commentCount: number;
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
  difficulty: number | null;
  effectiveDifficulty?: number | null;
  comment: string;
  climbedAt: string;
  upvotes?: number | null;
  downvotes?: number | null;
  commentCount?: number | null;
};

export function toLogbookEntry(tick: LogbookSourceTick): LogbookEntry {
  return {
    uuid: tick.uuid,
    climb_uuid: tick.climbUuid,
    angle: tick.angle,
    is_mirror: tick.isMirror,
    tries: tick.attemptCount,
    quality: tick.quality,
    difficulty: tick.difficulty,
    // The `ticks` GraphQL query (used by `useLogbook`'s fetch path) doesn't
    // select `effectiveDifficulty`, so fall back to the raw override here.
    // `userTicks` (profile/`/you`) sets it explicitly server-side.
    effectiveDifficulty: tick.effectiveDifficulty ?? tick.difficulty ?? null,
    comment: tick.comment,
    climbed_at: tick.climbedAt,
    is_ascent: tick.status === 'flash' || tick.status === 'send',
    status: tick.status,
    upvotes: tick.upvotes ?? 0,
    downvotes: tick.downvotes ?? 0,
    commentCount: tick.commentCount ?? 0,
  };
}

export function mergeLogbookEntries(existing: LogbookEntry[], incoming: LogbookEntry[]): LogbookEntry[] {
  if (incoming.length === 0) return existing;

  const existingUuids = new Set(existing.map((entry) => entry.uuid));
  const uniqueIncoming = incoming.filter((entry) => !existingUuids.has(entry.uuid));

  if (uniqueIncoming.length === 0) return existing;
  return [...existing, ...uniqueIncoming];
}

// `boardName | null` so a not-yet-resolved board (mobile boot, web's loose
// route param) maps to a distinct, inert key that's never fetched into.
export function accumulatedLogbookQueryKey(boardName: BoardName | null) {
  return ['logbook', boardName, 'accumulated'] as const;
}

export function fetchLogbookQueryKeyPrefix(boardName: BoardName | null) {
  return ['logbook', boardName, 'fetch'] as const;
}

export function fetchLogbookQueryKey(boardName: BoardName | null, climbUuids: string[]) {
  return [...fetchLogbookQueryKeyPrefix(boardName), [...climbUuids].sort().join(',')] as const;
}

// Pre-extraction key shape — retained for callers that built keys directly
// before the prefix split. New code should prefer the prefixed builders above.
export function logbookQueryKey(boardName: BoardName | null, climbUuids: string[]) {
  return ['logbook', boardName, [...climbUuids].sort().join(',')] as const;
}
