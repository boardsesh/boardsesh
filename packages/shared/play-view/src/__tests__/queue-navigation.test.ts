import { describe, it, expect } from 'vitest';
import type { Climb, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import { getPlaylistPeekQueueItemUuid } from '@boardsesh/queue';
import {
  findNextQueueItem,
  findPreviousQueueItem,
  computeNavigationState,
  findNextQueueItemWithSuggestions,
  findPreviousQueueItemWithSuggestions,
  computeNavigationStateWithSuggestions,
  selectNextQueueItemWithSuggestions,
} from '../queue-navigation';

function makeClimb(uuid: string): Climb {
  return {
    uuid,
    name: `Climb ${uuid}`,
    frames: '',
    setter_username: 'test',
    angle: 40,
    ascensionist_count: 0,
    difficulty: '6a/V3',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0',
    benchmark_difficulty: null,
  };
}

function makeItem(uuid: string): ClimbQueueItem {
  return { uuid, climb: makeClimb(`climb-${uuid}`) };
}

// Build a queue item that wraps a specific climb (so queued-climb dedup against
// a suggestion source works on climb.uuid).
function itemFor(climb: Climb): ClimbQueueItem {
  return { uuid: `item-${climb.uuid}`, climb };
}

function makeSource(activatedClimb: Climb, climbs: Climb[]): PlaylistSuggestionSource {
  return {
    playlistUuid: 'pl-1',
    activatedClimbUuid: activatedClimb.uuid,
    boardKey: 'kilter:1:1:1',
    climbs,
  };
}

describe('findNextQueueItem', () => {
  it('returns null for an empty queue', () => {
    expect(findNextQueueItem([], null)).toBeNull();
  });

  it('returns the first item when there is no current item', () => {
    const items = [makeItem('a'), makeItem('b')];
    expect(findNextQueueItem(items, null)).toBe(items[0]);
  });

  it('returns the next item after the current one', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    expect(findNextQueueItem(items, items[0])).toBe(items[1]);
    expect(findNextQueueItem(items, items[1])).toBe(items[2]);
  });

  it('returns null when the current item is at the end', () => {
    const items = [makeItem('a'), makeItem('b')];
    expect(findNextQueueItem(items, items[1])).toBeNull();
  });
});

describe('findPreviousQueueItem', () => {
  it('returns null for an empty queue', () => {
    expect(findPreviousQueueItem([], null)).toBeNull();
  });

  it('returns null when there is no current item', () => {
    const items = [makeItem('a'), makeItem('b')];
    expect(findPreviousQueueItem(items, null)).toBeNull();
  });

  it('returns the previous item before the current one', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    expect(findPreviousQueueItem(items, items[2])).toBe(items[1]);
    expect(findPreviousQueueItem(items, items[1])).toBe(items[0]);
  });

  it('returns null when the current item is at the start', () => {
    const items = [makeItem('a'), makeItem('b')];
    expect(findPreviousQueueItem(items, items[0])).toBeNull();
  });
});

describe('computeNavigationState', () => {
  it('returns correct state for an empty queue', () => {
    const state = computeNavigationState([], null);
    expect(state).toEqual({
      canNext: false,
      canPrevious: false,
      nextItem: null,
      prevItem: null,
      remainingCount: 0,
    });
  });

  it('returns correct state for a single item', () => {
    const items = [makeItem('a')];
    const state = computeNavigationState(items, items[0]);
    expect(state).toEqual({
      canNext: false,
      canPrevious: false,
      nextItem: null,
      prevItem: null,
      remainingCount: 0,
    });
  });

  it('returns correct state for the middle of a queue', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    const state = computeNavigationState(items, items[1]);
    expect(state.canNext).toBe(true);
    expect(state.canPrevious).toBe(true);
    expect(state.nextItem).toBe(items[2]);
    expect(state.prevItem).toBe(items[0]);
    expect(state.remainingCount).toBe(1);
  });

  it('returns correct state when current item is not in queue', () => {
    const items = [makeItem('a'), makeItem('b')];
    const orphan = makeItem('not-in-queue');
    const state = computeNavigationState(items, orphan);
    // currentIndex will be -1, so remainingCount = queue.length
    expect(state.remainingCount).toBe(2);
    // findNextQueueItem with an item not in queue: currentIndex is -1, nextIndex is 0
    expect(state.canNext).toBe(true);
    expect(state.nextItem).toBe(items[0]);
    // findPreviousQueueItem with an item not in queue: prevIndex is -2
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
  });
});

