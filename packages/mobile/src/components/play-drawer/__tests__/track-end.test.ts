import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import {
  MAX_FIRST_UP_NEXT_NAME_LENGTH,
  countUpNext,
  resolveListWalkUpNextBadge,
  resolveTrackEndCard,
  truncateClimbName,
} from '../track-end';

function item(uuid: string, name: string = uuid): ClimbQueueItem {
  return { uuid: `queue-${uuid}`, climb: { uuid, name } } as unknown as ClimbQueueItem;
}

const named = { kind: 'counted', name: 'Projects', position: 23, total: 23 } as const;
const queue = [item('history'), item('now'), item('next-1'), item('next-2')];

function card(overrides: Partial<Parameters<typeof resolveTrackEndCard>[0]> = {}) {
  return resolveTrackEndCard({
    navigationState: { atTrackEnd: true },
    moreToLoad: false,
    trackLabel: named,
    queue,
    committedQueueIndex: 1,
    queueSuccessor: queue[2],
    previewOverNow: false,
    ...overrides,
  });
}

describe('resolveTrackEndCard (#6664)', () => {
  it('offers the queue after a committed climb, counting Up next', () => {
    expect(card()).toEqual({
      listName: 'Projects',
      upNextCount: 2,
      firstUpNextName: 'next-1',
      action: { kind: 'nextInQueue', target: queue[2] },
    });
  });

  it('goes where the queue walk lands, past climbs this board cannot draw', () => {
    expect(card({ queueSuccessor: queue[3] })?.action).toEqual({ kind: 'nextInQueue', target: queue[3] });
  });

  it('still offers the next queued climb when the board can draw none of them', () => {
    expect(card({ queueSuccessor: null })?.action).toEqual({ kind: 'nextInQueue', target: queue[2] });
  });

  it("sends a preview back to the queue's Now", () => {
    // It goes back to Now, which is not Up next, so it names no climb (#6238).
    expect(card({ previewOverNow: true })).toEqual({
      listName: 'Projects',
      upNextCount: 2,
      firstUpNextName: null,
      action: { kind: 'backToCommitted' },
    });
  });

  it('says the list is finished, with no queue action, when nothing is Up next', () => {
    expect(card({ committedQueueIndex: 3, queueSuccessor: null })).toEqual({
      listName: 'Projects',
      upNextCount: 0,
      firstUpNextName: null,
      action: null,
    });
    // An empty queue with no Now: nothing to go back to either.
    expect(card({ queue: [], committedQueueIndex: -1, queueSuccessor: null })?.action).toBeNull();
  });

  // A crew preview opened from a list while the room's queue has climbs but no
  // Now: the whole queue is Up next, as the queue sheet's header says.
  it('counts the whole queue as Up next without a Now, and opens its first climb', () => {
    const queued = [item('q1'), item('q2'), item('q3')];
    expect(card({ queue: queued, committedQueueIndex: -1, queueSuccessor: null })).toEqual({
      listName: 'Projects',
      upNextCount: 3,
      firstUpNextName: 'q1',
      action: { kind: 'nextInQueue', target: queued[0] },
    });
    // The queue walk from the top lands past what this board cannot draw.
    expect(card({ queue: queued, committedQueueIndex: -1, queueSuccessor: queued[1] })?.action).toEqual({
      kind: 'nextInQueue',
      target: queued[1],
    });
  });

  it('names nothing, and does not throw, for a peer item whose climb has not landed', () => {
    const shell = { uuid: 'queue-shell' } as unknown as ClimbQueueItem;
    const shellQueue = [item('history'), item('now'), shell];
    expect(card({ queue: shellQueue, queueSuccessor: shell })?.firstUpNextName).toBeNull();
  });

  it('has no card away from the end, or while more of the list is loading', () => {
    expect(card({ navigationState: { atTrackEnd: false } })).toBeNull();
    expect(card({ moreToLoad: true })).toBeNull();
  });

  it('leaves the list unnamed when the header named none', () => {
    expect(card({ trackLabel: { kind: 'hidden' } })?.listName).toBeNull();
  });

  // #6777: Up next plays before the list goes on, so the list can end on a
  // queued climb. The card still names the list that ended.
  it('names the list when Up next ran out at its end', () => {
    const upNextLabel = { kind: 'upNext', listName: 'Projects', count: { position: 2, total: 2 } } as const;
    const doneQueue = [item('history'), item('last-on-list'), item('queued')];
    expect(card({ trackLabel: upNextLabel, queue: doneQueue, committedQueueIndex: 2, queueSuccessor: null })).toEqual({
      listName: 'Projects',
      upNextCount: 0,
      firstUpNextName: null,
      action: null,
    });
    expect(card({ trackLabel: { kind: 'upNext', listName: null, count: null } })?.listName).toBeNull();
  });

  // #6238: the card says which climb "Keep going" opens.
  it('names the climb the action opens, which is where the queue walk lands', () => {
    expect(card({ queueSuccessor: queue[3] })?.firstUpNextName).toBe('next-2');
    // No drawable successor: the next queued climb, the one the button opens.
    expect(card({ queueSuccessor: null })?.firstUpNextName).toBe('next-1');
  });

  it('cuts a long name to one line of the card', () => {
    const longName = 'The Very Long Crimp Ladder Traverse Of Doom And Despair';
    const longQueue = [item('history'), item('now'), item('long', longName)];
    const name = card({ queue: longQueue, queueSuccessor: longQueue[2] })?.firstUpNextName;
    expect(name).toBe('The Very Long Crimp Ladder Trav\u2026');
    expect(Array.from(name ?? '')).toHaveLength(MAX_FIRST_UP_NEXT_NAME_LENGTH);
  });

  it('keeps the plain wording when the climb has no name', () => {
    const blankQueue = [item('history'), item('now'), item('blank', '  ')];
    expect(card({ queue: blankQueue, queueSuccessor: blankQueue[2] })?.firstUpNextName).toBeNull();
  });
});

