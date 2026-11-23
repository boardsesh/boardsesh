import { describe, expect, it } from 'vitest';
import { locateInRun } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { resolveWorkoutRestCard } from '../../components/play-drawer/workout-runner-cards';
import { restorePartnerWorkoutRun } from '../partner-workout-initial-seed';
import { resolveStageRestPacing } from '../rest-timer-pacing';
import { describeWorkoutRunner } from '../workout-runner-readout';
import { formatWorkoutStageParts, formatWorkoutStagePositionWithGo } from '../workout-run-readout';

// A server copy after History was trimmed and the third visit of round two
// removed. Its surviving visits retain their original positions.
const positions = [4, 5, 7, 8, 15];
const queue = positions.map((position) => `visit-${position}`);

function readoutAt(position: number, restSeconds = 30) {
  const restored = restorePartnerWorkoutRun({
    version: 1,
    stages: [
      {
        id: 'partner:0',
        kind: 'fourByFour',
        pacing: {
          mode: 'afterTick',
          restSeconds,
          advanceOn: 'round',
          roundCount: 4,
          climbsPerRound: 4,
          restBetweenRoundsSeconds: 180,
        },
        items: positions.map((ordinal) => ({
          queueItemUuid: `visit-${ordinal}`,
          climbUuid: `climb-${ordinal % 4}`,
          angle: 40,
          position: ordinal,
        })),
      },
    ],
  });
  if (!restored) throw new Error('Expected the saved partner run');
  const currentUuid = `visit-${position}`;
  const nextUuid = queue[queue.indexOf(currentUuid) + 1] ?? null;
  const stagePacing = resolveStageRestPacing({
    sessionId: 'session',
    run: restored.run,
    position: locateInRun(restored.run, currentUuid, queue),
    queueItemUuid: currentUuid,
    repsLogged: 1,
  });
  const readout = describeWorkoutRunner({
    run: restored.run,
    queueUuids: queue,
    currentUuid,
    nextUuid,
    log: [{ queueItemUuid: currentUuid, status: 'attempt', climbedAt: '2026-11-23T10:00:00Z' }],
    rest: {
      armed: true,
      isRunning: true,
      anchorMs: 1000,
      lastTick: { queueItemUuid: currentUuid, status: 'attempt' },
      stagePacing,
      queueEnded: false,
    },
    canAdvanceQueue: true,
  });
  if (!readout) throw new Error('Expected the partner runner readout');
  const card = resolveWorkoutRestCard({
    readout,
    nextItem: nextUuid ? ({ uuid: nextUuid } as ClimbQueueItem) : null,
    skipAllowed: true,
  });
  return { readout, card };
}

const t = (key: string, options?: Record<string, string | number>) => `${key}:${JSON.stringify(options)}`;

describe('partner round UI after restoring an edited queue', () => {
  it('names the original round in the player, spoken position and rest card after a fall', () => {
    const { readout, card } = readoutAt(7);
    expect(readout.current?.go).toEqual({ kind: 'round', number: 2, total: 4, climb: 4, climbs: 4 });
    expect(readout.rest).toMatchObject({ closesRound: true, closesSet: false, targetSeconds: 180 });
    expect(card?.heading).toEqual({ kind: 'roundDone', round: 2 });
    expect(card?.action).toBe('skipRest');
    if (!readout.position || !readout.current) throw new Error('Expected the current visit');
    const numbers = {
      stage: 'mobile.session.preGeneratorFourByFour:undefined',
      round: 2,
      rounds: 4,
      climb: 4,
      climbs: 4,
    };
    expect(formatWorkoutStagePositionWithGo(readout.position, readout.current.go, t)).toBe(
      `mobile.session.workoutStageRoundPosition:${JSON.stringify(numbers)}`,
    );
    expect(formatWorkoutStageParts(readout.position, readout.current.go, t).accessibilityLabel).toBe(
      `mobile.session.workoutStageTopBarRoundAria:${JSON.stringify(numbers)}`,
    );
  });

  it('does not turn a gap into a round boundary or add a rest to a zero-rest visit', () => {
    const { readout, card } = readoutAt(5, 0);
    expect(readout.current?.go).toEqual({ kind: 'round', number: 2, total: 4, climb: 2, climbs: 4 });
    expect(readout.rest).toMatchObject({ closesRound: false, targetSeconds: 0 });
    expect(card?.heading).not.toEqual({ kind: 'roundDone', round: 2 });
  });

  it('finishes the final visit without inventing a final round-rest card', () => {
    const { readout, card } = readoutAt(15);
    expect(readout.phase).toBe('done');
    expect(readout.rest).toMatchObject({ closesRound: true, targetSeconds: 0 });
    expect(card).toBeNull();
  });
});
