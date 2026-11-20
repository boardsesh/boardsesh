import { describe, expect, it } from 'vite-plus/test';
import type { SessionWorkoutPlanStage, SessionWorkoutRepOutcome } from '@boardsesh/workout-summary';
import { WorkoutBlockSchema } from '@boardsesh/public-api';
import { derivePartnerRoundProgress } from '../services/public-api/workout-results';

const block = WorkoutBlockSchema.parse({
  type: 'fourByFour',
  climbCount: 4,
  rounds: 4,
  targetGrade: { scale: 'v', value: 4 },
  restBetweenClimbsSeconds: 0,
  restBetweenRoundsSeconds: 180,
});
if (block.type !== 'fourByFour') throw new Error('Expected fourByFour fixture');
const roundBlock = block;
const stage: SessionWorkoutPlanStage = {
  id: 'wk_fixture:0',
  kind: 'fourByFour',
  pacing: {
    mode: 'afterTick',
    advanceOn: 'round',
    restSeconds: 0,
    roundCount: 4,
    climbsPerRound: 4,
    restBetweenRoundsSeconds: 180,
  },
  items: Array.from({ length: 16 }, (_, position) => ({
    queueItemUuid: `visit-${position}`,
    climbUuid: `climb-${position % 4}`,
    angle: 40,
    position,
  })),
};
const tick = (position: number, status: SessionWorkoutRepOutcome = 'send', suffix = '') => ({
  uuid: `tick-${position}${suffix}`,
  climbUuid: `climb-${position % 4}`,
  angle: 40,
  isMirror: false,
  status,
});
const tickMap = (ticks: ReturnType<typeof tick>[]) =>
  ticks.map((entry) => ({
    tickUuid: entry.uuid,
    queueItemUuid: `visit-${Number(entry.uuid.split('-')[1])}`,
  }));

describe('partner round progress', () => {
  it('reports all four attempted rounds with fourteen sends and two falls', () => {
    const ticks = Array.from({ length: 16 }, (_, position) => tick(position, position < 2 ? 'attempt' : 'send'));
    const result = derivePartnerRoundProgress(roundBlock, stage, ticks, tickMap(ticks));
    expect(result.progress).toEqual({ status: 'completed', completedRounds: 4, plannedRounds: 4, sends: 14, falls: 2 });
    expect(result.positionByTick.get('tick-15')).toEqual({ roundIndex: 3, climbIndex: 3 });
  });

  it('reports three rounds and an unfinished fourth round as partial', () => {
    for (const count of [12, 14]) {
      const ticks = Array.from({ length: count }, (_, position) => tick(position));
      expect(derivePartnerRoundProgress(roundBlock, stage, ticks, tickMap(ticks)).progress).toMatchObject({
        status: 'partial',
        completedRounds: 3,
        plannedRounds: 4,
      });
    }
  });

  it('keeps original positions through reorder and removal; extra ticks never fill a skipped visit', () => {
    const ticks = Array.from({ length: 16 }, (_, position) => tick(position)).filter(
      (entry) => entry.uuid !== 'tick-1',
    );
    ticks.push(tick(0, 'flash', '-extra'));
    const reordered = { ...stage, items: stage.items.filter((item) => item.position !== 1).reverse() };
    const result = derivePartnerRoundProgress(roundBlock, reordered, ticks, tickMap(ticks));
    expect(result.progress).toMatchObject({ status: 'partial', completedRounds: 3, sends: 16 });
    expect(result.positionByTick.get('tick-4')).toEqual({ roundIndex: 1, climbIndex: 0 });
  });

  it('reflects late ticks, deletion, and status edits without stored totals', () => {
    const ticks = Array.from({ length: 16 }, (_, position) => tick(position));
    const mapping = tickMap(ticks);
    expect(derivePartnerRoundProgress(roundBlock, stage, ticks.slice(0, 15), mapping).progress?.completedRounds).toBe(
      3,
    );
    expect(derivePartnerRoundProgress(roundBlock, stage, ticks, mapping).progress?.completedRounds).toBe(4);
    expect(derivePartnerRoundProgress(roundBlock, stage, ticks.slice(1), mapping).progress?.completedRounds).toBe(3);
    ticks[0].status = 'attempt';
    expect(derivePartnerRoundProgress(roundBlock, stage, ticks, mapping).progress).toMatchObject({
      sends: 15,
      falls: 1,
    });
  });

  it('distinguishes not started from historical or ambiguous attribution', () => {
    expect(derivePartnerRoundProgress(roundBlock, stage, [], []).progress?.status).toBe('not_started');
    expect(derivePartnerRoundProgress(roundBlock, undefined, [], []).progress).toBeNull();
    expect(derivePartnerRoundProgress(roundBlock, { ...stage, pacing: undefined }, [], []).progress).toBeNull();
    expect(derivePartnerRoundProgress(roundBlock, stage, [tick(4)], []).progress).toBeNull();
    const malformed = { ...stage, items: [...stage.items, { ...stage.items[0], queueItemUuid: 'duplicate' }] };
    expect(derivePartnerRoundProgress(roundBlock, malformed, [], []).progress).toBeNull();
  });
});
