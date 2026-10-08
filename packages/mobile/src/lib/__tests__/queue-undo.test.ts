import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { restoreRemovedQueueItems } from '../queue-undo';

function item(uuid: string, name = uuid): ClimbQueueItem {
  return { uuid, climb: { uuid: `climb-${uuid}`, name } as ClimbQueueItem['climb'], suggested: false };
}
const uuidsOf = (queue: ClimbQueueItem[]) => queue.map((queueItem) => queueItem.uuid);

describe('restoreRemovedQueueItems', () => {
  const before = { queue: ['a', 'b', 'c', 'd'].map((uuid) => item(uuid)), currentClimbQueueItem: item('b') };

  it('puts a cleared queue back in its order with its current climb', () => {
    const restored = restoreRemovedQueueItems(before, new Set(['a', 'b', 'c', 'd']), {
      queue: [],
      currentClimbQueueItem: null,
    });
    expect(uuidsOf(restored.queue)).toEqual(['a', 'b', 'c', 'd']);
    expect(restored.currentClimbQueueItem?.uuid).toBe('b');
  });

  it('slots removed climbs back next to their old neighbours', () => {
    const restored = restoreRemovedQueueItems(before, new Set(['a', 'c']), {
      queue: [item('b'), item('d')],
      currentClimbQueueItem: item('b'),
    });
    expect(uuidsOf(restored.queue)).toEqual(['a', 'b', 'c', 'd']);
  });

  it("keeps a crew member's live order, adds and removals", () => {
    const restored = restoreRemovedQueueItems(before, new Set(['b']), {
      // A peer reordered d ahead of a, removed c and added e.
      queue: [item('d'), item('a'), item('e')],
      currentClimbQueueItem: item('d'),
    });
    expect(uuidsOf(restored.queue)).toEqual(['d', 'a', 'b', 'e']);
    // Something is current live, so the Undo does not move the wall.
    expect(restored.currentClimbQueueItem?.uuid).toBe('d');
  });

  it('keeps the live copy of a climb that stayed (it may have been hydrated)', () => {
    const hydrated = item('a', 'Hydrated name');
    const restored = restoreRemovedQueueItems(before, new Set(['b', 'c', 'd']), {
      queue: [hydrated],
      currentClimbQueueItem: null,
    });
    expect(restored.queue[0]).toBe(hydrated);
  });

  it('does not bring back a current climb nobody restored', () => {
    const restored = restoreRemovedQueueItems(before, new Set(['a']), { queue: [], currentClimbQueueItem: null });
    expect(uuidsOf(restored.queue)).toEqual(['a']);
    expect(restored.currentClimbQueueItem).toBeNull();
  });

  it('leaves the wall unset when a crew member cleared the current climb, not this Undo', () => {
    // The climber bulk-removed a and c; meanwhile a teammate unset the current
    // climb (b, which was never removed here). Undo must not override them.
    const restored = restoreRemovedQueueItems(before, new Set(['a', 'c']), {
      queue: [item('b'), item('d')],
      currentClimbQueueItem: null,
    });
    expect(uuidsOf(restored.queue)).toEqual(['a', 'b', 'c', 'd']);
    expect(restored.currentClimbQueueItem).toBeNull();
  });

  it('fits the sync cap by dropping re-added climbs from the end, never live ones', () => {
    const bigBefore = {
      queue: Array.from({ length: 6 }, (_unused, index) => item(`old-${index}`)),
      currentClimbQueueItem: item('old-5'),
    };
    // A teammate refilled the queue with 3 climbs while the Undo was showing.
    const live = { queue: [item('peer-0'), item('peer-1'), item('peer-2')], currentClimbQueueItem: null };
    const restored = restoreRemovedQueueItems(
      bigBefore,
      new Set(bigBefore.queue.map((queueItem) => queueItem.uuid)),
      live,
      7,
    );
    expect(restored.queue).toHaveLength(7);
    expect(uuidsOf(restored.queue)).toEqual(['old-0', 'old-1', 'old-2', 'old-3', 'peer-0', 'peer-1', 'peer-2']);
    expect(restored.droppedCount).toBe(2);
    // The old current was one of the dropped climbs, so nothing is current.
    expect(restored.currentClimbQueueItem).toBeNull();
  });

  it('defaults to the 500-climb party sync cap', () => {
    const full = {
      queue: Array.from({ length: 500 }, (_unused, index) => item(`q-${index}`)),
      currentClimbQueueItem: null,
    };
    const restored = restoreRemovedQueueItems(full, new Set(['q-0']), {
      queue: [...full.queue.slice(1), item('peer')],
      currentClimbQueueItem: null,
    });
    expect(restored.queue).toHaveLength(500);
    expect(restored.droppedCount).toBe(1);
    expect(restored.queue.some((queueItem) => queueItem.uuid === 'peer')).toBe(true);
  });
});