describe('truncateClimbName', () => {
  it('leaves a short name alone, trimmed', () => {
    expect(truncateClimbName('  Crimp Ladder ')).toBe('Crimp Ladder');
  });

  it('cuts a long name at the default length with an ellipsis', () => {
    const cut = truncateClimbName('x'.repeat(MAX_FIRST_UP_NEXT_NAME_LENGTH + 20));
    expect(Array.from(cut)).toHaveLength(MAX_FIRST_UP_NEXT_NAME_LENGTH);
    expect(cut.endsWith('\u2026')).toBe(true);
  });

  it('returns an empty string for an empty name', () => {
    expect(truncateClimbName('')).toBe('');
  });

  it('never splits a character made of two code units', () => {
    expect(truncateClimbName('\u{1F9D7}\u{1F9D7}\u{1F9D7}', 2)).toBe('\u{1F9D7}\u2026');
  });

  it('drops the space before the ellipsis', () => {
    expect(truncateClimbName('Crimp Ladder', 7)).toBe('Crimp\u2026');
  });
});

describe('Up next count and the queue badge (#6238)', () => {
  it('counts what is queued after Now, and the whole queue without one', () => {
    expect(countUpNext(4, 1)).toBe(2);
    expect(countUpNext(4, 3)).toBe(0);
    expect(countUpNext(4, -1)).toBe(4);
    expect(countUpNext(0, -1)).toBe(0);
  });

  it('agrees with the end card', () => {
    expect(card()?.upNextCount).toBe(countUpNext(queue.length, 1));
  });

  it('counts Up next only while the header names a list', () => {
    expect(resolveListWalkUpNextBadge(named, 3)).toBe(3);
    expect(resolveListWalkUpNextBadge({ kind: 'named', name: 'Projects' }, 3)).toBe(3);
    expect(resolveListWalkUpNextBadge({ kind: 'hidden' }, 3)).toBeNull();
    expect(resolveListWalkUpNextBadge(named, 0)).toBe(0);
    // Playing Up next in the middle of a list still walks it (#6777).
    expect(resolveListWalkUpNextBadge({ kind: 'upNext', listName: 'Projects', count: null }, 2)).toBe(2);
  });
});