describe('findNextQueueItemWithSuggestions', () => {
  it('behaves like findNextQueueItem when source is null', () => {
    const items = [makeItem('a'), makeItem('b')];
    expect(findNextQueueItemWithSuggestions(items, items[0], null)).toBe(items[1]);
    expect(findNextQueueItemWithSuggestions(items, items[1], null)).toBeNull();
    expect(findNextQueueItemWithSuggestions([], null, null)).toBeNull();
    expect(findNextQueueItemWithSuggestions(items, null, null)).toBe(items[0]);
  });

  it('returns the real next queue item (not a peek) when the queue is not exhausted', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const items = [itemFor(x), makeItem('mid')];
    const source = makeSource(x, [x, y]);
    // current is at index 0 with a real next item → return that, ignore suggestions.
    expect(findNextQueueItemWithSuggestions(items, items[0], source)).toBe(items[1]);
  });

  it('falls through to a suggestion peek when the queue is exhausted', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const z = makeClimb('z');
    const queue = [itemFor(x)];
    const source = makeSource(x, [x, y, z]);
    const peek = findNextQueueItemWithSuggestions(queue, queue[0], source);
    expect(peek).not.toBeNull();
    expect(peek?.climb.uuid).toBe('y');
    expect(peek?.uuid).toBe(getPlaylistPeekQueueItemUuid('y'));
    expect(peek?.suggested).toBe(true);
    expect(peek?.addedBy).toBeNull();
  });

  it('returns null when the queue is exhausted and no suggestion remains', () => {
    const x = makeClimb('x');
    const queue = [itemFor(x)];
    const source = makeSource(x, [x]); // nothing after the activated climb
    expect(findNextQueueItemWithSuggestions(queue, queue[0], source)).toBeNull();
  });

  it('peeks the first suggestion for an empty queue with no current item', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const source = makeSource(x, [x, y]);
    const peek = findNextQueueItemWithSuggestions([], null, source);
    expect(peek?.climb.uuid).toBe('y');
    expect(peek?.suggested).toBe(true);
  });

  it('falls through to suggestions for an orphan current (not in queue)', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const queue = [makeItem('a'), makeItem('b')];
    const orphan = itemFor(x); // current climb not present in the queue
    const source = makeSource(x, [x, y]);
    const peek = findNextQueueItemWithSuggestions(queue, orphan, source);
    // Diverges from findNextQueueItem (which would return queue[0]).
    expect(peek?.climb.uuid).toBe('y');
    expect(peek?.suggested).toBe(true);
  });

  it('returns the playlist climb after the CURRENT climb (not the activated one)', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const z = makeClimb('z');
    const queue = [itemFor(x), itemFor(y)];
    const source = makeSource(x, [x, y, z]);
    // current is y (tail of queue) → next playlist climb after y is z.
    const peek = findNextQueueItemWithSuggestions(queue, queue[1], source);
    expect(peek?.climb.uuid).toBe('z');
  });

  it('re-walks the playlist on re-activation, even when climbs are already queued', () => {
    const a = makeClimb('a');
    const b = makeClimb('b');
    const c = makeClimb('c');
    // Whole playlist already swiped into the queue, then `a` re-activated and
    // appended at the tail (fresh queue uuid, same climb).
    const reactivatedA: ClimbQueueItem = { uuid: 'item-reactivated-a', climb: a };
    const queue = [itemFor(a), itemFor(b), itemFor(c), reactivatedA];
    const source = makeSource(a, [a, b, c]);
    // Next after the current `a` is `b` — even though `b` is already in the queue
    // (a second pass appends 1..N again, rather than jumping to an un-queued one).
    const peek = findNextQueueItemWithSuggestions(queue, reactivatedA, source);
    expect(peek?.climb.uuid).toBe('b');
    expect(peek?.suggested).toBe(true);
  });
});

