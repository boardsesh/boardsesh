import { describe, it, expect, vi } from 'vitest';
import type { Climb, ClimbQueue, ClimbQueueItem, PlaylistSuggestionSource } from '@boardsesh/queue';
import {
  getPlaylistPeekQueueItemUuid,
  createPlaylistSuggestionSource,
  preparePlaylistClimbs,
  withPlaylistTrackResume,
} from '@boardsesh/queue';
import {
  findNextQueueItem,
  prepareQueueNavigation,
  computeNavigationTargetsWithSuggestions,
  countRemainingQueueItemsWithSuggestions,
  findPreviousQueueItem,
  computeNavigationState,
  findNextQueueItemWithSuggestions,
  findPreviousQueueItemWithSuggestions,
  computeNavigationStateWithSuggestions,
  findUpcomingQueueItemsWithSuggestions,
  selectNextQueueItemWithSuggestions,
  selectPreviousQueueItemWithSuggestions,
  resolveNavigationSuggestionSource,
  resolveTrackListClimbUuid,
  resolveTrackPosition,
  resolveUpNextProgress,
  resolveUpNextCommitResume,
  anchoredSuggestionSource,
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
      atTrackEnd: false,
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
      atTrackEnd: false,
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

  it('plays a deliberately added queue item before the list successor (#6777)', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    // `added` is a plain Play next / Play last item (not suggested) sitting
    // right after the current climb. Up next plays before the list goes on.
    const added = makeItem('added');
    expect(added.suggested).toBeUndefined();
    const items = [itemFor(x), added];
    const source = makeSource(x, [x, y]);
    expect(findNextQueueItemWithSuggestions(items, items[0], source)).toBe(added);
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

  it('plays what is queued after the last list climb before the list ends (#6777)', () => {
    const x = makeClimb('x');
    const queued = makeItem('queued');
    const queue = [itemFor(x), queued];
    const source = makeSource(x, [x]); // x is last on the list
    expect(findNextQueueItemWithSuggestions(queue, queue[0], source)).toBe(queued);
  });

  it('stops at the end of the list once nothing is Up next (#6664)', () => {
    const x = makeClimb('x');
    const queue = [makeItem('history'), itemFor(x)];
    const source = makeSource(x, [x]); // x is last on the list
    expect(findNextQueueItemWithSuggestions(queue, queue[1], source)).toBeNull();
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

  it('stops at the start of the list instead of walking back into History (#6664)', () => {
    const x = makeClimb('x');
    const leftover = makeItem('leftover');
    const queue = [leftover, itemFor(x)];
    const source = makeSource(x, [x]); // x is first on the list
    expect(findPreviousQueueItemWithSuggestions(queue, queue[1], source)).toBeNull();
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
  const kilter1 = climbOnBoard('K1', 'kilter', 1);
  const kilter2 = climbOnBoard('K2', 'kilter', 1);
  const kilter3 = climbOnBoard('K3', 'kilter', 1);
  const woods0 = climbOnBoard('W0', 'tension', 8);
  const woods1 = climbOnBoard('W1', 'tension', 8);
  const woods2 = climbOnBoard('W2', 'tension', 8);
  // The wall the climber now stands at; the Woods list is on it.
  const WOODS_BOARD = { boardName: 'tension' as const, layoutId: 8 };
  const woodsSource = makeSource(woods1, [woods0, woods1, woods2]);

  it('walks the Woods list past Kilter leftovers the board on the wall cannot draw', () => {
    // Tapping W1 from the Woods list inserts it after the current item. The
    // Kilter climbs after it are Up next (#6777), and a Woods wall can't draw
    // them, so Next walks past them onto the list without a skip notice.
    const queue = [itemFor(kilter1), itemFor(woods1), itemFor(kilter2), itemFor(kilter3)];
    const current = queue[1];

    const selection = selectNextQueueItemWithSuggestions(queue, current, woodsSource, WOODS_BOARD);
    const next = selection.item;
    expect(next?.climb.uuid).toBe('W2');
    expect(next?.suggested).toBe(true);
    expect(selection.skippedItems).toEqual([]);

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
    // Both list climbs were committed by the walk, so they are list-walk
    // entries, never Up next ahead of the list (#6777).
    const committedW0 = { ...itemFor(woods0), suggested: true };
    const queue = [itemFor(kilter1), { ...itemFor(woods1), suggested: true }, committedW0, itemFor(kilter2)];
    const next = findNextQueueItemWithSuggestions(queue, committedW0, woodsSource, WOODS_BOARD);
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
    // swipe back to on either side.
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
    // One forward swipe is available — onto `y` — so "1 left" is the honest
    // count even though the queue tail is empty (issue #5403).
    expect(state.remainingCount).toBe(1);
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
    // Nothing after `w1` in the queue, but `w2` is one swipe away down the list.
    expect(state.remainingCount).toBe(1);
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

  it('gives a trackless preview nothing to swipe to, even when its climb is queued', () => {
    // Settings promises "a preview never lights the board as you swipe". With
    // Light the board as I swipe on, a trackless preview's swipe is not view-only
    // (`getViewOnlyPreviewNavigationTarget`), so the promise rests on this: every
    // trackless preview is a fresh queue item (`climbToQueueItem`), an orphan with
    // no list, and an orphan has nowhere to go. A swipe that could land would
    // commit and light the climb it reached.
    const queued = makeItem('a');
    const queue = [makeItem('before'), queued, makeItem('after')];
    const tracklessPreview: ClimbQueueItem = { ...queued, uuid: 'fresh-preview-uuid' };
    const state = computeNavigationStateWithSuggestions(queue, tracklessPreview, null);
    expect(state.canNext).toBe(false);
    expect(state.nextItem).toBeNull();
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
  });
});

describe('findUpcomingQueueItemsWithSuggestions', () => {
  it('returns the next `count` queue items in swipe order', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c'), makeItem('d')];
    expect(findUpcomingQueueItemsWithSuggestions(items, items[0], null, 3)).toEqual([items[1], items[2], items[3]]);
  });

  it('returns fewer than asked for at the end of the queue', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    expect(findUpcomingQueueItemsWithSuggestions(items, items[1], null, 3)).toEqual([items[2]]);
    expect(findUpcomingQueueItemsWithSuggestions(items, items[2], null, 3)).toEqual([]);
  });

  it('starts at the head of the queue when there is no current item', () => {
    const items = [makeItem('a'), makeItem('b'), makeItem('c')];
    expect(findUpcomingQueueItemsWithSuggestions(items, null, null, 2)).toEqual([items[0], items[1]]);
  });

  it('returns nothing for a count of zero (or less)', () => {
    const items = [makeItem('a'), makeItem('b')];
    expect(findUpcomingQueueItemsWithSuggestions(items, items[0], null, 0)).toEqual([]);
    expect(findUpcomingQueueItemsWithSuggestions(items, items[0], null, -1)).toEqual([]);
  });

  it('walks the suggestion source in list order, as peeks (#4829)', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const z = makeClimb('z');
    const queue = [itemFor(x)];
    const source = makeSource(x, [x, y, z]);

    const upcoming = findUpcomingQueueItemsWithSuggestions(queue, queue[0], source, 3);

    expect(upcoming.map(({ climb }) => climb.uuid)).toEqual(['y', 'z']);
    expect(upcoming.map(({ uuid }) => uuid)).toEqual([
      getPlaylistPeekQueueItemUuid('y'),
      getPlaylistPeekQueueItemUuid('z'),
    ]);
    expect(upcoming.every(({ suggested }) => suggested === true)).toBe(true);
  });

  it('prefers a real adjacent queue item over minting a duplicate peek', () => {
    const x = makeClimb('x');
    const y = makeClimb('y');
    const queue = [itemFor(x), itemFor(y)];
    const source = makeSource(x, [x, y]);

    expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], source, 2)).toEqual([queue[1]]);
  });

  it('stops instead of looping when the walk comes back to a climb it already returned', () => {
    const a = makeClimb('a');
    const b = makeClimb('b');
    // The list ends where it began, so step three would hand back `a` — the
    // climb the walk started on — and the walk would circle forever.
    const queue = [itemFor(a)];
    const source = makeSource(a, [a, b, a]);

    expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], source, 5).map(({ climb }) => climb.uuid)).toEqual([
      'b',
    ]);
  });

  it('skips a climb the queue holds twice, whose render is already warm', () => {
    const a = makeClimb('a');
    const b = makeClimb('b');
    // Re-activating a playlist appends a fresh pass, so the same climb can sit
    // in the queue more than once.
    const queue = [itemFor(a), itemFor(b), { uuid: 'item-a-second-pass', climb: a }];

    expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], null, 3)).toEqual([queue[1]]);
  });

  it('walks past a repeated climb rather than ending the walk there', () => {
    const a = makeClimb('a');
    const b = makeClimb('b');
    const c = makeClimb('c');
    // The second `a` is a different queue item with the same climb: its render
    // is already warm, but the climbs behind it are not.
    const queue = [itemFor(a), { uuid: 'item-a-again', climb: a }, itemFor(b), itemFor(c)];

    expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], null, 3)).toEqual([queue[2], queue[3]]);
  });

  it('ends the walk when a list loops back to a target it already returned', () => {
    const a = makeClimb('a');
    const b = makeClimb('b');
    const c = makeClimb('c');
    // The list ends where it began, so a fourth step would hand back `b`.
    const queue = [itemFor(a)];
    const source = makeSource(a, [a, b, c, a]);

    expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], source, 10).map(({ climb }) => climb.uuid)).toEqual([
      'b',
      'c',
    ]);
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

  it('follows the active list before scanning an off-board queue tail', () => {
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
    // List-first navigation never considered the queue tail, so no skip notice.
    expect(selection.skippedItems).toEqual([]);
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

it('prefetches the same reachable climbs as board-aware forward navigation', () => {
  const queue = [
    queueItemOnBoard('current', 'tension', 8),
    queueItemOnBoard('kilter-1', 'kilter', 1),
    queueItemOnBoard('kilter-2', 'kilter', 1),
    queueItemOnBoard('tension-1', 'tension', 8),
    queueItemOnBoard('tension-2', 'tension', 8),
  ];
  expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], null, 2, TENSION_BOARD)).toEqual([queue[3], queue[4]]);
});

