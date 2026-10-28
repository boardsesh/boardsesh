/**
 * The Now slot: where the current climb sits in the flat queue, and the one
 * rule for putting a climb on the wall (F3, #6666).
 *
 * Design: `docs/current-climb-outside-queue.md`, section 1. The queue keeps its
 * wire and storage shape, one flat array plus `currentClimbQueueItem`. The
 * climber sees three parts of it:
 *
 *   current set:     queue = [ History ... ][ Now ][ Up next ... ]   line = index of current
 *   nothing current: queue = [ History ... ] | [ Up next ... ]       line = historyCount
 *
 * The backend resolvers and the mobile reducer both call these functions, the
 * same way both import `state-hash.ts`, so the two sides can't drift (#2359).
 * Pure TS: no React, no I/O, inputs are never mutated.
 */

import { MAX_SYNCED_QUEUE_ITEMS } from './limits';

/** The climb fields the Now slot reads. Wide enough for this package's `Climb` and shared-schema's. */
export type NowSlotClimb = {
  uuid: string;
  angle: number;
  boardType?: string | null;
};

export type NowSlotQueueItem = {
  uuid: string;
  climb: NowSlotClimb;
};

/**
 * The part of a queue state the Now slot reads. `historyCount` only carries
 * information while nothing is current (or the current climb is an orphan);
 * `null` or absent means "derive it": the current index, or 0.
 */
export type NowSlotState<TItem extends NowSlotQueueItem> = {
  queue: readonly TItem[];
  currentClimbQueueItem: TItem | null;
  historyCount?: number | null;
};

/**
 * A state the Now slot functions produce. `historyCount` is always resolved:
 * the current climb's index when one is current, else the line.
 */
export type NowSlotResolvedState<TItem extends NowSlotQueueItem> = {
  queue: TItem[];
  currentClimbQueueItem: TItem | null;
  historyCount: number;
};

/**
 * `setCurrentClimb(placement:)`. `NOW` is a new client putting a climb on the
 * wall, `STEP` is Previous on the queue walk. Absent means a shipped client, the
 * native socket, or a server-side caller that hasn't been changed.
 */
export type CurrentClimbPlacement = 'NOW' | 'STEP';

/** Which row of the placement table applied. Also the `rewrite` mutation metric. */
export type NowSlotRewrite =
  | 'none'
  | 'next'
  | 'next-from-line'
  | 'step'
  | 'move-history'
  | 'move-up-next'
  | 'dedupe-current'
  | 'dedupe-up-next'
  | 'dedupe-history'
  | 'insert'
  | 'clear';

/**
 * What a new uuid does when its climb is only in History (the `dedupe-history`
 * row). `reuse` moves the newest History copy into the Now slot. `fresh` reuses
 * only History's last entry, the one right behind the current climb (Previous
 * then Next, so a back-and-forth adds no copy); for an older copy it puts the
 * new uuid up and leaves History as it was (`insert`).
 *
 * A phone resolves its own open first and sends the entry it resolved to, so a
 * tap that reuses a History entry reaches the server as that entry's uuid. A
 * new uuid that comes with `placement` is therefore one the phone chose to put
 * up fresh (a forward step, Next or a track peek), and the server and the
 * reducer place it with `fresh`. Requests without `placement` keep `reuse`.
 */
export type HistoryCopyRule = 'reuse' | 'fresh';

/** The {@link HistoryCopyRule} for a request: `fresh` when it carries `placement`, the phone already resolved it. */
export function historyCopyRuleFor(placement: CurrentClimbPlacement | null | undefined): HistoryCopyRule {
  return placement != null ? 'fresh' : 'reuse';
}

export type NowSlotPlacement<TItem extends NowSlotQueueItem> = NowSlotResolvedState<TItem> & {
  rewrite: NowSlotRewrite;
};

/** History is trimmed when it reaches this many entries... */
export const HISTORY_TRIM_AT = 125;
/** ...down to the newest this many. The 25-entry gap means one trim per 25 climbs, not one per climb. */
export const HISTORY_KEEP_COUNT = 100;

