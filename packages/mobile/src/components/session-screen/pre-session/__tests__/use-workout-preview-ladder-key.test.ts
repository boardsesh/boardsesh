// The slot key a ladder gets: hardest first changes the slots, so it must change
// the key, while every ascending ladder keeps the key it always had.
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_LADDER_OPTIONS, DEFAULT_PYRAMID_OPTIONS } from '@boardsesh/playlist-generator';
import type { WorkoutBlock, WorkoutFilters } from '../workout-blocks';

vi.mock('expo-crypto', () => ({ randomUUID: () => 'uuid' }));
vi.mock('../select-climbs-for-plan', () => ({ fetchGradePool: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../providers/toast-provider', () => ({ useToast: () => ({ showToast: vi.fn() }) }));

import { getBlockSlotKey } from '../use-workout-preview';

const filters: WorkoutFilters = {
  minAscents: 0,
  minRating: 0,
  onlyTallClimbs: false,
  onlyWideClimbs: false,
  climbBias: 'any',
};
const ladderBlock = (descending?: boolean): WorkoutBlock => ({
  id: 'block',
  kind: 'workout',
  filters,
  options: { ...DEFAULT_LADDER_OPTIONS, targetGrade: 18, ...(descending === undefined ? {} : { descending }) },
});

describe('getBlockSlotKey for a ladder', () => {
  it('leaves an ascending ladder key as it was', () => {
    const key = getBlockSlotKey(ladderBlock());
    expect(key.startsWith('ladder:18:5:2/')).toBe(true);
    expect(getBlockSlotKey(ladderBlock(false))).toBe(key);
  });

  it('adds :down when the ladder runs hardest first', () => {
    expect(getBlockSlotKey(ladderBlock(true)).startsWith('ladder:18:5:2:down/')).toBe(true);
    expect(getBlockSlotKey(ladderBlock(true))).not.toBe(getBlockSlotKey(ladderBlock()));
  });
});

const pyramidBlock = (repeatOnWayDown?: boolean): WorkoutBlock => ({
  id: 'block',
  kind: 'workout',
  filters,
  options: {
    ...DEFAULT_PYRAMID_OPTIONS,
    targetGrade: 18,
    ...(repeatOnWayDown === undefined ? {} : { repeatOnWayDown }),
  },
});

describe('getBlockSlotKey for a pyramid', () => {
  it('leaves a pyramid with a fresh way down keyed as it was', () => {
    const key = getBlockSlotKey(pyramidBlock());
    expect(key.startsWith('pyramid:18:5:1/')).toBe(true);
    expect(getBlockSlotKey(pyramidBlock(false))).toBe(key);
  });

  it('adds :same when the way down repeats the way up', () => {
    expect(getBlockSlotKey(pyramidBlock(true)).startsWith('pyramid:18:5:1:same/')).toBe(true);
  });
});
