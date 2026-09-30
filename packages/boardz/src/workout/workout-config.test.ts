import { describe, expect, it } from 'vitest';
import { getGradesForBoard } from '@boardsesh/board-config';
import { WORKOUTS } from './catalog';
import {
  defaultConfig,
  estimateMinutes,
  plannedGrades,
  usesField,
  workoutTiming,
  workoutTitle,
} from './workout-config';

const moonboardGrades = getGradesForBoard('moonboard');
const SIX_B = 18;

describe('plannedGrades', () => {
  it('builds a pyramid up to the peak and back down', () => {
    const config = { ...defaultConfig('pyramid', SIX_B), warmUp: false };
    expect(plannedGrades(config, moonboardGrades)).toEqual([16, 17, 18, 17, 16]);
  });

  it('builds a warm-up from the grades below the target and nothing else', () => {
    const grades = plannedGrades(defaultConfig('warmUp', SIX_B), moonboardGrades);
    expect(grades).toEqual([14, 15, 16, 17]);
  });

  it('puts every on-the-minute and limit climb at the working grade', () => {
    expect(plannedGrades({ ...defaultConfig('onTheMinute', SIX_B), climbs: 3 }, moonboardGrades)).toEqual([18, 18, 18]);
    expect(plannedGrades(defaultConfig('limitBouldering', 24), moonboardGrades)).toEqual([24, 24, 24]);
  });

  it('picks four climbs for a 4x4, whatever the round count', () => {
    expect(plannedGrades({ ...defaultConfig('fourByFour', SIX_B), rounds: 6 }, moonboardGrades)).toHaveLength(4);
  });

  it('adds the warm-up in front of the main set when asked', () => {
    const grades = plannedGrades({ ...defaultConfig('gradeFocus', SIX_B), climbs: 2, warmUp: true }, moonboardGrades);
    expect(grades).toEqual([14, 15, 16, 17, 18, 18]);
  });

  it('plans nothing for free climbing', () => {
    expect(plannedGrades(defaultConfig('freeClimbing', SIX_B), moonboardGrades)).toEqual([]);
  });
});

describe('workoutTiming', () => {
  it('matches each workout to how it is paced', () => {
    expect(workoutTiming(defaultConfig('pyramid', SIX_B))).toEqual({ kind: 'rest', restSeconds: 120 });
    expect(workoutTiming(defaultConfig('onTheMinute', SIX_B))).toEqual({ kind: 'interval', intervalSeconds: 60 });
    expect(workoutTiming(defaultConfig('fourByFour', SIX_B))).toEqual({
      kind: 'rounds',
      rounds: 4,
      restBetweenClimbsSeconds: 0,
      restBetweenRoundsSeconds: 240,
    });
    expect(workoutTiming(defaultConfig('limitBouldering', SIX_B))).toEqual({ kind: 'limit', restSeconds: 180 });
    expect(workoutTiming(defaultConfig('freeClimbing', SIX_B))).toBeNull();
  });
});

describe('workout setup', () => {
  it('gives every workout in the catalogue a title and at least one setting', () => {
    for (const workout of WORKOUTS) {
      expect(workoutTitle(defaultConfig(workout.kind, SIX_B), '6B')).not.toBe('');
      expect(
        ['climbs', 'steps', 'warmUpLength', 'rounds', 'goalMinutes'].some((field) =>
          usesField(workout.kind, field as Parameters<typeof usesField>[1]),
        ),
      ).toBe(true);
    }
  });

  it('estimates duration in five-minute steps', () => {
    expect(estimateMinutes({ ...defaultConfig('onTheMinute', SIX_B), climbs: 10 }, 10)).toBe(10);
    // Four rounds of about 3 minutes, with three 4-minute rests between them.
    expect(estimateMinutes(defaultConfig('fourByFour', SIX_B), 4)).toBe(25);
    expect(estimateMinutes(defaultConfig('freeClimbing', SIX_B), 0)).toBe(60);
  });
});