/**
 * `extensions.code` of the GraphQL error `addQueueItem` returns when Up next
 * already fills `MAX_SYNCED_QUEUE_ITEMS` (section 5).
 */
export const QUEUE_FULL = 'QUEUE_FULL';

/** Index of the current climb in `queue`; -1 when nothing is current or it is an orphan. */
function currentIndexOf<TItem extends NowSlotQueueItem>(queue: readonly TItem[], current: TItem | null): number {
  if (!current) return -1;
  return queue.findIndex((queueItem) => queueItem.uuid === current.uuid);
}

function clampLine(historyCount: number | null | undefined, queueLength: number): number {
  if (historyCount == null || !Number.isFinite(historyCount)) return 0;
  return Math.min(Math.max(Math.trunc(historyCount), 0), queueLength);
}

function isOrphanCurrent<TItem extends NowSlotQueueItem>(state: NowSlotState<TItem>): boolean {
  return state.currentClimbQueueItem !== null && currentIndexOf(state.queue, state.currentClimbQueueItem) === -1;
}

/**
 * The History / Up next line: the current climb's index when it is in
 * `queue`, else `historyCount` clamped into the array. An orphan current climb
 * counts as nothing current.
 */
export function historyLine<TItem extends NowSlotQueueItem>(state: NowSlotState<TItem>): number {
  const currentIndex = currentIndexOf(state.queue, state.currentClimbQueueItem);
  return currentIndex >= 0 ? currentIndex : clampLine(state.historyCount, state.queue.length);
}

/**
 * Where Up next begins: `indexOf(current) + 1` when the current climb is in
 * `queue`, else (nothing current, or an orphan) `historyCount ?? 0`. Every
 * reader that today does `findIndex(current)` and treats -1 as "all Up next"
 * calls this instead.
 */
export function upNextStart<TItem extends NowSlotQueueItem>(
  queue: readonly TItem[],
  current: TItem | null,
  historyCount?: number | null,
): number {
  const currentIndex = currentIndexOf(queue, current);
  return currentIndex >= 0 ? currentIndex + 1 : clampLine(historyCount, queue.length);
}

/** Climbs that were on the wall, oldest first. */
export function historyOf<TItem extends NowSlotQueueItem>(state: NowSlotState<TItem>): TItem[] {
  return state.queue.slice(0, historyLine(state));
}

/** Climbs after Now (or from the line on when nothing is current). */
export function upNextOf<TItem extends NowSlotQueueItem>(state: NowSlotState<TItem>): TItem[] {
  return state.queue.slice(upNextStart(state.queue, state.currentClimbQueueItem, state.historyCount));
}

/**
 * The entries that count toward `MAX_SYNCED_QUEUE_ITEMS`: History + Up next.
 * The climb on the wall is extra (section 5, owner decision 2026-10-24), so a
 * stored array holds at most 501 entries with a climb current and at most 500
 * with nothing current. Opening a climb therefore never has to drop a queued
 * one: with nothing current and Up next at 500, the open stores 501.
 *
 * An orphan current climb isn't in `queue`, so it isn't subtracted; call
 * {@link normaliseOrphanCurrent} first and it is counted as the Now slot.
 */
export function historyAndUpNextCount<TItem extends NowSlotQueueItem>(state: NowSlotState<TItem>): number {
  const hasCurrent = currentIndexOf(state.queue, state.currentClimbQueueItem) >= 0;
  return state.queue.length - (hasCurrent ? 1 : 0);
}

/**
 * True when Up next plus `adding` more entries would pass
 * `MAX_SYNCED_QUEUE_ITEMS`. The climb on the wall doesn't count, and History
 * doesn't either: {@link capHistory} trims all of it before an Up next entry
 * would have to go. So this is the same answer as "History + Up next is still
 * at the cap after `capHistory`". `addQueueItem` (and Play next) rejects with
 * {@link QUEUE_FULL} at `adding = 1`; a `setQueue` or `joinSession` payload
 * throws at `adding = 0`.
 *
 * Call {@link normaliseOrphanCurrent} first: an orphan current climb counts as
 * nothing current until it is inserted, and then it is the Now slot.
 */
