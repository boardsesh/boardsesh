import { describe, expect, it } from 'vitest';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { MAX_SESSION_WORKOUT_ITEMS, parseSessionWorkoutPlan } from '@boardsesh/workout-summary';
import {
  buildRecordSessionWorkoutInput,
  buildSessionWorkoutPlan,
  captureWorkoutRunClimbs,
  isServerSessionId,
} from '../session-workout-plan';
import type { WorkoutRunRecord } from '../workout-run-store';

const SESSION_ID = '6f1c2a8e-3b4d-4c5e-9f60-7a8b9c0d1e2f';

const record: WorkoutRunRecord = {
  sessionId: SESSION_ID,
  run: {
    stages: [
      { id: 'warm', kind: 'warmUp', itemUuids: ['w1'] },
      {
        id: 'four',
        kind: 'fourByFour',
        targetGrade: 18,
        itemUuids: ['f1', 'f2'],
        pacing: {
          mode: 'afterTick',
          restSeconds: 10.4,
          advanceOn: 'set',
          sets: { repsPerSet: 4, restBetweenSetsSeconds: 180 },
        },
      },
      {
        id: 'otm',
        kind: 'onTheMinute',
        targetGrade: 16,
        itemUuids: ['o1'],
        pacing: { mode: 'onTheMinute', restSeconds: 60 },
      },
      { id: 'cool', kind: 'warmUp', coolDown: true, itemUuids: ['c1'] },
    ],
  },
  climbs: {
    w1: { climbUuid: 'climb-w1', angle: 40 },
    f1: { climbUuid: 'climb-f1', angle: 40, isMirror: false, name: 'F1' },
    f2: { climbUuid: 'climb-f2', angle: 40 },
    o1: { climbUuid: 'climb-o1', angle: 40 },
    c1: { climbUuid: 'climb-c1', angle: 40 },
  },
  log: [
    { queueItemUuid: 'f1', status: 'attempt', climbedAt: '2026-10-28T10:00:00Z', tickUuid: 'tick-1' },
    { queueItemUuid: 'f1', status: 'send', climbedAt: '2026-10-28T10:01:00Z', tickUuid: 'tick-2' },
    // A save whose answer never came back: no uuid to map.
    { queueItemUuid: 'f2', status: 'send', climbedAt: '2026-10-28T10:02:00Z' },
    // A climb the run never captured is not in the plan.
    { queueItemUuid: 'gone', status: 'send', climbedAt: '2026-10-28T10:03:00Z', tickUuid: 'tick-3' },
  ],
};

describe('isServerSessionId', () => {
  it('takes the uuid createSession mints, never a story, fake or daily card id', () => {
    expect(isServerSessionId(SESSION_ID)).toBe(true);
    expect(isServerSessionId('story-summary-workout')).toBe(false);
    expect(isServerSessionId('daily:user-1:2026-10-28')).toBe(false);
    expect(isServerSessionId('')).toBe(false);
    expect(isServerSessionId(null)).toBe(false);
  });
});

describe('captureWorkoutRunClimbs', () => {
  it("keeps each queue item's climb, angle and mirror, plus what the summary draws", () => {
    const items = [
      {
        uuid: 'q1',
        climb: { uuid: 'climb-1', angle: 40, mirrored: true, name: 'Crimps', difficulty: '6a/V3', boardType: 'kilter' },
      },
      { uuid: 'q2', climb: { uuid: 'climb-2', angle: 25 } },
      { uuid: 'q3', climb: { uuid: 'climb-3' } },
    ] as unknown as ClimbQueueItem[];
    expect(captureWorkoutRunClimbs(items)).toEqual({
      q1: { climbUuid: 'climb-1', angle: 40, isMirror: true, name: 'Crimps', difficulty: '6a/V3', boardType: 'kilter' },
      q2: { climbUuid: 'climb-2', angle: 25 },
    });
  });
});

