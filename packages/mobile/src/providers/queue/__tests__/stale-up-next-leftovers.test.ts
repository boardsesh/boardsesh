import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { countStaleUpNextLeftovers } from '../stale-up-next-leftovers';
import { STALE_CURRENT_HOLD_MS } from '../../../lib/ble/stale-current-hold';

function entry(uuid: string, suggested = false): ClimbQueueItem {
  return { uuid, suggested, climb: { uuid: `climb-${uuid}` } as ClimbQueueItem['climb'] };
}

const now = 1_800_000_000_000;
const current = entry('now');
// History, Now, then two leftovers of an older list and one climb queued on purpose.
const queue = [entry('h'), current, entry('x', true), entry('q'), entry('y', true)];
const staleClock = { queueItemUuid: 'now', changedAt: now - STALE_CURRENT_HOLD_MS };

const base = {
  inSession: false,
  keepQueue: false,
  queue,
  currentClimbQueueItem: current,
  openedQueueItemUuid: 'tapped',
  clock: staleClock,
  now,
};

describe('countStaleUpNextLeftovers', () => {
  it('counts the suggested entries after Now once the climb on the wall sat 4 h', () => {
    expect(countStaleUpNextLeftovers(base)).toBe(2);
  });

  it('keeps them while the climb on the wall is younger than 4 h', () => {
    expect(
      countStaleUpNextLeftovers({
        ...base,
        clock: { queueItemUuid: 'now', changedAt: now - STALE_CURRENT_HOLD_MS + 1 },
      }),
    ).toBe(0);
  });

  it('keeps them when the clock is about another climb', () => {
    expect(countStaleUpNextLeftovers({ ...base, clock: { ...staleClock, queueItemUuid: 'other' } })).toBe(0);
  });

  it('keeps them in a crew, for a step that keeps the queue, and for a move onto a queued entry', () => {
    expect(countStaleUpNextLeftovers({ ...base, inSession: true })).toBe(0);
    expect(countStaleUpNextLeftovers({ ...base, keepQueue: true })).toBe(0);
    expect(countStaleUpNextLeftovers({ ...base, openedQueueItemUuid: 'x' })).toBe(0);
  });

  it('counts nothing with nothing on the wall or no leftovers', () => {
    expect(countStaleUpNextLeftovers({ ...base, currentClimbQueueItem: null })).toBe(0);
    expect(countStaleUpNextLeftovers({ ...base, queue: [entry('h'), current, entry('q')] })).toBe(0);
  });
});