export function isUpNextFull<TItem extends NowSlotQueueItem>(state: NowSlotState<TItem>, adding = 1): boolean {
  const upNextCount = state.queue.length - upNextStart(state.queue, state.currentClimbQueueItem, state.historyCount);
  return upNextCount + adding > MAX_SYNCED_QUEUE_ITEMS;
}

/**
 * The match key: same `climb.uuid` and `climb.angle`, plus `climb.boardType`
 * when both sides carry it. A climb queued at 40° is not reused for an open at
 * 45°. The mirror flag is not part of the match.
 */
export function isSameWallClimb(left: NowSlotClimb, right: NowSlotClimb): boolean {
  if (left.uuid !== right.uuid || left.angle !== right.angle) return false;
  return !left.boardType || !right.boardType || left.boardType === right.boardType;
}

function withoutIndex<TItem>(queue: readonly TItem[], index: number): TItem[] {
  return [...queue.slice(0, index), ...queue.slice(index + 1)];
}

function insertedAt<TItem>(queue: readonly TItem[], index: number, item: TItem): TItem[] {
  return [...queue.slice(0, index), item, ...queue.slice(index)];
}

/**
 * Invariant 1: nothing stores an orphan current climb. An orphan (a room
 * written before F3, a native stale item, a `setQueue` / `joinSession` payload
 * whose current climb isn't in its queue) is inserted at the line, computed as
 * if nothing were current. It stays current there; once another climb goes on
 * the wall it is History's last entry.
 *
 * For a payload orphan, pass the line from {@link normaliseHistoryCount} (or
 * the caller's nothing-current derivation) as `historyCount`. A fresh join of
 * [A B C] with orphan X and no line gives [X A B C], A B C still Up next.
 *
 * `normalised` is true when an orphan was inserted; the write that stores it
 * publishes a `FullSync`. A state without an orphan comes back resolved and
 * otherwise unchanged.
 */
export function normaliseOrphanCurrent<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
): NowSlotResolvedState<TItem> & { normalised: boolean } {
  const current = state.currentClimbQueueItem;
  if (current && isOrphanCurrent(state)) {
    const line = clampLine(state.historyCount, state.queue.length);
    return {
      queue: insertedAt(state.queue, line, current),
      currentClimbQueueItem: current,
      historyCount: line,
      normalised: true,
    };
  }
  return {
    queue: [...state.queue],
    currentClimbQueueItem: current,
    historyCount: historyLine(state),
    normalised: false,
  };
}

function pointerTo<TItem extends NowSlotQueueItem>(
  queue: readonly TItem[],
  index: number,
  rewrite: NowSlotRewrite,
): NowSlotPlacement<TItem> {
  return { queue: [...queue], currentClimbQueueItem: queue[index], historyCount: index, rewrite };
}

/**
 * Move the entry at `fromIndex` into the Now slot. When a climb is current it
 * goes to History's end and the moved entry takes the slot right after it;
 * with nothing current the entry lands on the line.
 */
function moveIntoNow<TItem extends NowSlotQueueItem>(
  queue: readonly TItem[],
  line: number,
  hasCurrent: boolean,
  fromIndex: number,
  rewrite: NowSlotRewrite,
): NowSlotPlacement<TItem> {
  const entry = queue[fromIndex];
  // Removing an entry before the line shifts the line down by one.
  const lineWithoutEntry = fromIndex < line ? line - 1 : line;
  const targetIndex = hasCurrent ? lineWithoutEntry + 1 : lineWithoutEntry;
  const nextQueue = insertedAt(withoutIndex(queue, fromIndex), targetIndex, entry);
  return { queue: nextQueue, currentClimbQueueItem: entry, historyCount: targetIndex, rewrite };
}