describe('a suggestion track belongs to one lineage (#5403)', () => {
  const previewedClimb = makeClimb('previewed');
  const leftoverNeighbour = makeClimb('leftover-neighbour');

  it('never lends the committed track to a source-less preview', () => {
    // The trap: the leftover track DOES contain the previewed climb, so a
    // membership check alone would hand it over. A pinned preview is a different
    // lineage regardless — it navigates its own track or none.
    const leftover = makeSource(previewedClimb, [previewedClimb, leftoverNeighbour]);
    expect(
      resolveNavigationSuggestionSource({
        previewItem: itemFor(previewedClimb),
        previewSource: null,
        committedItem: itemFor(previewedClimb),
        committedSource: leftover,
      }),
    ).toBeNull();
  });

  it('uses the track the preview was opened with', () => {
    const own = makeSource(previewedClimb, [previewedClimb, makeClimb('own-neighbour')]);
    const leftover = makeSource(previewedClimb, [previewedClimb, leftoverNeighbour]);
    expect(
      resolveNavigationSuggestionSource({
        previewItem: itemFor(previewedClimb),
        previewSource: own,
        committedItem: itemFor(previewedClimb),
        committedSource: leftover,
      }),
    ).toBe(own);
  });

  it('keeps the committed track while it anchors the committed climb', () => {
    const committed = makeClimb('committed');
    const track = makeSource(committed, [committed, makeClimb('after')]);
    expect(
      resolveNavigationSuggestionSource({
        previewItem: null,
        previewSource: null,
        committedItem: itemFor(committed),
        committedSource: track,
      }),
    ).toBe(track);
  });

  it('drops a committed track the current climb has moved off', () => {
    const elsewhere = makeClimb('elsewhere');
    const track = makeSource(makeClimb('anchor'), [makeClimb('anchor'), makeClimb('after')]);
    expect(
      resolveNavigationSuggestionSource({
        previewItem: null,
        previewSource: null,
        committedItem: itemFor(elsewhere),
        committedSource: track,
      }),
    ).toBeNull();
  });

  it('keeps a track with nothing to anchor against, so an empty queue can seed from it', () => {
    const first = makeClimb('first');
    const track = makeSource(first, [first, makeClimb('second')]);
    expect(anchoredSuggestionSource(track, null)).toBe(track);
  });
});

describe("the end of the climber's own list (#5403)", () => {
  it('dead-ends instead of continuing, and says 0 left', () => {
    const last = makeClimb('last');
    const track = makeSource(makeClimb('first'), [makeClimb('first'), last]);
    const queue = [itemFor(last)];
    const state = computeNavigationStateWithSuggestions(queue, queue[0], track);
    expect(state.canNext).toBe(false);
    expect(state.nextItem).toBeNull();
    expect(state.remainingCount).toBe(0);
    expect(state.atTrackEnd).toBe(true);
  });

  it('stops the prefetch walk there too', () => {
    const last = makeClimb('last');
    const track = makeSource(makeClimb('first'), [makeClimb('first'), last]);
    const queue = [itemFor(last)];
    expect(findUpcomingQueueItemsWithSuggestions(queue, queue[0], track, 5)).toEqual([]);
  });
});

// --- Reachable walls at the same gym ----------------------------------------
//
// The #5099 skip was written for a queue tail from a board somewhere else. At a
// gym with two walls the same rule deletes half a deliberately mixed session, so
// a climb the climber can walk to is a navigation target instead.

