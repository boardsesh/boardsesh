import { describe, expect, it, vi } from 'vite-plus/test';
import { MAX_SESSION_WORKOUT_ITEMS } from '@boardsesh/workout-summary';
import type { ClimbQueueItem } from '@boardsesh/queue';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { appendPartnerWorkout } from '../partner-workout-queue';

const items = [{ uuid: 'first' }, { uuid: 'second' }] as ClimbQueueItem[];
const run: WorkoutRun = { stages: [{ id: 'wk_one:0', kind: 'volume', itemUuids: ['first', 'second'] }] };

describe('partner workout queue handoff', () => {
  it('passes no activate-first option and records only the climbs that fit', () => {
    const append = vi.fn(() => 1);
    const existing: WorkoutRun = { stages: [{ id: 'earlier', kind: 'gradeFocus', itemUuids: ['existing'] }] };
    const result = appendPartnerWorkout({ items, run, existingRun: existing, appendQueueItems: append });
    expect(append).toHaveBeenCalledExactlyOnceWith(items);
    expect(result.partnerRun.stages[0].itemUuids).toEqual(['first']);
    expect(result.combinedRun.stages.map((stage) => stage.id)).toEqual(['earlier', 'wk_one:0']);
    expect(result.landedItems).toEqual([items[0]]);
  });

  it('allows a freeform-only workout without inventing a queue or moving the wall', () => {
    const append = vi.fn();
    const result = appendPartnerWorkout({
      items: [],
      run: { stages: [] },
      existingRun: null,
      appendQueueItems: append,
    });
    expect(append).not.toHaveBeenCalled();
    expect(result).toEqual({ landedItems: [], partnerRun: { stages: [] }, combinedRun: { stages: [] } });
  });
  it('keeps a committed non-round attachment within remaining stored-plan capacity', () => {
    const existing: WorkoutRun = {
      stages: [
        {
          id: 'earlier',
          kind: 'volume',
          itemUuids: Array.from({ length: MAX_SESSION_WORKOUT_ITEMS - 1 }, (_, index) => `earlier-${index}`),
        },
      ],
    };
    const append = vi.fn((accepted: ClimbQueueItem[]) => accepted.length);
    const result = appendPartnerWorkout({ items, run, existingRun: existing, appendQueueItems: append });
    expect(append).toHaveBeenCalledExactlyOnceWith([items[0]]);
    expect(result.landedItems).toEqual([items[0]]);
    expect(result.combinedRun.stages.flatMap((stage) => stage.itemUuids)).toHaveLength(MAX_SESSION_WORKOUT_ITEMS);
  });

  it('still refuses to shorten a round plan before touching the queue', () => {
    const roundRun: WorkoutRun = { stages: [{ ...run.stages[0], kind: 'fourByFour' }] };
    const existing: WorkoutRun = {
      stages: [
        {
          id: 'earlier',
          kind: 'volume',
          itemUuids: Array.from({ length: MAX_SESSION_WORKOUT_ITEMS - 1 }, (_, index) => `earlier-${index}`),
        },
      ],
    };
    const append = vi.fn((accepted: ClimbQueueItem[]) => accepted.length);
    expect(() =>
      appendPartnerWorkout({ items, run: roundRun, existingRun: existing, appendQueueItems: append }),
    ).toThrow('capacity');
    expect(append).not.toHaveBeenCalled();
  });
});