/**
 * Put `item` on the wall (or take the current climb off it with `null`).
 * An orphan current climb in `state` is normalised first (invariant 1), then
 * the first row that matches applies:
 *
 * | Request                                                    | placement     | rewrite          |
 * | ---------------------------------------------------------- | ------------- | ---------------- |
 * | `item.uuid` is the current climb                           | any           | `none`           |
 * | `item.uuid` is Up next[0]                                  | any           | `next`           |
 * | `queue[0]`, nothing current, line >= 1, Up next not empty, |               |                  |
 * |   `shouldAddToQueue: false` (an old phone's Next)          | absent        | `next-from-line` |
 * | `item.uuid` is the last History entry                      | `STEP`/absent | `step`           |
 * | the last History entry, nothing current (already on line)  | `NOW`         | `step`           |
 * | in History, not last, a climb current                      | `STEP`/absent | `step`           |
 * | in History, not last, nothing current                      | `STEP`/absent | `move-history`   |
 * | `item.uuid` is in History                                  | `NOW`         | `move-history`   |
 * | `item.uuid` is in Up next at k > 0                         | any           | `move-up-next`   |
 * | new uuid, same climb as current                            | any           | `dedupe-current` |
 * | new uuid, climb in Up next (first copy)                    | any           | `dedupe-up-next` |
 * | new uuid, climb only in History (newest copy)              | any           | `dedupe-history` |
 * | the same, `historyCopy: 'fresh'`, not History's last entry | any           | `insert`         |
 * | new uuid, climb nowhere in `queue`                         | any           | `insert`         |
 * | `item: null`                                               | -             | `clear`          |
 *
 * `step` and `next` are pointer moves; `next-from-line` lights Up next[0], not
 * the climb named. Only an explicit `false` reads as an old phone's Next:
 * every shipped JS sender passes a boolean, while the native socket sends no
 * `shouldAddToQueue` and its Previous can name `queue[0]` after a
 * `CurrentClimbChanged(null)` (Swift keeps the cleared climb's index). A
 * reused entry keeps its own uuid, `addedByUser`, `tickedBy`
 * and mirror flag: the returned `currentClimbQueueItem` is the array's own
 * entry, except for `insert`, where it is `item`. `shouldAddToQueue` only
 * tells a row tap (`true`) from an old Next; it never decides whether the climb
 * joins the array, so no orphan can form. `historyCopy` decides the
 * `dedupe-history` row (see {@link HistoryCopyRule}). Never trims: callers run
 * {@link capHistory} on the result.
 */
export function placeOnWall<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
  item: TItem | null,
  placement?: CurrentClimbPlacement | null,
  shouldAddToQueue?: boolean | null,
  historyCopy: HistoryCopyRule = 'reuse',
): NowSlotPlacement<TItem> {
  const { queue, currentClimbQueueItem: current, historyCount: line } = normaliseOrphanCurrent(state);
  const currentIndex = currentIndexOf(queue, current);
  const hasCurrent = currentIndex >= 0;
  const firstUpNext = hasCurrent ? currentIndex + 1 : line;

  if (item === null) {
    // The current climb stays as History's last entry.
    return { queue, currentClimbQueueItem: null, historyCount: hasCurrent ? currentIndex + 1 : line, rewrite: 'clear' };
  }

  const existingIndex = queue.findIndex((queueItem) => queueItem.uuid === item.uuid);
  if (existingIndex >= 0) {
    if (existingIndex === currentIndex) return pointerTo(queue, existingIndex, 'none');
    if (existingIndex === firstUpNext) return pointerTo(queue, existingIndex, 'next');
    const isOldPhoneNext =
      !hasCurrent &&
      existingIndex === 0 &&
      line >= 1 &&
      firstUpNext < queue.length &&
      placement == null &&
      shouldAddToQueue === false;
    // With nothing current a shipped Next names queue[0], the oldest History
    // climb. Light the climb a new phone's Next picks instead of spilling
    // History into Up next.
    if (isOldPhoneNext) return pointerTo(queue, firstUpNext, 'next-from-line');
    if (existingIndex < line) {
      // A shipped Previous and a track back-swipe can't be told apart, so they
      // keep today's pointer move while a climb is current (decision 3). With
      // nothing current a pointer move would spill History into Up next, so
      // only History's last entry steps.
      const isLastHistory = existingIndex === line - 1;
      const isPointerStep = isLastHistory || hasCurrent;
      if (placement !== 'NOW' && isPointerStep) return pointerTo(queue, existingIndex, 'step');
      // NOW on History's last entry with nothing current: it already sits on
      // the line, so the move leaves the array as it is. Report the pointer.
      if (isLastHistory && !hasCurrent) return pointerTo(queue, existingIndex, 'step');
      return moveIntoNow(queue, line, hasCurrent, existingIndex, 'move-history');
    }
    return moveIntoNow(queue, line, hasCurrent, existingIndex, 'move-up-next');
  }

  if (hasCurrent && isSameWallClimb(queue[currentIndex].climb, item.climb)) {
    return pointerTo(queue, currentIndex, 'dedupe-current');
  }

  for (let index = firstUpNext; index < queue.length; index++) {
    if (isSameWallClimb(queue[index].climb, item.climb)) {
      return moveIntoNow(queue, line, hasCurrent, index, 'dedupe-up-next');
    }
  }

  // A forward step onto a climb History already holds puts up a fresh copy:
  // pulling an entry from an hour ago forward would rewrite History and replay
  // the climbs after it with their old entries. The entry right behind is the
  // one Previous just stepped off, so a forward step still takes it back.
  const oldestReusableIndex = historyCopy === 'reuse' ? 0 : Math.max(line - 1, 0);
  for (let index = line - 1; index >= oldestReusableIndex; index--) {
    if (isSameWallClimb(queue[index].climb, item.climb)) {
      return moveIntoNow(queue, line, hasCurrent, index, 'dedupe-history');
    }
  }

  return {
    queue: insertedAt(queue, firstUpNext, item),
    currentClimbQueueItem: item,
    historyCount: firstUpNext,
    rewrite: 'insert',
  };
}

