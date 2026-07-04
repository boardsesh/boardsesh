import { describe, expect, it } from 'vite-plus/test';
import type { ClimbQueueItem } from '../../queue-control/types';
import { toClimbQueueItemInput } from '../types';

function makeItem(overrides: Partial<ClimbQueueItem['climb']> = {}): ClimbQueueItem {
  return {
    uuid: 'item-1',
    climb: {
      uuid: 'climb-1',
      setter_username: 'setter',
      name: 'Proj Braj',
      description: '',
      frames: 'p1086r15p1113r15',
      angle: 40,
      ascensionist_count: 3,
      difficulty: 'V5',
      quality_average: '3.0',
      stars: 3,
      difficulty_error: '0.1',
      benchmark_difficulty: null,
      ...overrides,
    },
    addedBy: 'user-1',
    suggested: false,
  };
}

describe('toClimbQueueItemInput', () => {
  it('round-trips board identity so peers can classify spill climbs', () => {
    const input = toClimbQueueItemInput(makeItem({ boardType: 'kilter', layoutId: 1 }));
    expect(input.climb.boardType).toBe('kilter');
    expect(input.climb.layoutId).toBe(1);
  });

  it('sends null layoutId (not undefined) when the climb has no identity', () => {
    const input = toClimbQueueItemInput(makeItem({ boardType: undefined, layoutId: undefined }));
    expect(input.climb.boardType).toBeUndefined();
    expect(input.climb.layoutId).toBeNull();
  });
});
