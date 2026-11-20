import { describe, expect, it } from 'vite-plus/test';
import { CreateWorkoutSchema, WorkoutBlockSchema, WorkoutResultsSchema, workoutBlockSupport } from '../workouts';

const fourByFour = {
  type: 'fourByFour',
  targetGrade: { scale: 'v', value: 4 },
  climbCount: 4,
  rounds: 4,
  restBetweenClimbsSeconds: 0,
  restBetweenRoundsSeconds: 180,
} as const;

describe('workout exercise references', () => {
  it('preserves optional references on every block type and normalizes like workout references', () => {
    const blocks = [
      fourByFour,
      { type: 'warmUp', climbCount: 4, gradeRange: { scale: 'v', from: 0, to: 3 } },
      ...['volume', 'gradeFocus', 'onTheMinute', 'limitBouldering'].map((type) => ({
        type,
        climbCount: 4,
        targetGrade: { scale: 'v', value: 3 },
      })),
      ...['pyramid', 'ladder'].map((type) => ({ type, climbCount: 4, gradeRange: { scale: 'v', from: 1, to: 3 } })),
      { type: 'freeClimbing' },
    ];
    for (const block of blocks) {
      expect(WorkoutBlockSchema.parse({ ...block, externalRef: ' exercise-123 ' }).externalRef).toBe('exercise-123');
      expect(WorkoutBlockSchema.parse(block).externalRef).toBeUndefined();
    }
  });

  it('rejects empty, long, and duplicate normalized block references at the field path', () => {
    for (const externalRef of ['', '   ', 'a'.repeat(201)])
      expect(WorkoutBlockSchema.safeParse({ ...fourByFour, externalRef }).success).toBe(false);
    const parsed = CreateWorkoutSchema.safeParse({
      externalRef: 'day-123',
      title: 'Today',
      blocks: [
        { ...fourByFour, externalRef: 'four' },
        { ...fourByFour, externalRef: ' four ' },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0].path).toEqual(['blocks', 1, 'externalRef']);
  });

  it('allows blocks without references and the same exercise reference in different workouts', () => {
    for (const externalRef of ['day-1', 'day-2']) {
      expect(
        CreateWorkoutSchema.parse({
          externalRef,
          title: 'Today',
          blocks: [{ ...fourByFour, externalRef: 'four' }, fourByFour],
        }).blocks[0].externalRef,
      ).toBe('four');
    }
    expect(workoutBlockSupport(WorkoutBlockSchema.parse(fourByFour))).toBe('native');
  });
});

describe('workout result round contract', () => {
  it('separates exercise progress from session completion and accepts legacy unknown progress', () => {
    const session = {
      startedAt: '2026-11-20T17:00:00Z',
      endedAt: '2026-11-20T18:00:00Z',
      durationSeconds: 3600,
      timezone: null,
      notes: null,
      board: { type: 'kilter', name: null, layout: null, size: null, angle: 40 },
    };
    for (const progress of [
      undefined,
      null,
      {
        status: 'partial',
        completedRounds: 3,
        plannedRounds: 4,
        sends: 10,
        falls: 2,
      },
    ]) {
      const result = WorkoutResultsSchema.parse({
        completion: 'ended',
        session,
        ticks: [],
        blocks: [
          { index: 0, externalRef: 'exercise', type: 'fourByFour', support: 'native', planned: fourByFour, progress },
        ],
      });
      expect(result.blocks[0].progress).toEqual(progress);
      expect(result.completion).toBe('ended');
    }
  });
});