describe('selectNextQueueItemWithSuggestions reachable walls', () => {
  const kilterIsReachable = (climb: Climb) => climb.boardType === 'kilter';

  it('stops on a climb from another wall at this gym instead of skipping it', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];

    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(selection.item?.uuid).toBe('item-kilter-1');
    expect(selection.skippedItems).toEqual([]);
  });

  it('still skips a climb from a board that is not at this gym', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('moon-1', 'moonboard', 6),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];

    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(selection.item?.uuid).toBe('item-tension-2');
    expect(selection.skippedItems.map((item) => item.uuid)).toEqual(['item-moon-1']);
  });

  // Order is the climber's, not ours: a wall they can walk to that comes first
  // wins over something drawable here that comes later.
  it('prefers an earlier reachable climb over a later compatible one', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
      queueItemOnBoard('kilter-2', 'kilter', 1),
    ];

    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(selection.item?.uuid).toBe('item-kilter-1');
  });

  it('walks past unreachable climbs to a reachable one further along', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('moon-1', 'moonboard', 6),
      queueItemOnBoard('kilter-1', 'kilter', 1),
    ];

    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(selection.item?.uuid).toBe('item-kilter-1');
    expect(selection.skippedItems.map((item) => item.uuid)).toEqual(['item-moon-1']);
  });

  // The predicate is additive: without it the #5099 behaviour must be unchanged,
  // which is what keeps every existing caller safe.
  it('behaves exactly as before when no predicate is supplied', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];

    const withoutPredicate = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD);
    const withNothingReachable = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, () => false);

    expect(withoutPredicate.item?.uuid).toBe('item-tension-2');
    expect(withNothingReachable.item?.uuid).toBe('item-tension-2');
    expect(withNothingReachable.skippedItems.map((item) => item.uuid)).toEqual(['item-kilter-1']);
  });

  // The forward/backward disagreement that mattered: a climb the climber could
  // walk to was skipped going forward but landed on going back.
  it('reaches the same-gym climb in both directions', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];

    const forward = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);
    const backward = findPreviousQueueItemWithSuggestions(queue, queue[2], null);

    expect(forward.item?.uuid).toBe('item-kilter-1');
    expect(backward?.uuid).toBe('item-kilter-1');
  });
});

// The drawer's Next affordance, its peek and its "N left" are computed here, and
// they have to describe the swipe that `nextClimb` actually performs. Before the
// predicate reached these, a queue whose only remaining climb was on the board
// across the room reported canNext:false — so the gesture was disabled and the
// climb this feature exists to reach could not be reached forward at all.
describe('computeNavigationStateWithSuggestions reachable walls', () => {
  const kilterIsReachable = (climb: Climb) => climb.boardType === 'kilter';

  it('can advance onto a climb at another board in this gym', () => {
    const queue = [queueItemOnBoard('current', 'tension', 8), queueItemOnBoard('kilter-1', 'kilter', 1)];

    const state = computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(state.canNext).toBe(true);
    expect(state.nextItem?.uuid).toBe('item-kilter-1');
  });

  it('still cannot advance onto a board that is not at this gym', () => {
    const queue = [queueItemOnBoard('current', 'tension', 8), queueItemOnBoard('moon-1', 'moonboard', 6)];

    const state = computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(state.canNext).toBe(false);
  });

  // The peek names the climb the swipe lands on. Disagreement here is how a
  // climber is shown one climb and handed another.
  it('peeks the climb the swipe will actually land on', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('kilter-1', 'kilter', 1),
      queueItemOnBoard('tension-2', 'tension', 8),
    ];

    const state = computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);
    const landed = selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, kilterIsReachable);

    expect(state.nextItem?.uuid).toBe(landed.item?.uuid);
  });

  it('counts a reachable climb in what is left', () => {
    const queue = [queueItemOnBoard('current', 'tension', 8), queueItemOnBoard('kilter-1', 'kilter', 1)];

    const withPredicate = computeNavigationStateWithSuggestions(
      queue,
      queue[0],
      null,
      TENSION_BOARD,
      kilterIsReachable,
    );
    const without = computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD);

    expect(withPredicate.remainingCount).toBe(1);
    expect(without.remainingCount).toBe(0);
  });
});

describe('prepared navigation', () => {
  it('preserves reachable-wall queue fallback and skipped items', () => {
    const queue = [
      queueItemOnBoard('current', 'tension', 8),
      queueItemOnBoard('far-wall', 'kilter', 1),
      queueItemOnBoard('near-wall', 'kilter', 1),
      queueItemOnBoard('compatible', 'tension', 8),
    ];
    const isReachable = (candidate: Climb) => candidate.uuid === 'near-wall';
    const prepared = prepareQueueNavigation(queue);
    expect(selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, isReachable, prepared)).toEqual(
      selectNextQueueItemWithSuggestions(queue, queue[0], null, TENSION_BOARD, isReachable),
    );
    expect(computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD, isReachable, prepared)).toEqual(
      computeNavigationStateWithSuggestions(queue, queue[0], null, TENSION_BOARD, isReachable),
    );
  });

  it('resolves immediate targets without rescanning the loaded source or queue', () => {
    const climbs = [makeClimb('a'), makeClimb('b'), makeClimb('c')];
    const source = createPlaylistSuggestionSource({
      playlistUuid: 'prepared',
      boardKey: 'board',
      activatedClimb: climbs[1],
      climbs,
      preparedClimbs: preparePlaylistClimbs(climbs),
    });
    const queue = climbs.map(itemFor);
    const prepared = prepareQueueNavigation(queue);
    const queueScan = vi.spyOn(queue, 'findIndex');
    const sourceScan = vi.spyOn(source.climbs, 'findIndex');
    expect(computeNavigationTargetsWithSuggestions(queue, queue[1], source, undefined, undefined, prepared)).toEqual({
      nextItem: queue[2],
      prevItem: queue[0],
      canNext: true,
      canPrevious: true,
      atTrackEnd: false,
    });
    expect(anchoredSuggestionSource(source, queue[1])).toBe(source);
    expect(queueScan).not.toHaveBeenCalled();
    expect(sourceScan).not.toHaveBeenCalled();
  });

  it('matches legacy navigation for boundaries, adjacent dedupe, orphans and duplicate queue UUIDs', () => {
    const climbs = [makeClimb('a'), makeClimb('b'), makeClimb('c')];
    const queues = [
      [],
      climbs.map(itemFor),
      [itemFor(climbs[1]), itemFor(climbs[0])],
      [itemFor(climbs[0]), itemFor(climbs[0]), itemFor(climbs[2])],
    ];
    const sources = [null, makeSource(climbs[0], climbs), makeSource(climbs[0], [climbs[0], climbs[0], climbs[2]])];
    for (const queue of queues) {
      const prepared = prepareQueueNavigation(queue);
      for (const current of [null, ...queue, itemFor(makeClimb('orphan'))]) {
        for (const source of sources) {
          const legacy = computeNavigationStateWithSuggestions(queue, current, source);
          expect(computeNavigationStateWithSuggestions(queue, current, source, undefined, undefined, prepared)).toEqual(
            legacy,
          );
          expect({
            ...computeNavigationTargetsWithSuggestions(queue, current, source, undefined, undefined, prepared),
            remainingCount: countRemainingQueueItemsWithSuggestions(
              queue,
              current,
              source,
              undefined,
              undefined,
              prepared,
            ),
          }).toEqual(legacy);
        }
      }
    }
  });

  it('falls back to the correct snapshot when handed a stale queue index', () => {
    const queue = [makeItem('a'), makeItem('b')];
    const reversed = [...queue].reverse();
    expect(findPreviousQueueItemWithSuggestions(reversed, queue[0], null, prepareQueueNavigation(queue))).toBe(
      queue[1],
    );
  });
});

