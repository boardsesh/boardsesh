import { describe, expect, it } from 'vitest';
import {
  MAX_SESSION_WORKOUT_ITEMS,
  MAX_SESSION_WORKOUT_STAGES,
  MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES,
  parseSessionWorkoutPlan,
  parseSessionWorkoutTickMap,
} from '../index';

const item = (index: number) => ({ queueItemUuid: `q-${index}`, climbUuid: `c-${index}`, angle: 40 });

describe('parseSessionWorkoutPlan', () => {
  it('keeps a valid plan and drops nulls and unknown keys', () => {
    const parsed = parseSessionWorkoutPlan({
      version: 1,
      extra: 'dropped',
      stages: [
        {
          id: 's1',
          kind: 'fourByFour',
          coolDown: null,
          targetGrade: 20,
          pacing: {
            mode: 'afterTick',
            restSeconds: 60,
            advanceOn: 'set',
            repsPerSet: 4,
            restBetweenSetsSeconds: 240,
            sets: { ignored: true },
          },
          items: [{ queueItemUuid: 'q1', climbUuid: 'c1', angle: 40, isMirror: null, name: 'dropped' }],
        },
      ],
    });
    expect(parsed).toEqual({
      version: 1,
      stages: [
        {
          id: 's1',
          kind: 'fourByFour',
          targetGrade: 20,
          pacing: { mode: 'afterTick', restSeconds: 60, advanceOn: 'set', repsPerSet: 4, restBetweenSetsSeconds: 240 },
          items: [{ queueItemUuid: 'q1', climbUuid: 'c1', angle: 40 }],
        },
      ],
    });
  });

  it('passes an unknown kind through', () => {
    const parsed = parseSessionWorkoutPlan({ version: 1, stages: [{ id: 's', kind: 'campusLadder', items: [] }] });
    expect(parsed?.stages[0].kind).toBe('campusLadder');
  });

  it.each([
    ['not an object', 'plan'],
    ['another version', { version: 2, stages: [] }],
    ['a stage without an id', { version: 1, stages: [{ kind: 'volume', items: [] }] }],
    ['an empty kind', { version: 1, stages: [{ id: 's', kind: '', items: [] }] }],
    ['a kind with punctuation', { version: 1, stages: [{ id: 's', kind: 'four-by-four', items: [] }] }],
    ['a kind starting with a digit', { version: 1, stages: [{ id: 's', kind: '4x4', items: [] }] }],
    ['a kind over 32 characters', { version: 1, stages: [{ id: 's', kind: 'k'.repeat(33), items: [] }] }],
    ['a long string', { version: 1, stages: [{ id: 'x'.repeat(65), kind: 'volume', items: [] }] }],
    ['a fractional angle', { version: 1, stages: [{ id: 's', kind: 'volume', items: [{ ...item(1), angle: 40.5 }] }] }],
    [
      'an unknown pacing mode',
      { version: 1, stages: [{ id: 's', kind: 'volume', pacing: { mode: 'x', restSeconds: 1 }, items: [] }] },
    ],
    ['a string grade', { version: 1, stages: [{ id: 's', kind: 'volume', targetGrade: '20', items: [] }] }],
    [
      'a repeated stage id',
      {
        version: 1,
        stages: [
          { id: 's', kind: 'volume', items: [] },
          { id: 's', kind: 'volume', items: [] },
        ],
      },
    ],
    [
      'a queue item in two stages',
      {
        version: 1,
        stages: [
          { id: 'a', kind: 'volume', items: [item(1)] },
          { id: 'b', kind: 'volume', items: [item(1)] },
        ],
      },
    ],
  ])('rejects %s', (_label, candidate) => {
    expect(parseSessionWorkoutPlan(candidate)).toBeNull();
  });

  it('enforces the stage cap', () => {
    const stages = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ id: `s-${index}`, kind: 'volume', items: [] }));
    expect(parseSessionWorkoutPlan({ version: 1, stages: stages(MAX_SESSION_WORKOUT_STAGES) })).not.toBeNull();
    expect(parseSessionWorkoutPlan({ version: 1, stages: stages(MAX_SESSION_WORKOUT_STAGES + 1) })).toBeNull();
  });

  it('enforces the item cap across stages', () => {
    const plan = (count: number) => ({
      version: 1,
      stages: [
        { id: 'a', kind: 'volume', items: Array.from({ length: 100 }, (_, index) => item(index)) },
        { id: 'b', kind: 'volume', items: Array.from({ length: count - 100 }, (_, index) => item(index + 100)) },
      ],
    });
    expect(parseSessionWorkoutPlan(plan(MAX_SESSION_WORKOUT_ITEMS))).not.toBeNull();
    expect(parseSessionWorkoutPlan(plan(MAX_SESSION_WORKOUT_ITEMS + 1))).toBeNull();
  });
});

describe('parseSessionWorkoutTickMap', () => {
  it('keeps the first entry for a repeated tick', () => {
    expect(
      parseSessionWorkoutTickMap([
        { tickUuid: 't', queueItemUuid: 'q1' },
        { tickUuid: 't', queueItemUuid: 'q2' },
      ]),
    ).toEqual([{ tickUuid: 't', queueItemUuid: 'q1' }]);
  });

  it('rejects malformed entries and the over-cap map', () => {
    expect(parseSessionWorkoutTickMap([{ tickUuid: 't' }])).toBeNull();
    expect(parseSessionWorkoutTickMap({})).toBeNull();
    const entries = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ tickUuid: `t-${index}`, queueItemUuid: 'q' }));
    expect(parseSessionWorkoutTickMap(entries(MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES))).toHaveLength(
      MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES,
    );
    expect(parseSessionWorkoutTickMap(entries(MAX_SESSION_WORKOUT_TICK_MAP_ENTRIES + 1))).toBeNull();
  });
});
