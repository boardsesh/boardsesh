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
  it('returns the real previous queue item when one exists', () => {
    const previous = makeClimb('source-previous');
    const current = makeClimb('current');
    const queue = [itemFor(makeClimb('queued-previous')), itemFor(current)];
    const source = makeSource(current, [previous, current]);
    expect(findPreviousQueueItemWithSuggestions(queue, queue[1], source)).toBe(queue[0]);
  });

  it('falls back to the previous playlist climb when the queue has no previous item', () => {
    const previous = makeClimb('previous');
    const current = makeClimb('current');
    const queue = [itemFor(current)];
    const source = makeSource(current, [previous, current]);
    const peek = findPreviousQueueItemWithSuggestions(queue, queue[0], source);
    expect(peek?.uuid).toBe(getPlaylistPeekQueueItemUuid(previous.uuid));
    expect(peek?.climb.uuid).toBe('previous');
    expect(peek?.suggested).toBe(true);
  });

  it('falls back to the previous playlist climb for an orphan current item', () => {
    const previous = makeClimb('previous');
    const current = makeClimb('current');
    const orphan = itemFor(current);
    const source = makeSource(current, [previous, current]);
    const peek = findPreviousQueueItemWithSuggestions([], orphan, source);
    expect(peek?.climb.uuid).toBe('previous');
  });

  it('returns null when the current playlist climb is first', () => {
    const current = makeClimb('current');
    const next = makeClimb('next');
    const queue = [itemFor(current)];
    const source = makeSource(current, [current, next]);
    expect(findPreviousQueueItemWithSuggestions(queue, queue[0], source)).toBeNull();
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
    // No earlier playlist item, so previous stays unavailable.
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
    expect(state.remainingCount).toBe(0);
  });

  it('lights up canPrevious from a suggestion at the start of the queue', () => {
    const previous = makeClimb('previous');
    const current = makeClimb('current');
    const queue = [itemFor(current)];
    const source = makeSource(current, [previous, current]);
    const state = computeNavigationStateWithSuggestions(queue, queue[0], source);
    expect(state.canPrevious).toBe(true);
    expect(state.prevItem?.climb.uuid).toBe('previous');
    expect(state.prevItem?.suggested).toBe(true);
    expect(state.canNext).toBe(false);
    expect(state.remainingCount).toBe(0);
  });
});
