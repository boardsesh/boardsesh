// Pure, renderer-agnostic board-data transforms. No React, no DOM, no platform
// I/O — just the data shaping shared by web and mobile logbook/tick/climb hooks.
// Everything here is node-testable; the React hooks in this package are thin
// wrappers over these functions + React Query.

import { GraphQLOperationError, isClimbDuplicateExtension } from '@boardsesh/graphql-client';
import type { SaveClimbInput } from '@boardsesh/shared-schema';

// Tick status type matching the database enum.
export type TickStatus = 'flash' | 'send' | 'attempt';

// Logbook entry representing a user's tick on a climb.
export type LogbookEntry = {
  uuid: string;
  climb_uuid: string;
  angle: number;
  is_mirror: boolean;
  tries: number;
  quality: number | null;
  difficulty: number | null;
  comment: string;
  climbed_at: string;
  is_ascent: boolean;
  status?: TickStatus;
  upvotes: number;
  downvotes: number;
  commentCount: number;
};

// Shape returned by the GET_TICKS / SAVE_TICK selection sets (camelCase wire).
export type LogbookSourceTick = {
  uuid: string;
  climbUuid: string;
  angle: number;
  isMirror: boolean;
  status: TickStatus;
  attemptCount: number;
  quality: number | null;
  difficulty: number | null;
  comment: string;
  climbedAt: string;
  upvotes?: number | null;
  downvotes?: number | null;
  commentCount?: number | null;
};

// Options for saving a tick. `quality`/`difficulty` accept null so call sites
// can pass an explicit "no rating" without juggling undefined.
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
  videoUrl?: string;
};

// snake_case climb-create payload (mirrors the subset of web's aurora
// `SaveClimbOptions` that the mutation actually maps). Excess props (e.g.
// `setter_username`) on a passed object are ignored.
export type SaveClimbOptions = {
  layout_id: number;
  name: string;
  description: string;
  is_draft: boolean;
  frames: string;
  frames_count?: number;
  frames_pace?: number;
  angle: number;
};

export type SaveClimbResponse = {
  uuid: string;
  createdAt?: string | null;
  publishedAt?: string | null;
};

export type UpdateClimbResponse = {
  uuid: string;
  createdAt?: string | null;
  publishedAt?: string | null;
  isDraft: boolean;
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

/**
 * Stable key for accumulated logbook data. This is the single source of truth
 * for board-route tick rendering. `boardName` may be null (mobile resolves its
 * active board asynchronously) — that yields a distinct, inert key.
 */
export function accumulatedLogbookQueryKey(boardName: string | null) {
  return ['logbook', boardName, 'accumulated'] as const;
}

export function fetchLogbookQueryKeyPrefix(boardName: string | null) {
  return ['logbook', boardName, 'fetch'] as const;
}

/** Dynamic key for each incremental fetch batch. */
export function fetchLogbookQueryKey(boardName: string | null, climbUuids: string[]) {
  return [...fetchLogbookQueryKeyPrefix(boardName), [...climbUuids].sort().join(',')] as const;
}

/** Backward-compatible key (no `fetch` segment) — kept because web tests assert it. */
export function logbookQueryKey(boardName: string | null, climbUuids: string[]) {
  return ['logbook', boardName, [...climbUuids].sort().join(',')] as const;
}

// Monotonic suffix so two optimistic ticks created within the same millisecond
// (rapid taps) never collide — `Date.now()` alone is not unique enough.
let optimisticCounter = 0;

/** Generates a collision-free temporary id for an optimistic tick entry. */
export function nextTempUuid(): string {
  optimisticCounter += 1;
  return `temp-${Date.now()}-${optimisticCounter}`;
}

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
 * present via a server echo), or prepends when there is no temp / the entry is new.
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

/** Maps the snake_case climb-create payload to the camelCase GraphQL input. */
export function toSaveClimbInput(boardType: string, options: SaveClimbOptions): SaveClimbInput {
  return {
    boardType,
    layoutId: options.layout_id,
    name: options.name,
    description: options.description || '',
    isDraft: options.is_draft,
    frames: options.frames,
    framesCount: options.frames_count,
    framesPace: options.frames_pace,
    angle: options.angle,
  };
}

/** True when an error is a duplicate-publish rejection the form handles inline. */
export function isDuplicateClimbError(err: unknown): boolean {
  return err instanceof GraphQLOperationError && isClimbDuplicateExtension(err.extensions);
}