export type CappedHistory<TItem extends NowSlotQueueItem> = NowSlotResolvedState<TItem> & {
  /** How many of the oldest History entries were dropped. */
  trimmedCount: number;
};

/**
 * Trim History, oldest first (section 5). When History has reached
 * {@link HISTORY_TRIM_AT} entries it is cut to the newest
 * {@link HISTORY_KEEP_COUNT}. Then, when History + Up next plus `headroom`
 * more entries would pass `MAX_SYNCED_QUEUE_ITEMS`, more History goes. The
 * climb on the wall is not counted ({@link historyAndUpNextCount}), so the
 * array can hold `MAX_SYNCED_QUEUE_ITEMS + 1` entries while a climb is current.
 * The current climb and Up next are never trimmed, so the result can still be
 * over the cap: check {@link isUpNextFull}.
 *
 * After `setCurrentClimb(null)` the cleared climb is History's newest entry,
 * so it is the last History entry to go: with History otherwise empty and Up
 * next at 500, the clear drops the cleared climb itself rather than storing
 * 501 entries with nothing current.
 *
 * `headroom` is the number of entries about to be added (1 before
 * `addQueueItem`); 0 after a placement that already added its entry.
 *
 * Call {@link normaliseOrphanCurrent} first (a `setQueue` / `joinSession`
 * payload): an orphan current climb counts as nothing current, and it is
 * passed through as an orphan.
 */
export function capHistory<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
  headroom = 0,
): CappedHistory<TItem> {
  const line = historyLine(state);
  let trimmedCount = line >= HISTORY_TRIM_AT ? line - HISTORY_KEEP_COUNT : 0;
  const overflow = historyAndUpNextCount(state) - trimmedCount + headroom - MAX_SYNCED_QUEUE_ITEMS;
  if (overflow > 0) trimmedCount = Math.min(line, trimmedCount + overflow);

  return {
    queue: state.queue.slice(trimmedCount),
    currentClimbQueueItem: state.currentClimbQueueItem,
    historyCount: lineAfterDelta(state, { kind: 'trim', count: trimmedCount }),
    trimmedCount,
  };
}

