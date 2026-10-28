import { describe, expect, it } from 'vite-plus/test';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { buildWorkoutClimbGroups, type SessionWorkoutView } from '../session-workout';

const tick = (uuid: string, climbUuid: string, minute: number, userId = 'owner'): SessionDetailTick =>
  ({
    uuid,
    userId,
    climbUuid,
    climbName: climbUuid,
    boardType: 'kilter',
    layoutId: 1,
    angle: 40,
    status: 'send',
    attemptCount: 1,
    isMirror: false,
    isBenchmark: false,
    isNoMatch: false,
    frames: 'p1r1',
    climbedAt: new Date(Date.UTC(2026, 9, 27, 12, minute)).toISOString(),
    upvotes: 0,
  }) as SessionDetailTick;

const climb = (queueItemUuid: string, climbUuid: string, tickUuids: string[]) => ({
  queueItemUuid,
  climbUuid,
  angle: 40,
  isMirror: null,
  name: climbUuid,
  grade: 'V4',
  rawGrade: '6b/V4',
  boardType: 'kilter',
  layoutId: 1,
  frames: 'p1r1',
  renderBoard: null,
  reps: tickUuids.map(() => 'send' as const),
  tickUuids,
  skipped: tickUuids.length === 0,
});

describe('buildWorkoutClimbGroups', () => {
  it('keeps one numbered row per 4x4 set when a climb repeats across sets', () => {
    const workout: SessionWorkoutView = {
      userId: 'owner',
      displayName: null,
      avatarUrl: null,
      offPlan: 0,
      offPlanTickUuids: [],
      updatedAt: '2026-10-27T13:00:00.000Z',
      stages: [
        {
          id: 'main',
          kind: 'fourByFour',
          isCoolDown: false,
          targetGrade: 'V4',
          repsPerSet: 2,
          sets: 3,
          intervalSeconds: null,
          restSeconds: 60,
          tally: { sent: 4, attempts: 0, skipped: 1, climbs: 3 },
          climbs: [climb('q1', 'SAME', ['a', 'b']), climb('q2', 'SAME', ['c', 'd']), climb('q3', 'OTHER', [])],
        },
      ],
    };
    const ticks = ['a', 'b', 'c', 'd'].map((uuid, index) => tick(uuid, 'SAME', index));

    const [block] = buildWorkoutClimbGroups(ticks, workout, 'Unknown');

    expect(block.entries.map((entry) => [entry.key, entry.setNumber, entry.ticks.map((t) => t.uuid)])).toEqual([
      ['q1', 1, ['a', 'b']],
      ['q2', 2, ['c', 'd']],
      ['q3', 3, []],
    ]);
  });
});
