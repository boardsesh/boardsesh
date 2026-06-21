import { describe, it, expect, vi } from 'vitest';
import type { Climb } from '@boardsesh/shared-schema';

vi.mock('expo-crypto', () => ({
  randomUUID: () => 'generated-uuid',
}));

import { climbToQueueItem } from '../climb-to-queue-item';

// A climb queued from search / detail must keep its multi-frame playback
// metadata so playback uses the setter's pace rather than DEFAULT_PACE_MS.
// climbToQueueItem hand-picks the climb fields (a whole-response copy would
// fail server validation), so dropping framesCount/framesPace silently regresses
// pacing. This round-trip pins them.

function makeClimb(overrides: Partial<Climb> = {}): Climb {
  return {
    uuid: 'climb-1',
    setter_username: 'setter',
    name: 'Variable Speed Circuit',
    frames: 'p1r12p2r13',
    angle: 40,
    ascensionist_count: 5,
    difficulty: '21',
    quality_average: '3.0',
    stars: 3,
    difficulty_error: '0.5',
    benchmark_difficulty: null,
    is_no_match: false,
    userAscents: null,
    userAttempts: null,
    framesCount: 4,
    framesPace: 1200,
    ...overrides,
  };
}

describe('climbToQueueItem (SEED-2 frame metadata)', () => {
  it('carries framesCount and framesPace from the source climb', () => {
    const result = climbToQueueItem(makeClimb());

    expect(result.climb.framesCount).toBe(4);
    expect(result.climb.framesPace).toBe(1200);
  });

  it('passes null frame metadata through unchanged (static climb)', () => {
    const result = climbToQueueItem(makeClimb({ framesCount: null, framesPace: null }));

    expect(result.climb.framesCount).toBeNull();
    expect(result.climb.framesPace).toBeNull();
  });
});
