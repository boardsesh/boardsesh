import { describe, expect, it } from 'vitest';
import { WORKOUT_TYPES } from '@boardsesh/playlist-generator';
import { WORKOUTS } from './catalog';

describe('workout catalog', () => {
  it('lists each workout kind once', () => {
    const kinds = WORKOUTS.map((workout) => workout.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it('only routes workouts the playlist generator can plan to the generator', () => {
    const plannableTypes = new Set<string>(WORKOUT_TYPES.map((workoutType) => workoutType.type));
    const generatorKinds = WORKOUTS.filter(
      // The warm-up is the generator's `warmUp` option, not one of its workout types.
      (workout) => workout.engine === 'generator' && workout.kind !== 'warmUp',
    ).map((workout) => workout.kind);

    expect(generatorKinds.length).toBeGreaterThan(0);
    for (const kind of generatorKinds) {
      expect(plannableTypes.has(kind)).toBe(true);
    }
  });
});