// Issue #6664: swipes and Next walk the list the climber tapped in and stop at
// its ends. The end is reported, so the player can offer its end card for "the
// list is done" and nothing for "there was never a list".
describe('the list is a walk with two ends (#6664)', () => {
  const first = makeClimb('first');
  const middle = makeClimb('middle');
  const last = makeClimb('last');
  const list = makeSource(first, [first, middle, last]);

  it('walks the list in order from a committed climb', () => {
    const queue = [makeItem('older'), itemFor(first)];
    const selection = selectNextQueueItemWithSuggestions(queue, queue[1], list);
    expect(selection.item?.climb.uuid).toBe('middle');
    expect(selection.atTrackEnd).toBe(false);
  });

  it('reports the end of the list only once the climbs queued after it are played (#6777)', () => {
    const queued = makeItem('queued-after');
    const queue = [itemFor(last), queued];
    const intoUpNext = selectNextQueueItemWithSuggestions(queue, queue[0], list);
    expect(intoUpNext.item).toBe(queued);
    expect(intoUpNext.atTrackEnd).toBe(false);
    const walking = withPlaylistTrackResume(list, intoUpNext.trackResume ?? null);
    expect(selectNextQueueItemWithSuggestions(queue, queued, walking)).toEqual({
      item: null,
      skippedItems: [],
      atTrackEnd: true,
    });
  });

  it('reports the end of the list for a preview that is not in the queue', () => {
    // The wrong-board and crew previews show a climb the queue does not hold.
    const preview = itemFor(last);
    const selection = selectNextQueueItemWithSuggestions([makeItem('queued')], preview, list);
    expect(selection).toEqual({ item: null, skippedItems: [], atTrackEnd: true });
    expect(computeNavigationStateWithSuggestions([makeItem('queued')], preview, list).atTrackEnd).toBe(true);
  });

  it('tells "nothing to walk" apart from the end of a list', () => {
    // A preview with no list, and a preview off its list, have nowhere to go,
    // and no list ended.
    const trackless = itemFor(makeClimb('trackless'));
    expect(selectNextQueueItemWithSuggestions([], trackless, null)).toEqual({
      item: null,
      skippedItems: [],
      atTrackEnd: false,
    });
    expect(selectNextQueueItemWithSuggestions([], trackless, list).atTrackEnd).toBe(false);
    // The end of the queue is not the end of a list either.
    const queue = [makeItem('a'), makeItem('b')];
    expect(selectNextQueueItemWithSuggestions(queue, queue[1], null).atTrackEnd).toBe(false);
  });

  it('never reports the end with somewhere to go', () => {
    const queue = [itemFor(middle)];
    const state = computeNavigationStateWithSuggestions(queue, queue[0], list);
    expect(state.canNext).toBe(true);
    expect(state.atTrackEnd).toBe(false);
  });

  it('stops Previous at the first climb of the list for a committed climb with History', () => {
    const history = makeItem('history');
    const queue = [history, itemFor(first)];
    const state = computeNavigationStateWithSuggestions(queue, queue[1], list);
    expect(state.canPrevious).toBe(false);
    expect(state.prevItem).toBeNull();
  });

  it('stops Previous at the first climb of the list for a preview', () => {
    expect(findPreviousQueueItemWithSuggestions([makeItem('queued')], itemFor(first), list)).toBeNull();
  });

  it('still walks History for a climb with no list', () => {
    const queue = [makeItem('history'), makeItem('current')];
    expect(findPreviousQueueItemWithSuggestions(queue, queue[1], null)).toBe(queue[0]);
  });

  it('counts Up next and the rest of the list as "left" (#6777)', () => {
    const queue = [itemFor(first), makeItem('queued-1'), makeItem('queued-2')];
    expect(computeNavigationStateWithSuggestions(queue, queue[0], list).remainingCount).toBe(4);
  });
});

describe('a queue that holds the list in order, with off-board climbs between (#6664)', () => {
  // "Start playlist" queues the whole list. A smart list is fetched by board
  // name only, so a climb from another layout can sit between two of the list's
  // climbs; the provider's board filter takes it off the track.
  const first = climbOnBoard('first', 'tension', 8);
  const offBoard = climbOnBoard('other-layout', 'tension', 10);
  const second = climbOnBoard('second', 'tension', 8);
  const third = climbOnBoard('third', 'tension', 8);
  const track = makeSource(first, [first, second, third]);
  const queue = [itemFor(first), itemFor(offBoard), itemFor(second), itemFor(third)];

  it('lands Next on the queued copy past the climb the board cannot draw', () => {
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], track, TENSION_BOARD);
    expect(selection.item).toBe(queue[2]);
    expect(selection.atTrackEnd).toBe(false);
    // The track left it out, as it always does, so nothing was "skipped".
    expect(selection.skippedItems).toEqual([]);
  });

  it('lands Previous on the queued copy past the climb the board cannot draw', () => {
    expect(findPreviousQueueItemWithSuggestions(queue, queue[2], track, undefined, TENSION_BOARD)).toBe(queue[0]);
  });

  it('agrees with the provider and the drawer through computeNavigationStateWithSuggestions', () => {
    const state = computeNavigationStateWithSuggestions(queue, queue[2], track, TENSION_BOARD);
    expect(state.prevItem).toBe(queue[0]);
    expect(state.nextItem).toBe(queue[3]);
  });

  it('walks the whole list without minting a single copy', () => {
    const walk = findUpcomingQueueItemsWithSuggestions(queue, queue[0], track, 5, TENSION_BOARD);
    expect(walk).toEqual([queue[2], queue[3]]);
  });

  it('plays a "Play next" climb the board can draw before the list goes on (#6777)', () => {
    const playNext = itemFor(climbOnBoard('play-next', 'tension', 8));
    const withPlayNext = [itemFor(first), playNext, itemFor(offBoard), itemFor(second)];
    const selection = selectNextQueueItemWithSuggestions(withPlayNext, withPlayNext[0], track, TENSION_BOARD);
    expect(selection.item).toBe(playNext);
    expect(selection.trackResume).toEqual({ climbUuid: 'first', queueItemUuid: 'item-first' });
    // From there Up next's next climb is the list's own: the list carries on.
    const walking = withPlaylistTrackResume(track, selection.trackResume ?? null);
    const onward = selectNextQueueItemWithSuggestions(withPlayNext, playNext, walking, TENSION_BOARD);
    expect(onward.item).toBe(withPlayNext[3]);
    expect(onward.trackResume).toBeNull();
  });

  it('plays a queued climb on another wall at this gym, which the queue holds', () => {
    const reachable = (climb: Climb) => climb.layoutId === 10;
    const selection = selectNextQueueItemWithSuggestions(queue, queue[0], track, TENSION_BOARD, reachable);
    expect(selection.item).toBe(queue[1]);
  });

  it('plays the queue as it stands when it does not know the board', () => {
    expect(selectNextQueueItemWithSuggestions(queue, queue[0], track).item).toBe(queue[1]);
    // And Previous retraces it: Next from `first` played the other layout's climb.
    expect(selectPreviousQueueItemWithSuggestions(queue, queue[2], track)).toEqual({
      item: queue[1],
      trackResume: { climbUuid: 'first', queueItemUuid: 'item-first' },
    });
  });

  it('still peeks for a preview, which is not in the queue', () => {
    const preview = { uuid: 'preview-first', climb: first };
    const selection = selectNextQueueItemWithSuggestions(queue, preview, track, TENSION_BOARD);
    expect(selection.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('second'));
  });
});

