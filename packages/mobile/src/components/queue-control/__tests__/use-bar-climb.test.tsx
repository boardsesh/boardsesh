// @vitest-environment jsdom
// Owner decision A: what the MiniPlayer shows. PERF: a mirrored pick's drawn
// copy follows the pick alone, so a queue change under a standing pick hands
// the bar the same object and the same climb.
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';

const queue = vi.hoisted(() => ({ current: null as { uuid: string; climb: { uuid: string } } | null }));
vi.mock('../../../providers/queue-provider', () => ({
  useQueueData: () => ({ currentClimbQueueItem: queue.current }),
}));

import { useBarClimb } from '../use-bar-climb';
import { resetLastPickForTests, setLastPick } from '../../../lib/last-pick-store';

const PICK_ITEM = { uuid: 'queue-pick', climb: { uuid: 'pick', name: 'Pick' } } as unknown as ClimbQueueItem;

beforeEach(() => {
  resetLastPickForTests();
  queue.current = { uuid: 'queue-current', climb: { uuid: 'current' } };
});

describe('useBarClimb', () => {
  it('keeps the same drawn pick while the queue’s current changes identity, not uuid', () => {
    setLastPick({
      item: PICK_ITEM,
      suggestionSource: null,
      commitOptions: undefined,
      mirrored: true,
      currentAtPick: 'queue-current',
      wallAtPick: null,
      pickedAt: 0,
    });
    const { result, rerender } = renderHook(() => useBarClimb());
    const first = result.current;
    expect(first.pick?.item).toBe(PICK_ITEM);
    expect(first.climb?.mirrored).toBe(true);
    // A regrade or a hydrate hands the same slot back as a new object.
    queue.current = { uuid: 'queue-current', climb: { uuid: 'current' } };
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.climb).toBe(first.climb);
  });

  it('shows the queue’s current once it changes after the pick', () => {
    setLastPick({
      item: PICK_ITEM,
      suggestionSource: null,
      commitOptions: undefined,
      mirrored: false,
      currentAtPick: 'queue-current',
      wallAtPick: null,
      pickedAt: 0,
    });
    const { result, rerender } = renderHook(() => useBarClimb());
    act(() => {
      queue.current = { uuid: 'queue-next', climb: { uuid: 'next' } };
    });
    rerender();
    expect(result.current.pick).toBeNull();
    expect(result.current.item?.uuid).toBe('queue-next');
  });
});
