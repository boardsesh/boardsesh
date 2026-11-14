import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { findStaleUpNextLeftovers } from '../stale-up-next-leftovers';
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
  liveWorkoutQueueItemUuids: new Set<string>(),
  clock: staleClock,
  now,
};

describe('findStaleUpNextLeftovers', () => {
  it('names the suggested entries after Now once the climb on the wall sat 4 h', () => {
    expect(findStaleUpNextLeftovers(base)).toEqual(['x', 'y']);
  });

  it('keeps the climbs of a workout that is still running', () => {
    expect(findStaleUpNextLeftovers({ ...base, liveWorkoutQueueItemUuids: new Set(['y']) })).toEqual(['x']);
  });

  it('keeps them while the climb on the wall is younger than 4 h', () => {
    const youngClock = { queueItemUuid: 'now', changedAt: now - STALE_CURRENT_HOLD_MS + 1 };
    expect(findStaleUpNextLeftovers({ ...base, clock: youngClock })).toEqual([]);
  });

  it('keeps them when the clock is about another climb', () => {
    expect(findStaleUpNextLeftovers({ ...base, clock: { ...staleClock, queueItemUuid: 'other' } })).toEqual([]);
  });

  it('keeps them in a crew, for a step that keeps the queue, and for a move onto a queued entry', () => {
    expect(findStaleUpNextLeftovers({ ...base, inSession: true })).toEqual([]);
    expect(findStaleUpNextLeftovers({ ...base, keepQueue: true })).toEqual([]);
    expect(findStaleUpNextLeftovers({ ...base, openedQueueItemUuid: 'x' })).toEqual([]);
  });

  it('names nothing with nothing on the wall or no leftovers', () => {
    expect(findStaleUpNextLeftovers({ ...base, currentClimbQueueItem: null })).toEqual([]);
    expect(findStaleUpNextLeftovers({ ...base, queue: [entry('h'), current, entry('q')] })).toEqual([]);
  });
});
