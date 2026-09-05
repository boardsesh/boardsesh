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

  it('peeks the list successor even when a different queue item follows', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const items = [itemFor(x), makeItem('mid')];
    const source = makeSource(x, [x, y]);
    // Current is on the list, so the list wins over the unrelated queue
    // successor (issue #4829: the queue holds leftovers from other lists).
    const peek = findNextQueueItemWithSuggestions(items, items[0], source);
    expect(peek?.climb.uuid).toBe('y');
    expect(peek?.uuid).toBe(getPlaylistPeekQueueItemUuid('y'));
    expect(peek?.suggested).toBe(true);
  });

  it('returns the existing queue item when the list successor already follows current', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const queue = [itemFor(x), itemFor(y)];
    const source = makeSource(x, [x, y]);
    expect(findNextQueueItemWithSuggestions(queue, queue[0], source)).toBe(queue[1]);
  });

  it('returns the existing queue item when the list successor sits BEFORE current', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    // A committed previous-peek lands after the current item locally (the
    // server always inserts after current), so the list successor of the new
    // current `x` is at currentIndex - 1.
    const queue = [itemFor(y), itemFor(x)];
    const source = makeSource(x, [x, y]);
    expect(findNextQueueItemWithSuggestions(queue, queue[1], source)).toBe(queue[0]);
  });

  it('falls back to the queue successor at the end of the list', () => {
    const x = makeClimb('x');
    const leftover = makeItem('leftover');
    const queue = [itemFor(x), leftover];
    const source = makeSource(x, [x]); // x is last on the list
    expect(findNextQueueItemWithSuggestions(queue, queue[0], source)).toBe(leftover);
  });

  it('walks the queue for a current climb that is not on the list', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const offList = makeItem('off-list');
    const queue = [offList, itemFor(x)];
    const source = makeSource(x, [x, y]);
    expect(findNextQueueItemWithSuggestions(queue, queue[0], source)).toBe(queue[1]);
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

  it('peeks the list predecessor at the queue head', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    // Current is the queue head with no queue predecessor, but it IS on the
    // list — swiping back walks the list (issue #4829).
    const queue = [itemFor(y)];
    const source = makeSource(x, [x, y]);
    const peek = findPreviousQueueItemWithSuggestions(queue, queue[0], source);
    expect(peek?.climb.uuid).toBe('x');
    expect(peek?.uuid).toBe(getPlaylistPeekQueueItemUuid('x'));
    expect(peek?.suggested).toBe(true);
  });

  it('returns the existing queue item when the list predecessor already precedes current', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const queue = [itemFor(x), itemFor(y)];
    const source = makeSource(x, [x, y]);
    expect(findPreviousQueueItemWithSuggestions(queue, queue[1], source)).toBe(queue[0]);
  });

  it('returns the existing queue item when the list predecessor sits AFTER current', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    // A committed next-peek lands after the current item, so after swiping back
    // onto `y` the list predecessor `x` is at currentIndex + 1.
    const queue = [itemFor(y), itemFor(x)];
    const source = makeSource(x, [x, y]);
    expect(findPreviousQueueItemWithSuggestions(queue, queue[0], source)).toBe(queue[1]);
  });

  it('falls back to the queue predecessor at the start of the list', () => {
    const x = makeClimb('x');
    const leftover = makeItem('leftover');
    const queue = [leftover, itemFor(x)];
    const source = makeSource(x, [x]); // x is first on the list
    expect(findPreviousQueueItemWithSuggestions(queue, queue[1], source)).toBe(leftover);
  });

  it('walks the queue for a current climb that is not on the list', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const offList = makeItem('off-list');
    const queue = [itemFor(x), offList];
    const source = makeSource(x, [x, y]);
    expect(findPreviousQueueItemWithSuggestions(queue, queue[1], source)).toBe(queue[0]);
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
    // Non-empty queue too: an orphan never falls back to a queue neighbour.
    expect(findPreviousQueueItemWithSuggestions([makeItem('a'), makeItem('b')], orphan, source)).toBeNull();
  });

  it('returns null for an orphan current when there is no source at all', () => {
    const orphan = itemFor(makeClimb('orphan'));
    expect(findPreviousQueueItemWithSuggestions([makeItem('a')], orphan, null)).toBeNull();
  });
});

// Issue #4829: the queue is cross-board and accumulates browse history, so
// swipes must walk the list the current climb was opened from.
describe('list-first swipes across a mixed-board queue (#4829)', () => {
  const kilter1 = makeClimb('K1');
  const kilter2 = makeClimb('K2');
  const kilter3 = makeClimb('K3');
  const woods0 = makeClimb('W0');
  const woods1 = makeClimb('W1');
  const woods2 = makeClimb('W2');
  const woodsSource = makeSource(woods1, [woods0, woods1, woods2]);

  it('walks the Woods list from a climb inserted into the middle of a Kilter queue', () => {
    // Tapping W1 from the Woods list inserts it after the current item.
    const queue = [itemFor(kilter1), itemFor(woods1), itemFor(kilter2), itemFor(kilter3)];
    const current = queue[1];

    const next = findNextQueueItemWithSuggestions(queue, current, woodsSource);
    expect(next?.climb.uuid).toBe('W2');
    expect(next?.suggested).toBe(true);

    const prev = findPreviousQueueItemWithSuggestions(queue, current, woodsSource);
    expect(prev?.climb.uuid).toBe('W0');
    expect(prev?.suggested).toBe(true);
  });

  it('swipes back to the Woods predecessor, not the Kilter climb before it', () => {
    const queue = [itemFor(kilter1), itemFor(kilter2), itemFor(kilter3), itemFor(woods1)];
    const prev = findPreviousQueueItemWithSuggestions(queue, queue[3], woodsSource);
    expect(prev?.climb.uuid).toBe('W0');
  });

  it('walks back onto the committed peek without duplicating it', () => {
    // Swiping back from W1 commits W0. The server always inserts after the
    // current item (and mobile verifies the ORDERED queue hash), so the local
    // queue becomes [K1, W1, W0, K2] with W0 current — its list successor W1
    // sits at currentIndex - 1.
    const committedW0 = itemFor(woods0);
    const queue = [itemFor(kilter1), itemFor(woods1), committedW0, itemFor(kilter2)];
    const next = findNextQueueItemWithSuggestions(queue, committedW0, woodsSource);
    expect(next).toBe(queue[1]);
    expect(next?.uuid).not.toBe(getPlaylistPeekQueueItemUuid('W1'));
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
    // `x` is first in the list and first in the queue, so there is nothing to
    // swipe back to on either side; remainingCount stays queue-based.
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
    expect(state.remainingCount).toBe(0);
  });

  it('lights up canPrevious from the list predecessor for a queued climb mid-list (#4829)', () => {
    const w0 = makeClimb('w0');
    const w1 = makeClimb('w1');
    const w2 = makeClimb('w2');
    // Opened `w1` from a Woods list; the queue only holds it (plus history from
    // another board before it). Both directions come from the list.
    const queue = [makeItem('k3'), itemFor(w1)];
    const source = makeSource(w1, [w0, w1, w2]);
    const state = computeNavigationStateWithSuggestions(queue, queue[1], source);
    expect(state.canPrevious).toBe(true);
    expect(state.prevItem?.climb.uuid).toBe('w0');
    expect(state.prevItem?.suggested).toBe(true);
    expect(state.canNext).toBe(true);
    expect(state.nextItem?.climb.uuid).toBe('w2');
    // Queue-based: nothing after `w1` in the queue.
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