describe('findPreviousQueueItemWithSuggestions', () => {
  it('behaves like findPreviousQueueItem for a current item that IS in the queue', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    expect(findPreviousQueueItemWithSuggestions(items, items[2], null)).toBe(items[1]);
    expect(findPreviousQueueItemWithSuggestions(items, items[0], null)).toBeNull();
    expect(findPreviousQueueItemWithSuggestions(items, null, null)).toBeNull();
  });

  it('never peeks backward into the playlist while the current item is in the queue', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    // current is the queue head and there IS an earlier playlist climb, but the
    // committed active-board path must stay queue-only (no backward peek).
    const queue = [itemFor(y)];
    const source = makeSource(x, [x, y]);
    expect(findPreviousQueueItemWithSuggestions(queue, queue[0], source)).toBeNull();
  });

  it('falls through to the previous playlist climb for an orphan current (view-only preview)', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const z = makeClimb('z');
    const queue = [makeItem('a'), makeItem('b')];
    const orphan = itemFor(y); // previewed climb, never committed to the queue
    const source = makeSource(x, [x, y, z]);
    const peek = findPreviousQueueItemWithSuggestions(queue, orphan, source);
    // Diverges from findPreviousQueueItem (which would return null).
    expect(peek?.climb.uuid).toBe('x');
    expect(peek?.uuid).toBe(getPlaylistPeekQueueItemUuid('x'));
    expect(peek?.suggested).toBe(true);
    expect(peek?.addedBy).toBeNull();
  });

  it('returns null for an orphan current that is first in the playlist', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const orphan = itemFor(x); // x is the first playlist climb → nothing before it
    const source = makeSource(x, [x, y]);
    expect(findPreviousQueueItemWithSuggestions([], orphan, source)).toBeNull();
  });

  it('returns null for an orphan current not in the playlist at all', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const orphan = itemFor(makeClimb('not-in-playlist'));
    const source = makeSource(x, [x, y]);
    expect(findPreviousQueueItemWithSuggestions([], orphan, source)).toBeNull();
  });
});

describe('computeNavigationStateWithSuggestions', () => {
  it('matches computeNavigationState when source is null', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    expect(computeNavigationStateWithSuggestions(items, items[1], null)).toEqual(
      computeNavigationState(items, items[1]),
    );
  });

  it('lights up canNext from a suggestion at the end of the queue', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const queue = [itemFor(x)];
    const source = makeSource(x, [x, y]);
    const state = computeNavigationStateWithSuggestions(queue, queue[0], source);
    expect(state.canNext).toBe(true);
    expect(state.nextItem?.climb.uuid).toBe('y');
    expect(state.nextItem?.suggested).toBe(true);
    // For a queued current climb, previous + remainingCount stay queue-based.
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
    expect(state.remainingCount).toBe(0);
  });

  it('lights up both directions for a view-only preview (orphan current in the playlist)', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const z = makeClimb('z');
    // The wrong-board preview shows `y` without committing it to the queue.
    const orphan = itemFor(y);
    const source = makeSource(x, [x, y, z]);
    const state = computeNavigationStateWithSuggestions([], orphan, source);
    expect(state.canNext).toBe(true);
    expect(state.nextItem?.climb.uuid).toBe('z');
    expect(state.canPrevious).toBe(true);
    expect(state.prevItem?.climb.uuid).toBe('x');
    expect(state.prevItem?.suggested).toBe(true);
  });
});

// --- Board-aware forward navigation (issue #5099) ---------------------------
//
// After a board switch the queue still holds the previous board's climbs. A
// forward swipe must walk past them instead of handing back a climb that draws
// nothing on screen and lights nothing on the wall.

const TENSION_BOARD = { boardName: 'tension' as const, layoutId: 8 };

function climbOnBoard(uuid: string, boardType: string, layoutId: number): Climb {
  return { ...makeClimb(uuid), boardType, layoutId };
}

function queueItemOnBoard(uuid: string, boardType: string, layoutId: number): ClimbQueueItem {
  return { uuid: `item-${uuid}`, climb: climbOnBoard(uuid, boardType, layoutId) };
}