/**
 * The whole-queue payload a new phone sends (`setQueue`, the session seed and
 * re-seed) in now-slot mode: what the server would store for it (section 5).
 * History is trimmed with {@link capHistory}, so History + Up next is at most
 * `MAX_SYNCED_QUEUE_ITEMS` and the climb on the wall is extra (501 entries with
 * a climb current). The server never trims Up next and refuses a payload whose
 * Up next alone passes the cap (`QUEUE_FULL`), so as a last backstop the tail
 * of Up next beyond the cap is dropped here instead of sending a write the
 * server refuses. A payload that already fits comes back with the same array.
 *
 * Legacy mode keeps `clampQueueAroundCurrent` (500 entries in all): a server
 * before F3 refuses 501.
 */
export function clampNowSlotPayload<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
): NowSlotResolvedState<TItem> {
  const capped = capHistory(state);
  const firstUpNext = upNextStart(capped.queue, capped.currentClimbQueueItem, capped.historyCount);
  const upNextOverflow = capped.queue.length - firstUpNext - MAX_SYNCED_QUEUE_ITEMS;
  const queue =
    capped.trimmedCount === 0 && upNextOverflow <= 0
      ? (state.queue as TItem[])
      : upNextOverflow > 0
        ? capped.queue.slice(0, capped.queue.length - upNextOverflow)
        : capped.queue;
  return { queue, currentClimbQueueItem: capped.currentClimbQueueItem, historyCount: capped.historyCount };
}

/**
 * A change to the array, applied as given. `add` and `reorder` indexes are in
 * the final array: for `add` that is the resolved insert index (after
 * {@link clampInsertPosition} or the append fallback), not the wire
 * `position`. `trim` drops the oldest `count` entries; `clear` is
 * `setCurrentClimb(null)`.
 */
export type QueueLineDelta =
  | { kind: 'add'; index: number }
  | { kind: 'remove'; uuid: string }
  | { kind: 'reorder'; oldIndex: number; newIndex: number }
  | { kind: 'trim'; count: number }
  | { kind: 'clear' };

/**
 * The `historyCount` after `delta` (section 1, the line table). The resolvers
 * and the reducer both call it, so a delta can't move the line differently on
 * the two sides. With a climb current the result is its index after the
 * change; with nothing current (or an orphan):
 *
 * | Change                     | `historyCount`                              |
 * | -------------------------- | ------------------------------------------- |
 * | add at p                   | +1 when p < line                            |
 * | remove at i                | −1 when i < line                            |
 * | reorder i → j              | −1 when i < line ≤ j, +1 when j < line ≤ i  |
 * | trim n                     | −n                                          |
 * | removing the current climb | its index                                   |
 * | `setCurrentClimb(null)`    | the cleared climb's index + 1               |
 *
 * Always within `[0, queue.length]` of the array after the change.
 */
export function lineAfterDelta<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
  delta: QueueLineDelta,
): number {
  const currentIndex = currentIndexOf(state.queue, state.currentClimbQueueItem);
  const hasCurrent = currentIndex >= 0;
  const line = historyLine(state);
  const queueLength = state.queue.length;

  switch (delta.kind) {
    case 'add': {
      // An out-of-range index appends, as `insertQueueItemIdempotent` does.
      const addedIndex = delta.index >= 0 && delta.index <= queueLength ? delta.index : queueLength;
      if (hasCurrent) return addedIndex <= currentIndex ? currentIndex + 1 : currentIndex;
      return addedIndex < line ? line + 1 : line;
    }
    case 'remove': {
      const removedIndex = state.queue.findIndex((queueItem) => queueItem.uuid === delta.uuid);
      if (removedIndex === -1) return line;
      // Removing the current climb leaves History as everything before it.
      if (removedIndex === currentIndex) return currentIndex;
      return removedIndex < line ? line - 1 : line;
    }
    case 'reorder': {
      const { oldIndex, newIndex } = delta;
      if (oldIndex < 0 || oldIndex >= queueLength || newIndex < 0 || newIndex >= queueLength) return line;
      if (hasCurrent) {
        if (oldIndex === currentIndex) return newIndex;
        const indexWithoutMoved = oldIndex < currentIndex ? currentIndex - 1 : currentIndex;
        return newIndex <= indexWithoutMoved ? indexWithoutMoved + 1 : indexWithoutMoved;
      }
      if (oldIndex < line && line <= newIndex) return line - 1;
      if (newIndex < line && line <= oldIndex) return line + 1;
      return line;
    }
    case 'trim':
      return Math.max(line - Math.min(Math.max(delta.count, 0), queueLength), 0);
    case 'clear':
      return hasCurrent ? currentIndex + 1 : line;
  }
}

