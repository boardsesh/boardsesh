import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { resolveTrackEndCard } from '../track-end';

function item(uuid: string): ClimbQueueItem {
  return { uuid: `queue-${uuid}`, climb: { uuid, name: uuid } } as unknown as ClimbQueueItem;
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
    expect(card({ previewPinned: true })).toEqual({
      listName: 'Projects',
      upNextCount: 2,
      action: { kind: 'backToCommitted' },
    });
  });

  it('says the list is finished, with no queue action, when nothing is Up next', () => {
    expect(card({ committedQueueIndex: 3, queueSuccessor: null })).toEqual({
      listName: 'Projects',
      upNextCount: 0,
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
});