describe('selectNextQueueItemWithSuggestions board awareness', () => {
  it('skips queued climbs the active board cannot draw and reports how many', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('kilter-2', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD);
    expect(selection.item?.uuid).toBe('item-tension-2');
    expect(selection.skippedItems.map((item) => item.uuid)).toEqual(['item-kilter-1', 'item-kilter-2']);
  });

  it('never skips a climb with no board metadata (fails open)', () => {
    const queue = [queueItemOnBoard('current', 'tension', 8), makeItem('unknown')];
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD);
    expect(selection.item).toBe(queue[1]);
    expect(selection.skippedItems).toEqual([]);
  });

  it('never skips anything when no active board is supplied', () => {
    const queue = [queueItemOnBoard('current', 'tension', 8), queueItemOnBoard('kilter-1', 'kilter', 1)];
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null);
    expect(selection.item).toBe(queue[1]);
    expect(selection.skippedItems).toEqual([]);
  });

  it('never skips a same-layout different-size climb (identity matching only)', () => {
    // Woods 8x10 vs 12x12: same board name + layout, different size. Those still
    // render — on the correctly sized board — so they must stay swipe targets.
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      { uuid: 'item-upsized', climb: { ...climbOnBoard('upsized', 'tension', 8), compatibleSizeIds: [99] } },
    ];
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD);
    expect(selection.item?.uuid).toBe('item-upsized');
    expect(selection.skippedItems).toEqual([]);
  });

  it('falls through to the suggestion feed when the whole tail is off-board', () => {
    // The exact #5099 shape: every remaining queued climb belongs to the board
    // the climber left, so `next` must re-anchor onto the feed rather than
    // returning null and dead-ending the swipe.
    const anchor = climbOnBoard('current', 'tension', 8);
    const feedClimb = climbOnBoard('feed-1', 'tension', 8);
    const queue = [
      itemFor(anchor),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('kilter-2', 'kilter', 1),
    ];
    const source = makeSource(anchor, [anchor, feedClimb]);
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], source, TENSION_BOARD);
    expect(selection.item?.climb.uuid).toBe('feed-1');
    expect(selection.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('feed-1'));
    expect(selection.skippedItems).toHaveLength(2);
  });

  it('returns no item when the tail is off-board and there is no feed to fall back on', () => {
    const queue = [queueItemOnBoard('current', 'tension', 8), queueItemOnBoard('kilter-1', 'kilter', 1)];
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD);
    expect(selection.item).toBeNull();
    expect(selection.skippedItems).toHaveLength(1);
  });

  it('skips from the head of the queue when there is no current item', () => {
    const queue = [queueItemOnBoard('kilter-1', 'kilter', 1), queueItemOnBoard('tension-1', 'tension', 8)];
    const selection = selectNextQueueItemWithSuggestions(queue, null, null, TENSION_BOARD);
    expect(selection.item?.uuid).toBe('item-tension-1');
    expect(selection.skippedItems.map((item) => item.uuid)).toEqual(['item-kilter-1']);
  });

  it('leaves the suggestion branch board-blind (the wrong-board preview relies on it)', () => {
    // The play drawer feeds a preview source that is bound to another board on
    // purpose. Filtering here would break that read-only browse.
    const previewClimb = climbOnBoard('kilter-preview', 'kilter', 1);
    const nextPreviewClimb = climbOnBoard('kilter-next', 'kilter', 1);
    const source = makeSource(previewClimb, [previewClimb, nextPreviewClimb]);
    const selection = selectNextQueueItemWithSuggestions([], itemFor(previewClimb), source, TENSION_BOARD);
    expect(selection.item?.climb.uuid).toBe('kilter-next');
    expect(selection.skippedItems).toEqual([]);
  });
});

describe('computeNavigationStateWithSuggestions board awareness', () => {
  it('points canNext at the climb the swipe actually lands on', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];
    const state = computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD);
    expect(state.canNext).toBe(true);
    expect(state.nextItem?.uuid).toBe('item-tension-2');
  });

  it('counts only the climbs a swipe can still reach in remainingCount', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('kilter-2', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];
    // Three rows sit after the current one, but only one is a swipe target.
    expect(computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD).remainingCount).toBe(1);
  });

  it('keeps the plain remaining count for a board-blind caller', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];
    expect(computeNavigationStateWithSuggestions(queue, queue[0], null).remainingCount).toBe(2);
    expect(computeNavigationState(queue, queue[0]).remainingCount).toBe(2);
  });

  it('counts an off-board current climb from the head of the tail', () => {
    const queue = [
      queueItemOnBoard('kilter-current', 'kilter', 1),
      queueItemOnBoard('tension-1', 'tension', 8),
      queueItemOnBoard('kilter-2', 'kilter', 1),
    ];
    expect(computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD).remainingCount).toBe(1);
  });

  it('leaves backward navigation alone', () => {
    const queue = [
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-2', 'kilter', 1),
    ];
    const state = computeNavigationStateWithSuggestions(queue, queue[1], null, TENSION_BOARD);
    expect(state.prevItem?.uuid).toBe('item-kilter-1');
    expect(state.canPrevious).toBe(true);
  });
});