// Issue #6777: what you queue plays before the list continues. While a list is
// walked, Next plays Up next first (Play next climbs at the top of it, then Play
// last ones), and the list picks up after the last list climb played.
describe('Up next plays before the list continues (#6777)', () => {
  const s1 = makeClimb('s1');
  const s2 = makeClimb('s2');
  const s3 = makeClimb('s3');
  const s4 = makeClimb('s4');
  const results = makeSource(s1, [s1, s2, s3, s4]);
  // A list tap commits the climb flagged `suggested`.
  const tapped: ClimbQueueItem = { uuid: 'item-s2', climb: s2, suggested: true };
  const playNext1 = makeItem('play-next-1');
  const playNext2 = makeItem('play-next-2');
  const playLast = makeItem('play-last');
  // Play next takes the slot right after the current climb, Play last the end.
  const queue = [makeItem('history'), tapped, playNext1, playNext2, playLast];
  const resumeAtS2 = { climbUuid: 's2', queueItemUuid: 'item-s2' };
  const walking = withPlaylistTrackResume(results, resumeAtS2);

  it('plays the queue before the list, and says where the list picks up', () => {
    const selection = selectNextQueueItemWithSuggestions(queue, tapped, results);
    expect(selection.item).toBe(playNext1);
    expect(selection.atTrackEnd).toBe(false);
    expect(selection.trackResume).toEqual(resumeAtS2);
  });

  it('walks Up next in queue order, Play next before Play last, then the list', () => {
    const walk = findUpcomingQueueItemsWithSuggestions(queue, tapped, results, 10);
    expect(walk.map(({ uuid }) => uuid)).toEqual([
      'play-next-1',
      'play-next-2',
      'play-last',
      getPlaylistPeekQueueItemUuid('s3'),
      getPlaylistPeekQueueItemUuid('s4'),
    ]);
    expect(computeNavigationStateWithSuggestions(queue, tapped, results).remainingCount).toBe(5);
  });

  it('keeps the list position while Up next plays (the resume anchor)', () => {
    const middle = selectNextQueueItemWithSuggestions(queue, playNext1, walking);
    expect(middle.item).toBe(playNext2);
    // Another Up next climb keeps the same resume point.
    expect(middle.trackResume).toBeUndefined();
    expect(resolveTrackPosition(queue, playNext2, walking)).toEqual({
      kind: 'upNext',
      resume: resumeAtS2,
      resumeIndex: 1,
    });
    expect(resolveTrackListClimbUuid(resolveTrackPosition(queue, playNext2, walking), walking)).toBe('s2');
  });

  it('picks the list up after the last list climb played once Up next is done', () => {
    const resumed = selectNextQueueItemWithSuggestions(queue, playLast, walking);
    expect(resumed.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('s3'));
    expect(resumed.trackResume).toBeNull();
  });

  it('reuses the queued entry of the list climb it picks up at', () => {
    // A list-walk entry for s3 already sits right after the last Up next climb.
    const s3Entry: ClimbQueueItem = { uuid: 'item-s3', climb: s3, suggested: true };
    const withEntry = [tapped, playNext1, s3Entry];
    expect(selectNextQueueItemWithSuggestions(withEntry, playNext1, walking).item).toBe(s3Entry);
  });

  it('goes back from the first queued climb to the list climb it was played from', () => {
    expect(selectPreviousQueueItemWithSuggestions(queue, playNext1, walking)).toEqual({
      item: tapped,
      trackResume: null,
    });
    expect(selectPreviousQueueItemWithSuggestions(queue, playNext2, walking)).toEqual({ item: playNext1 });
  });

  it('retraces the queue from the list climb it picked up at', () => {
    const s3Entry: ClimbQueueItem = { uuid: 'item-s3', climb: s3, suggested: true };
    const afterDetour = [tapped, playNext1, playNext2, s3Entry];
    expect(selectPreviousQueueItemWithSuggestions(afterDetour, s3Entry, results)).toEqual({
      item: playNext2,
      trackResume: resumeAtS2,
    });
  });

  it('still walks back up the list from a climb with no queue behind it', () => {
    const fresh = [makeItem('from-before-the-list'), tapped];
    expect(selectPreviousQueueItemWithSuggestions(fresh, tapped, results)).toEqual({
      item: expect.objectContaining({ uuid: getPlaylistPeekQueueItemUuid('s1') }),
      trackResume: null,
    });
  });

  it('shows the end only when both the list and Up next are done', () => {
    const lastTapped: ClimbQueueItem = { uuid: 'item-s4', climb: s4, suggested: true };
    const atEnd = [lastTapped, playNext1];
    const intoQueue = selectNextQueueItemWithSuggestions(atEnd, lastTapped, results);
    expect(intoQueue.item).toBe(playNext1);
    expect(intoQueue.atTrackEnd).toBe(false);
    const queueDone = withPlaylistTrackResume(results, intoQueue.trackResume ?? null);
    expect(selectNextQueueItemWithSuggestions(atEnd, playNext1, queueDone).atTrackEnd).toBe(true);
    expect(computeNavigationStateWithSuggestions(atEnd, playNext1, queueDone)).toMatchObject({
      canNext: false,
      atTrackEnd: true,
    });
  });

  it('walks the list exactly as before with nothing Up next', () => {
    const alone = [makeItem('history'), tapped];
    const selection = selectNextQueueItemWithSuggestions(alone, tapped, results);
    expect(selection.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('s3'));
    expect(selection.trackResume).toBeNull();
    expect(findPreviousQueueItemWithSuggestions(alone, tapped, results)?.uuid).toBe(getPlaylistPeekQueueItemUuid('s1'));
  });

  it('never counts the list walk own entries as Up next', () => {
    // Swiping back from s2 committed s1 after it, so s2 and the walked-past s3
    // sit after the current climb, all flagged `suggested`.
    const s1Entry: ClimbQueueItem = { uuid: 'item-s1', climb: s1, suggested: true };
    const s3Entry: ClimbQueueItem = { uuid: 'item-s3', climb: s3, suggested: true };
    const walkedBack = [tapped, s1Entry, s3Entry];
    const selection = selectNextQueueItemWithSuggestions(walkedBack, s1Entry, results);
    expect(selection.item).toBe(tapped);
    expect(selection.trackResume).toBeNull();
  });

  it('treats a queued copy of the next list climb as the list carrying on', () => {
    const queuedS3 = { uuid: 'queued-s3', climb: s3 };
    const selection = selectNextQueueItemWithSuggestions([tapped, queuedS3], tapped, results);
    expect(selection.item).toBe(queuedS3);
    expect(selection.trackResume).toBeNull();
  });

  it('plays a queued repeat of the climb on the wall as Up next', () => {
    const repeat = { uuid: 'repeat-s2', climb: s2 };
    const withRepeat = [tapped, repeat];
    const selection = selectNextQueueItemWithSuggestions(withRepeat, tapped, results);
    expect(selection.item).toBe(repeat);
    expect(selection.trackResume).toEqual(resumeAtS2);
    expect(resolveTrackPosition(withRepeat, repeat, walking).kind).toBe('upNext');
    expect(resolveTrackPosition(withRepeat, tapped, walking).kind).toBe('list');
    expect(selectNextQueueItemWithSuggestions(withRepeat, repeat, walking).item?.uuid).toBe(
      getPlaylistPeekQueueItemUuid('s3'),
    );
  });

  it('leaves a preview on its list: a look never plays anybody Up next', () => {
    const preview = { uuid: 'preview-s2', climb: s2 };
    expect(selectNextQueueItemWithSuggestions(queue, preview, results).item?.uuid).toBe(
      getPlaylistPeekQueueItemUuid('s3'),
    );
    // A resume on the track is ignored for a climb the queue does not hold.
    expect(resolveTrackPosition(queue, preview, walking)).toEqual({ kind: 'list', trackIndex: 1 });
  });

  it('keeps the committed track while a queued climb plays in the middle of it', () => {
    expect(anchoredSuggestionSource(walking, playNext1)).toBe(walking);
    expect(anchoredSuggestionSource(results, playNext1)).toBeNull();
    expect(
      resolveNavigationSuggestionSource({
        previewItem: null,
        previewSource: null,
        committedItem: playNext1,
        committedSource: walking,
      }),
    ).toBe(walking);
  });

  it('counts where the climb sits in the stretch of Up next', () => {
    expect(resolveUpNextProgress(queue, playNext1, walking)).toEqual({ position: 1, total: 3 });
    expect(resolveUpNextProgress(queue, playLast, walking)).toEqual({ position: 3, total: 3 });
    // A queued copy of the next list climb ends the stretch.
    const withListCopy = [tapped, playNext1, { uuid: 'queued-s3', climb: s3 }, playLast];
    expect(resolveUpNextProgress(withListCopy, playNext1, walking)).toEqual({ position: 1, total: 1 });
    // On the list there is no stretch, and without the entry it left from there is no count.
    expect(resolveUpNextProgress(queue, tapped, walking)).toBeNull();
    expect(resolveUpNextProgress([playNext1, playNext2], playNext2, walking)).toBeNull();
  });

  it('never plays Up next twice when the list climb after it sits behind in the queue', () => {
    // Tap s1, swipe to s2, swipe back to s1, then Play last X: the list walk's
    // s2 entry sits between s1 and X.
    const s1Entry: ClimbQueueItem = { uuid: 'item-s1', climb: s1, suggested: true };
    const playLastX = makeItem('x');
    const walkedBack = [s1Entry, tapped, playLastX];
    const intoUpNext = selectNextQueueItemWithSuggestions(walkedBack, s1Entry, results);
    expect(intoUpNext.item).toBe(playLastX);
    const fromX = withPlaylistTrackResume(results, intoUpNext.trackResume ?? null);
    // s2's entry is behind X: picking the list up there would play X again.
    const resumed = selectNextQueueItemWithSuggestions(walkedBack, playLastX, fromX);
    expect(resumed.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('s2'));
    expect(resumed.trackResume).toBeNull();
    const walk = findUpcomingQueueItemsWithSuggestions(walkedBack, s1Entry, results, 10);
    expect(walk.map(({ uuid }) => uuid)).toEqual([
      'x',
      getPlaylistPeekQueueItemUuid('s2'),
      getPlaylistPeekQueueItemUuid('s3'),
      getPlaylistPeekQueueItemUuid('s4'),
    ]);
    expect(computeNavigationStateWithSuggestions(walkedBack, s1Entry, results).remainingCount).toBe(4);
  });

  it('retraces Up next from a list climb whose older list entry sits before the detour', () => {
    // Tap s1, swipe to s2, swipe back to s1, Play last X, Next to X, Next to a
    // fresh s2: the queue reads s1, s2, X, s2' with s2' on the wall.
    const s1Entry: ClimbQueueItem = { uuid: 'item-s1', climb: s1, suggested: true };
    const playLastX = makeItem('x');
    const freshS2: ClimbQueueItem = { uuid: 'item-s2-again', climb: s2, suggested: true };
    const afterDetour = [s1Entry, tapped, playLastX, freshS2];
    expect(resolveTrackPosition(afterDetour, freshS2, results)).toEqual({ kind: 'list', trackIndex: 1 });

    // Previous from s2' goes back to X, the last Up next climb played.
    const toX = selectPreviousQueueItemWithSuggestions(afterDetour, freshS2, results);
    const resumeAtOlderS2 = { climbUuid: 's1', queueItemUuid: 'item-s2' };
    expect(toX).toEqual({ item: playLastX, trackResume: resumeAtOlderS2 });
    const onX = withPlaylistTrackResume(results, toX.trackResume ?? null);
    expect(resolveTrackPosition(afterDetour, playLastX, onX)).toEqual({
      kind: 'upNext',
      resume: resumeAtOlderS2,
      resumeIndex: 0,
    });
    expect(resolveUpNextProgress(afterDetour, playLastX, onX)).toEqual({ position: 1, total: 1 });
    // Next from X lands back on s2', no new copy.
    expect(selectNextQueueItemWithSuggestions(afterDetour, playLastX, onX)).toMatchObject({
      item: freshS2,
      trackResume: null,
    });

    // Previous again: the older s2 entry in History, back on the list...
    expect(selectPreviousQueueItemWithSuggestions(afterDetour, playLastX, onX)).toEqual({
      item: tapped,
      trackResume: null,
    });
    // ...and then s1.
    expect(selectPreviousQueueItemWithSuggestions(afterDetour, tapped, results)).toEqual({
      item: s1Entry,
      trackResume: null,
    });
  });

  it('retraces Up next from a list climb with no older entry of it behind the detour', () => {
    // Tap s1, Play last X, Next to X, Next to s2: the queue reads s1, X, s2.
    const s1Entry: ClimbQueueItem = { uuid: 'item-s1', climb: s1, suggested: true };
    const playLastX = makeItem('x');
    const afterDetour = [s1Entry, playLastX, tapped];

    const toX = selectPreviousQueueItemWithSuggestions(afterDetour, tapped, results);
    const resumeAtS1 = { climbUuid: 's1', queueItemUuid: 'item-s1' };
    expect(toX).toEqual({ item: playLastX, trackResume: resumeAtS1 });
    const onX = withPlaylistTrackResume(results, toX.trackResume ?? null);
    expect(selectNextQueueItemWithSuggestions(afterDetour, playLastX, onX)).toMatchObject({
      item: tapped,
      trackResume: null,
    });
    expect(selectPreviousQueueItemWithSuggestions(afterDetour, playLastX, onX)).toEqual({
      item: s1Entry,
      trackResume: null,
    });
  });

  // Codex review on #6798: with the list's own entries retained (a crew keeps
  // every swipe's entry), older entries of other list climbs sit between the
  // list climb the walk left and Up next. The track's `detour` says where the
  // walk left, so Previous follows the forward walk instead of reading History.
  describe('retracing a detour past older list entries', () => {
    const s1Entry: ClimbQueueItem = { uuid: 'item-s1', climb: s1, suggested: true };
    const s3Entry: ClimbQueueItem = { uuid: 'item-s3', climb: s3, suggested: true };
    const s4Entry: ClimbQueueItem = { uuid: 'item-s4', climb: s4, suggested: true };
    const playLastX = makeItem('x');
    const freshS2: ClimbQueueItem = { uuid: 'item-s2-again', climb: s2, suggested: true };
    const resumeAtS1 = { climbUuid: 's1', queueItemUuid: 'item-s1' };

    /**
     * From s1 with `walkedPast` between it and X: Next to X, then Next to a
     * fresh s2, storing each step's resume as the provider does. Returns the
     * queue with s2' committed after X, and the track s2' is played with.
     */
    function walkOutAndBack(walkedPast: ClimbQueueItem[]) {
      const beforeX = [s1Entry, ...walkedPast, playLastX];
      const intoUpNext = selectNextQueueItemWithSuggestions(beforeX, s1Entry, results);
      expect(intoUpNext).toMatchObject({ item: playLastX, trackResume: resumeAtS1 });
      const onX = withPlaylistTrackResume(results, intoUpNext.trackResume ?? null);
      const backOnList = selectNextQueueItemWithSuggestions(beforeX, playLastX, onX);
      expect(backOnList.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('s2'));
      expect(backOnList.trackResume).toBeNull();
      const onFreshS2 = withPlaylistTrackResume(onX, backOnList.trackResume ?? null);
      expect(onFreshS2.detour).toEqual(resumeAtS1);
      return { afterDetour: [...beforeX, freshS2], onFreshS2 };
    }

    function expectRetraceToS1(afterDetour: ClimbQueue, onFreshS2: PlaylistSuggestionSource) {
      const toX = selectPreviousQueueItemWithSuggestions(afterDetour, freshS2, onFreshS2);
      expect(toX).toEqual({ item: playLastX, trackResume: resumeAtS1 });
      const onX = withPlaylistTrackResume(onFreshS2, toX.trackResume ?? null);
      expect(resolveTrackPosition(afterDetour, playLastX, onX)).toEqual({
        kind: 'upNext',
        resume: resumeAtS1,
        resumeIndex: 0,
      });
      expect(resolveUpNextProgress(afterDetour, playLastX, onX)).toEqual({ position: 1, total: 1 });
      // Next from X still lands back on s2', no new copy.
      expect(selectNextQueueItemWithSuggestions(afterDetour, playLastX, onX)).toMatchObject({
        item: freshS2,
        trackResume: null,
      });
      // Previous from X: where the detour started, past the older entries.
      const toS1 = selectPreviousQueueItemWithSuggestions(afterDetour, playLastX, onX);
      expect(toS1).toEqual({ item: s1Entry, trackResume: null });
      // s1 is the list's first climb: the start is a stop.
      const onS1 = withPlaylistTrackResume(onX, toS1.trackResume ?? null);
      expect(selectPreviousQueueItemWithSuggestions(afterDetour, s1Entry, onS1).item).toBeNull();
    }

    it('goes s2 to X to s1 with an older s3 entry between s1 and X', () => {
      // s1, s2, s3, back to s1, Play last X, Next, Next: s1, s2, s3, X, s2'.
      const { afterDetour, onFreshS2 } = walkOutAndBack([tapped, s3Entry]);
      expectRetraceToS1(afterDetour, onFreshS2);
    });

    it('goes s2 to X to s1 with older entries of two other climbs between', () => {
      // s1, s2, s3, s4, back to s1, Play last X, Next, Next: s1, s2, s3, s4, X, s2'.
      const { afterDetour, onFreshS2 } = walkOutAndBack([tapped, s3Entry, s4Entry]);
      expectRetraceToS1(afterDetour, onFreshS2);
    });

    it('goes s2 to X to s1 solo, where nothing sits between s1 and X', () => {
      // Tap s1, Play last X, Next, Next: s1, X, s2'.
      const { afterDetour, onFreshS2 } = walkOutAndBack([]);
      expectRetraceToS1(afterDetour, onFreshS2);
    });

    it('retraces every Up next climb of the stretch, past the list entries between them', () => {
      const playLastY = makeItem('y');
      const queue = [s1Entry, tapped, playLastX, s3Entry, playLastY, freshS2];
      const onFreshS2 = withPlaylistTrackResume(withPlaylistTrackResume(results, resumeAtS1), null);
      const toY = selectPreviousQueueItemWithSuggestions(queue, freshS2, onFreshS2);
      expect(toY).toEqual({ item: playLastY, trackResume: resumeAtS1 });
      const onY = withPlaylistTrackResume(onFreshS2, resumeAtS1);
      expect(selectPreviousQueueItemWithSuggestions(queue, playLastY, onY)).toEqual({ item: playLastX });
      expect(selectPreviousQueueItemWithSuggestions(queue, playLastX, onY)).toEqual({
        item: s1Entry,
        trackResume: null,
      });
    });

    it('keeps the detour while the walk goes on down the list and comes back', () => {
      const { afterDetour, onFreshS2 } = walkOutAndBack([tapped, s3Entry]);
      const toS3 = selectNextQueueItemWithSuggestions(afterDetour, freshS2, onFreshS2);
      expect(toS3.trackResume).toBeNull();
      const onS3 = withPlaylistTrackResume(onFreshS2, toS3.trackResume ?? null);
      expect(onS3).toBe(onFreshS2);
      const freshS3: ClimbQueueItem = { uuid: 'item-s3-again', climb: s3, suggested: true };
      const further = [...afterDetour, freshS3];
      // s3' is not where the detour handed back: Previous is the list's s2'.
      expect(selectPreviousQueueItemWithSuggestions(further, freshS3, onS3)).toEqual({
        item: freshS2,
        trackResume: null,
      });
      expect(selectPreviousQueueItemWithSuggestions(further, freshS2, onS3)).toEqual({
        item: playLastX,
        trackResume: resumeAtS1,
      });
    });

    it('ignores a detour the climb on screen did not come back from', () => {
      // The detour left s1, but the wall is on the older s2 entry right after it.
      const { afterDetour, onFreshS2 } = walkOutAndBack([tapped, s3Entry]);
      expect(selectPreviousQueueItemWithSuggestions(afterDetour, tapped, onFreshS2)).toEqual({
        item: s1Entry,
        trackResume: null,
      });
      // The entry it left from is gone: History decides, as without a detour.
      const removed = afterDetour.filter(({ uuid }) => uuid !== 'item-s1');
      expect(selectPreviousQueueItemWithSuggestions(removed, freshS2, onFreshS2)).toEqual(
        selectPreviousQueueItemWithSuggestions(removed, freshS2, results),
      );
    });
  });

  it('still walks up the list from an older entry of the climb with nothing Up next between', () => {
    // s2, then s2' right after it: no detour to retrace, so Previous peeks s1.
    const freshS2: ClimbQueueItem = { uuid: 'item-s2-again', climb: s2, suggested: true };
    const backToBack = [makeItem('from-before-the-list'), tapped, freshS2];
    expect(selectPreviousQueueItemWithSuggestions(backToBack, freshS2, results)).toEqual({
      item: expect.objectContaining({ uuid: getPlaylistPeekQueueItemUuid('s1') }),
      trackResume: null,
    });
  });

  it('reads a list walk entry as the list, whatever resume the track still holds', () => {
    // A crewmate moved the wall onto s3's list entry while the track still
    // remembers leaving s2 for X.
    const playNextX = makeItem('x');
    const s3Entry: ClimbQueueItem = { uuid: 'item-s3', climb: s3, suggested: true };
    const moved = [tapped, playNextX, s3Entry];
    expect(resolveTrackPosition(moved, s3Entry, walking)).toEqual({ kind: 'list', trackIndex: 2 });
    expect(resolveUpNextProgress(moved, s3Entry, walking)).toBeNull();
    expect(selectNextQueueItemWithSuggestions(moved, s3Entry, walking).item?.uuid).toBe(
      getPlaylistPeekQueueItemUuid('s4'),
    );
  });

  it('reads a queue entry before the one the walk left from as History, not Up next', () => {
    const history = makeItem('history');
    const historyFirst = [history, tapped, playNext1];
    expect(resolveTrackPosition(historyFirst, history, walking)).toEqual({ kind: 'off' });
    expect(resolveTrackPosition(historyFirst, playNext1, walking).kind).toBe('upNext');
  });

  it('goes back to the list climb, never into History, once its entry left the queue', () => {
    const older = makeItem('older');
    // A crewmate removed s2's entry; the two Play next climbs were played from it.
    const removed = [older, playNext1, playNext2];
    expect(resolveTrackPosition(removed, playNext2, walking).kind).toBe('upNext');
    const back = selectPreviousQueueItemWithSuggestions(removed, playNext2, walking);
    expect(back.item?.uuid).toBe(getPlaylistPeekQueueItemUuid('s2'));
    expect(back.trackResume).toBeNull();
    // Next still knows where the list picks up.
    expect(selectNextQueueItemWithSuggestions(removed, playNext2, walking).item?.uuid).toBe(
      getPlaylistPeekQueueItemUuid('s3'),
    );
  });

  it('commits a queued climb a look reached as Up next on the list', () => {
    // From the list climb, anything queued after it is Up next, left from s2.
    expect(resolveUpNextCommitResume(queue, tapped, results, playNext2)).toEqual(resumeAtS2);
    // From inside Up next, the list still picks up after s2.
    expect(resolveUpNextCommitResume(queue, playNext1, walking, playLast)).toEqual(resumeAtS2);
    // A queued copy of the list's next climb, or the list's own entry, is the list.
    const queuedS3 = { uuid: 'queued-s3', climb: s3 };
    expect(resolveUpNextCommitResume([tapped, queuedS3], tapped, results, queuedS3)).toBeNull();
    const s4Entry: ClimbQueueItem = { uuid: 'item-s4', climb: s4, suggested: true };
    expect(resolveUpNextCommitResume([tapped, s4Entry], tapped, results, s4Entry)).toBeNull();
  });

  it('leaves the list for a looked-at climb that is not ahead on it', () => {
    const history = queue[0];
    expect(resolveUpNextCommitResume(queue, tapped, results, history)).toBeUndefined();
    expect(resolveUpNextCommitResume(queue, tapped, results, tapped)).toBeUndefined();
    expect(resolveUpNextCommitResume(queue, tapped, results, makeItem('not-queued'))).toBeUndefined();
    expect(resolveUpNextCommitResume(queue, tapped, null, playNext1)).toBeUndefined();
    // A finished list has no place to keep.
    const lastTapped: ClimbQueueItem = { uuid: 'item-s4', climb: s4, suggested: true };
    expect(resolveUpNextCommitResume([lastTapped, playNext1], lastTapped, results, playNext1)).toBeUndefined();
  });

  it('counts only the Up next climbs this wall plays', () => {
    const kilterX = queueItemOnBoard('kilter-x', 'kilter', 1);
    const tensionY = queueItemOnBoard('tension-y', 'tension', 8);
    const tensionZ = queueItemOnBoard('tension-z', 'tension', 8);
    const mixed = [tapped, tensionY, kilterX, tensionZ];
    expect(resolveUpNextProgress(mixed, tensionY, walking)).toEqual({ position: 1, total: 3 });
    expect(resolveUpNextProgress(mixed, tensionY, walking, undefined, TENSION_BOARD)).toEqual({
      position: 1,
      total: 2,
    });
    expect(resolveUpNextProgress(mixed, tensionZ, walking, undefined, TENSION_BOARD)).toEqual({
      position: 2,
      total: 2,
    });
  });
});
