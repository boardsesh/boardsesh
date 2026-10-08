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
});
