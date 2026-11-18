import { describe, expect, it } from 'vite-plus/test';
import type { CreateWorkout } from '@boardsesh/public-api';
import { getGradesForBoard } from '@boardsesh/board-config';
import { buildPartnerWorkoutPlan, resolvePartnerGrade } from '../partner-workout-plan';
import { isAppWorkoutId, parseAppWorkoutId } from '../partner-workout-link';

describe('partner workout planning', () => {
  it('preserves a standalone warm-up’s explicit range and exact count', () => {
    const spec: CreateWorkout = {
      title: 'Warm up',
      externalRef: 'warm',
      blocks: [{ type: 'warmUp', climbCount: 6, gradeRange: { scale: 'v', from: 0, to: 3 } }],
    };
    const grades = getGradesForBoard('kilter');
    const planned = buildPartnerWorkoutPlan(spec, grades, 'wk_one');
    expect(planned.slots).toHaveLength(6);
    expect(planned.slots[0].grade).toBe(resolvePartnerGrade({ scale: 'v', value: 0 }, grades).grade);
    expect(planned.slots.at(-1)?.grade).toBe(resolvePartnerGrade({ scale: 'v', value: 3 }, grades).grade);
    expect(planned.plan.stages).toHaveLength(1);
    expect(planned.plan.stages[0].kind).toBe('warmUp');
  });

  it('clamps a low MoonBoard target and reports the affected block', () => {
    const spec: CreateWorkout = {
      title: 'Easy',
      externalRef: 'easy',
      blocks: [{ type: 'gradeFocus', climbCount: 3, targetGrade: { scale: 'v', value: 0 } }],
    };
    const grades = getGradesForBoard('moonboard');
    const planned = buildPartnerWorkoutPlan(spec, grades, 'wk_two');
    expect(planned.clampedBlocks).toEqual([0]);
    expect(planned.slots.every((slot) => slot.grade === grades[0].difficulty_id)).toBe(true);
    expect(resolvePartnerGrade({ scale: 'font', value: '3' }, grades).grade).toBe(grades[0].difficulty_id);
  });

  it('keeps freeform blocks visible in the spec without inventing queued climbs', () => {
    const spec: CreateWorkout = {
      title: 'Freestyle',
      externalRef: 'free',
      blocks: [
        { type: 'freeClimbing', durationSeconds: 600 },
        {
          type: 'fourByFour',
          targetGrade: { scale: 'v', value: 4 },
          climbCount: 4,
          rounds: 4,
          restBetweenClimbsSeconds: 0,
          restBetweenRoundsSeconds: 180,
        },
        { type: 'limitBouldering', targetGrade: { scale: 'v', value: 6 }, climbCount: 3 },
      ],
    };
    expect(buildPartnerWorkoutPlan(spec, getGradesForBoard('kilter'), 'wk_free')).toEqual({
      plan: { stages: [] },
      slots: [],
      clampedBlocks: [],
    });
  });

  it('keeps native stage IDs aligned with original block indices around freeform blocks', () => {
    const spec: CreateWorkout = {
      title: 'Mixed',
      externalRef: 'mixed',
      blocks: [
        { type: 'freeClimbing' },
        { type: 'onTheMinute', targetGrade: { scale: 'font', value: '6B+' }, climbCount: 5, intervalSeconds: 75 },
      ],
    };
    const planned = buildPartnerWorkoutPlan(spec, getGradesForBoard('kilter'), 'wk_mix');
    expect(planned.plan.stages[0].id).toBe('wk_mix:1');
    expect(planned.plan.stages[0]).toMatchObject({ kind: 'onTheMinute', options: { intervalSeconds: 75 } });
    expect(planned.slots).toHaveLength(5);
  });

  it('reaches the requested pyramid peak with an even climb count', () => {
    const spec: CreateWorkout = {
      title: 'Pyramid',
      externalRef: 'pyramid',
      blocks: [{ type: 'pyramid', climbCount: 4, gradeRange: { scale: 'v', from: 1, to: 5 } }],
    };
    const grades = getGradesForBoard('kilter');
    const planned = buildPartnerWorkoutPlan(spec, grades, 'wk_pyramid');
    const low = resolvePartnerGrade({ scale: 'v', value: 1 }, grades).grade;
    const high = resolvePartnerGrade({ scale: 'v', value: 5 }, grades).grade;
    expect(planned.slots.map((slot) => slot.grade)).toEqual([low, high, high, low]);
  });
});

describe('partner workout link parsing', () => {
  it.each([
    'https://www.boardsesh.com/w/wk_one',
    'com.boardsesh.app://w/wk_one',
    '/w/wk_one',
    'https://www.boardsesh.com/es/w/wk_one',
  ])('accepts %s', (url) => {
    expect(parseAppWorkoutId(url)).toBe('wk_one');
  });
  it.each([
    'https://evil.example/w/wk_one',
    'https://www.boardsesh.com.evil.example/w/wk_one',
    '/w/../auth',
    'javascript:/w/wk_one',
    '/w/wk_one/extra',
  ])('refuses %s', (url) => {
    expect(parseAppWorkoutId(url)).toBeNull();
  });
  it('refuses malformed pending IDs', () => {
    expect(isAppWorkoutId('../auth/login')).toBe(false);
    expect(isAppWorkoutId('wk_valid')).toBe(true);
  });
});