export type ReorderAcrossLine<TItem extends NowSlotQueueItem> = NowSlotResolvedState<TItem> & {
  /** The index the entry ends up at, after any clamp. */
  newIndex: number;
  /** An Up next entry dragged above the line was held at the head of Up next. */
  clamped: boolean;
};

/**
 * The reorder rule the `reorderQueueItem` resolver (inside the percent) and a
 * new phone's own drag apply. With nothing current, an Up next entry dragged
 * above the line is clamped to the head of Up next, keeping a shipped phone's
 * intent (it sees one flat Up next list) instead of filing it under History; a
 * History entry dragged below the line joins Up next. The line then moves by
 * {@link lineAfterDelta}. Returns `null` for an out-of-range index, which the
 * reducer and the resolver both ignore.
 */
export function reorderAcrossLine<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
  oldIndex: number,
  newIndex: number,
): ReorderAcrossLine<TItem> | null {
  const queueLength = state.queue.length;
  if (oldIndex < 0 || oldIndex >= queueLength || newIndex < 0 || newIndex >= queueLength) return null;

  const hasCurrent = currentIndexOf(state.queue, state.currentClimbQueueItem) >= 0;
  const line = historyLine(state);
  const clamped = !hasCurrent && oldIndex >= line && newIndex < line;
  const targetIndex = clamped ? line : newIndex;

  const nextQueue = [...state.queue];
  const [movedItem] = nextQueue.splice(oldIndex, 1);
  nextQueue.splice(targetIndex, 0, movedItem);

  return {
    queue: nextQueue,
    currentClimbQueueItem: state.currentClimbQueueItem,
    historyCount: lineAfterDelta(state, { kind: 'reorder', oldIndex, newIndex: targetIndex }),
    newIndex: targetIndex,
    clamped,
  };
}

/**
 * Where an `addQueueItem` lands (section 5). No position, or one out of range,
 * appends, as `insertQueueItemIdempotent` does. A position inside History is
 * honoured while a climb is current, as today. With nothing current it is
 * clamped to the line, so a shipped Play next sent at position 0 lands at the
 * head of Up next (S16). Resolver only, inside the percent: the reducer applies
 * positions as given. The resolver publishes a `FullSync` after the add when
 * `clamped`.
 */
export function clampInsertPosition<TItem extends NowSlotQueueItem>(
  state: NowSlotState<TItem>,
  position?: number | null,
): { index: number; clamped: boolean } {
  const queueLength = state.queue.length;
  if (position == null || position < 0 || position > queueLength) return { index: queueLength, clamped: false };
  if (currentIndexOf(state.queue, state.currentClimbQueueItem) >= 0) return { index: position, clamped: false };
  const line = historyLine(state);
  return position < line ? { index: line, clamped: true } : { index: position, clamped: false };
}

/**
 * The line for a client-sent `setQueue(historyCount:)` or
 * `joinSession(initialHistoryCount:)` (section 2). The resolver validates the
 * input with `QueueIndexSchema` first; this is the clamp after it.
 *
 * - The current climb is in `queue`: the input is ignored and the line is the
 *   current index.
 * - Otherwise (nothing current, or a payload orphan): the input clamped to
 *   `[0, queue.length]`. For an orphan it is the index
 *   {@link normaliseOrphanCurrent} inserts it at.
 * - No usable input: `null`, and the caller derives the line from the stored
 *   History (section 3).
 *
 * A buggy client can't send 9999 or −3 and empty everyone's Up next.
 */
export function normaliseHistoryCount<TItem extends NowSlotQueueItem>(
  input: number | null | undefined,
  queue: readonly TItem[],
  current: TItem | null,
): number | null {
  const currentIndex = currentIndexOf(queue, current);
  if (currentIndex >= 0) return currentIndex;
  if (input == null || !Number.isFinite(input)) return null;
  return clampLine(input, queue.length);
}

