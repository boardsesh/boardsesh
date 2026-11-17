import { describe, expect, it, vi } from 'vitest';
import type { EndedWorkoutRecord } from '../../../lib/ended-workout-store';
import { lastWorkoutSummary, localDaysAgo } from '../last-workout';

const ENDED_AT = new Date(2026, 9, 28, 12).getTime();

function endedWorkout(overrides: Partial<EndedWorkoutRecord> = {}): EndedWorkoutRecord {
  return {
    sessionId: 'session-1',
    run: {
      stages: [
        { id: 'warm', kind: 'warmUp', itemUuids: ['q0'] },
        { id: 'main', kind: 'fourByFour', itemUuids: ['q1', 'q2'], targetGrade: 20 },
      ],
    },
    endedAtMs: ENDED_AT,
    userId: 'user-1',
    ...overrides,
  };
}

describe('lastWorkoutSummary', () => {
  it('counts sends and flashes, not attempts, and keeps the end time', () => {
    const summary = lastWorkoutSummary(
      endedWorkout({
        log: [
          { queueItemUuid: 'q1', status: 'send', climbedAt: '2026-10-28T11:00:00Z', tickUuid: 'tick-1' },
          { queueItemUuid: 'q1', status: 'flash', climbedAt: '2026-10-28T11:05:00Z', tickUuid: 'tick-2' },
          { queueItemUuid: 'q2', status: 'attempt', climbedAt: '2026-10-28T11:10:00Z', tickUuid: 'tick-3' },
        ],
      }),
      () => 'V4',
    );
    expect(summary.sends).toBe(2);
    expect(summary.endedAtMs).toBe(ENDED_AT);
  });

  it('has no sends without a tick log', () => {
    expect(lastWorkoutSummary(endedWorkout(), () => 'V4').sends).toBe(0);
  });

  it("names the main block at the climber's own grade label, on the board the climbs were on", () => {
    const formatGrade = vi.fn((difficultyId: number | null | undefined, boardName?: string | null) =>
      difficultyId === null || difficultyId === undefined ? null : `${boardName}:${difficultyId}`,
    );
    const summary = lastWorkoutSummary(
      endedWorkout({ climbs: { q1: { climbUuid: 'climb-1', angle: 40, boardType: 'moonboard' } } }),
      formatGrade,
    );
    expect(summary.headline).toMatchObject({ mainKind: 'fourByFour', mainTargetGrade: 'moonboard:20', blockCount: 2 });
    expect(formatGrade).toHaveBeenCalledWith(20, 'moonboard');
  });

  it('leaves the grade out for a block with no target grade', () => {
    const summary = lastWorkoutSummary(
      endedWorkout({ run: { stages: [{ id: 'main', kind: 'pyramid', itemUuids: ['q1'] }] } }),
      () => 'V4',
    );
    expect(summary.headline).toMatchObject({ mainKind: 'pyramid', mainTargetGrade: null });
  });
});

describe('localDaysAgo', () => {
  it('is 0 later the same local day, whatever the hour', () => {
    expect(localDaysAgo(new Date(2026, 9, 28, 0, 5).getTime(), new Date(2026, 9, 28, 23, 55).getTime())).toBe(0);
  });

  it('is 1 across local midnight, even a few minutes apart', () => {
    expect(localDaysAgo(new Date(2026, 9, 27, 23, 59).getTime(), new Date(2026, 9, 28, 0, 1).getTime())).toBe(1);
  });

  it('counts whole calendar days, also across a month end', () => {
    expect(localDaysAgo(new Date(2026, 9, 25, 9).getTime(), new Date(2026, 9, 28, 12).getTime())).toBe(3);
    expect(localDaysAgo(new Date(2026, 9, 30, 9).getTime(), new Date(2026, 10, 2, 8).getTime())).toBe(3);
  });

  it('is negative for a time ahead of now', () => {
    expect(localDaysAgo(new Date(2026, 9, 29, 12).getTime(), new Date(2026, 9, 28, 12).getTime())).toBe(-1);
  });
});