describe('buildRecordSessionWorkoutInput', () => {
  it('sends every stage with its captured climbs and flattened pacing, at the revision given', () => {
    const input = buildRecordSessionWorkoutInput(record, 7);
    expect(input).toEqual({
      sessionId: SESSION_ID,
      revision: 7,
      stages: [
        { id: 'warm', kind: 'warmUp', items: [{ queueItemUuid: 'w1', climbUuid: 'climb-w1', angle: 40 }] },
        {
          id: 'four',
          kind: 'fourByFour',
          targetGrade: 18,
          pacing: { mode: 'afterTick', restSeconds: 10, advanceOn: 'set', repsPerSet: 4, restBetweenSetsSeconds: 180 },
          items: [
            { queueItemUuid: 'f1', climbUuid: 'climb-f1', angle: 40, isMirror: false },
            { queueItemUuid: 'f2', climbUuid: 'climb-f2', angle: 40 },
          ],
        },
        {
          id: 'otm',
          kind: 'onTheMinute',
          targetGrade: 16,
          pacing: { mode: 'onTheMinute', restSeconds: 60 },
          items: [{ queueItemUuid: 'o1', climbUuid: 'climb-o1', angle: 40 }],
        },
        {
          id: 'cool',
          kind: 'warmUp',
          coolDown: true,
          items: [{ queueItemUuid: 'c1', climbUuid: 'climb-c1', angle: 40 }],
        },
      ],
      // Only ticks with a uuid, on an item of the plan.
      ticks: [
        { tickUuid: 'tick-1', queueItemUuid: 'f1' },
        { tickUuid: 'tick-2', queueItemUuid: 'f1' },
      ],
    });
  });

  it('is nothing for a story or fake session', () => {
    expect(buildRecordSessionWorkoutInput({ ...record, sessionId: 'story-summary-workout' }, 1)).toBeNull();
  });

  it('is nothing when no climb was captured', () => {
    expect(buildRecordSessionWorkoutInput({ ...record, climbs: undefined }, 1)).toBeNull();
  });

  it('maps a tick logged twice once, on its newest entry', () => {
    const relogged: WorkoutRunRecord = {
      ...record,
      log: [
        { queueItemUuid: 'w1', status: 'send', climbedAt: '2026-10-28T10:00:00Z', tickUuid: 'tick-1' },
        { queueItemUuid: 'f1', status: 'send', climbedAt: '2026-10-28T10:00:00Z', tickUuid: 'tick-1' },
      ],
    };
    expect(buildRecordSessionWorkoutInput(relogged, 1)?.ticks).toEqual([{ tickUuid: 'tick-1', queueItemUuid: 'f1' }]);
  });
});

describe('buildSessionWorkoutPlan', () => {
  it('names an item in two stages once, so the server takes the plan', () => {
    const plan = buildSessionWorkoutPlan({
      run: {
        stages: [
          { id: 'a', kind: 'volume', itemUuids: ['f1'] },
          { id: 'b', kind: 'pyramid', itemUuids: ['f1', 'f2'] },
        ],
      },
      climbs: record.climbs,
    });
    expect(plan?.stages.map((stage) => stage.items.map((item) => item.queueItemUuid))).toEqual([['f1'], ['f2']]);
  });

  it(`keeps the first ${MAX_SESSION_WORKOUT_ITEMS} items rather than have the write refused`, () => {
    const uuids = Array.from({ length: MAX_SESSION_WORKOUT_ITEMS + 5 }, (_, index) => `item-${index}`);
    const plan = buildSessionWorkoutPlan({
      run: { stages: [{ id: 'big', kind: 'volume', itemUuids: uuids }] },
      climbs: Object.fromEntries(uuids.map((uuid) => [uuid, { climbUuid: `climb-${uuid}`, angle: 40 }])),
    });
    expect(plan?.stages[0]?.items).toHaveLength(MAX_SESSION_WORKOUT_ITEMS);
    expect(parseSessionWorkoutPlan(plan)).not.toBeNull();
  });
});
