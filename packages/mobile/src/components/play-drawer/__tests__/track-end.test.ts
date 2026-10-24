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
    previewPinned: false,
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
    expect(card({ previewPinned: true })).toEqual({
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
    // No committed climb at all: nothing to go back to either.
    expect(card({ committedQueueIndex: -1, previewPinned: true })?.action).toBeNull();
  });

  it('has no card away from the end, or while more of the list is loading', () => {
    expect(card({ navigationState: { atTrackEnd: false } })).toBeNull();
    expect(card({ moreToLoad: true })).toBeNull();
  });

  it('leaves the list unnamed when the header named none', () => {
    expect(card({ trackLabel: { kind: 'hidden' } })?.listName).toBeNull();
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

  it('never splits a character made of two code units', () => {
    expect(truncateClimbName('\u{1F9D7}\u{1F9D7}\u{1F9D7}', 2)).toBe('\u{1F9D7}\u2026');
  });

  it('drops the space before the ellipsis', () => {
    expect(truncateClimbName('Crimp Ladder', 7)).toBe('Crimp\u2026');
  });
});

describe('Up next count and the queue badge (#6238)', () => {
  it('counts what is queued after Now, and nothing without a Now', () => {
    expect(countUpNext(4, 1)).toBe(2);
    expect(countUpNext(4, 3)).toBe(0);
    expect(countUpNext(4, -1)).toBe(0);
  });

  it('agrees with the end card', () => {
    expect(card()?.upNextCount).toBe(countUpNext(queue.length, 1));
  });

  it('badges Up next only while the header names a list', () => {
    expect(resolveListWalkUpNextBadge(named, 3)).toBe(3);
    expect(resolveListWalkUpNextBadge({ kind: 'named', name: 'Projects' }, 3)).toBe(3);
    expect(resolveListWalkUpNextBadge({ kind: 'hidden' }, 3)).toBe(0);
    expect(resolveListWalkUpNextBadge(named, 0)).toBe(0);
  });
});