/**
 * What a `setCurrentClimb` request carried. `placement` present marks a new
 * client; `shouldAddToQueue` absent with no placement is the native socket.
 */
export type NowSlotRequest = {
  item: { uuid: string } | null;
  shouldAddToQueue?: boolean | null;
  placement?: CurrentClimbPlacement | null;
};

/**
 * - `pointer`: one `CurrentClimbChanged` with the origin's `clientId` and
 *   `correlationId`, as today.
 * - `fullsync`: one `FullSync`, as today for an insert. Also every clear that
 *   reshapes the array: with nothing current there is no climb to repaint.
 * - `fullsync+trailing`: a `FullSync`, then a `CurrentClimbChanged` for the new
 *   current climb under the same sequence, with the origin's `clientId`,
 *   `correlationId: null` and outside the replay buffer, so the native socket
 *   still repaints the wall.
 */
export type NowSlotQueueEvent = 'pointer' | 'fullsync' | 'fullsync+trailing';

function sameUuids(left: readonly NowSlotQueueItem[], right: readonly NowSlotQueueItem[]): boolean {
  return left.length === right.length && left.every((queueItem, index) => queueItem.uuid === right[index].uuid);
}

/**
 * Which event to publish for a `setCurrentClimb` (section 2). A check, not a
 * table: it compares the stored state before the write with the state after
 * it (trim included), so a pointer event is only chosen when a shipped reducer
 * moving its pointer to the named uuid gets exactly the stored array and
 * current climb.
 *
 * | Case                                                                       | Event               |
 * | -------------------------------------------------------------------------- | ------------------- |
 * | uuid already queued, array unchanged, the new current is the request's item | `pointer`          |
 * | `item: null`, array unchanged (a shipped reducer clears and keeps it)      | `pointer`           |
 * | `item: null` that reshapes (a trim, an orphan normalised): nothing to repaint | `fullsync`       |
 * | the request's item inserted at the Now slot, `shouldAddToQueue` or placement | `fullsync`        |
 * | the same insert without either (the native socket's stale item)            | `fullsync+trailing` |
 * | anything else (`move-*`, `dedupe-*`, `next-from-line`, a trim, an orphan)  | `fullsync+trailing` |
 */
export function chooseQueueEvent<TItem extends NowSlotQueueItem>(
  before: NowSlotState<TItem>,
  request: NowSlotRequest,
  after: NowSlotState<TItem>,
): NowSlotQueueEvent {
  const requestUuid = request.item?.uuid ?? null;

  // A clear has no climb to repaint (section 5). When it reshapes the array (a
  // trim, an orphan normalised) it is a plain FullSync: the native socket sets
  // its index to 0 on a FullSync with nothing current, and a trailing
  // CurrentClimbChanged(null) would repaint the wall from that index, lighting
  // an unrelated climb (SessionWebSocketManager.swift persistAndNotify).
  if (requestUuid === null) {
    return !isOrphanCurrent(before) && after.currentClimbQueueItem === null && sameUuids(before.queue, after.queue)
      ? 'pointer'
      : 'fullsync';
  }

  // A stored orphan is normalised by this write, so the array changes in a way
  // no shipped reducer predicts.
  if (isOrphanCurrent(before)) return 'fullsync+trailing';

  const afterCurrentUuid = after.currentClimbQueueItem?.uuid ?? null;
  const lightsRequest = afterCurrentUuid === requestUuid;

  if (lightsRequest && sameUuids(before.queue, after.queue)) {
    if (before.queue.some((queueItem) => queueItem.uuid === requestUuid)) return 'pointer';
  }

  if (lightsRequest && after.queue.length === before.queue.length + 1) {
    const insertIndex = upNextStart(before.queue, before.currentClimbQueueItem, before.historyCount);
    const insertedAtNowSlot =
      after.queue[insertIndex]?.uuid === requestUuid && sameUuids(before.queue, withoutIndex(after.queue, insertIndex));
    if (insertedAtNowSlot) {
      return request.shouldAddToQueue === true || request.placement != null ? 'fullsync' : 'fullsync+trailing';
    }
  }

  return 'fullsync+trailing';
}
