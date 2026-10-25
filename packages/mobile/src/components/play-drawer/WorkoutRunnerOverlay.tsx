// The workout runner over the player's board (#6291, #5380, #6231): the rest
// card while a timed block's rest runs, and "Workout done" once the last climb
// meets its block's rule. No engine of its own: it reads the same
// `useWorkoutRunner` the Record tab's "Your workout" card reads, so the two
// always say the same thing.
//
// Split in two so the player pays nothing without a workout: the outer
// component takes only the run, and the queue, rest-timer and tick-log
// subscriptions live in the inner one, mounted only while a run exists. A crew
// phone without the run (only the builder's phone has it) renders nothing.
//
// Cards show only for the climb on the wall: a swipe to another climb, or a
// preview, hides them (the inner part stays mounted, so the workout finishing
// meanwhile still shows its card on the way back). They also wait while
// something else owns the board: the end-of-list card or the switch-board gate.
//
// "Workout done" opens when the workout finishes while the player is up, never
// because the player opened on a workout that was already done (the Record
// tab's card says so there), and once per run: adding a block makes a new run,
// whose end gets its own.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { useQueueActions } from '../../providers/queue-provider';
import { useWorkoutRunner } from '../../hooks/use-workout-runner';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import { getEffectiveRestPacing, useCrewRestStatus } from '../../hooks/use-effective-rest-pacing';
import { nowMs } from '../../lib/clock';
import { skipRestOnWall } from '../../lib/rest-timer-skip';
import type { WorkoutRunnerPhase } from '../../lib/workout-runner-readout';
import { resolveWorkoutRestCard } from './workout-runner-cards';
import { WorkoutRestCard } from './WorkoutRestCard';
import { WorkoutDoneCard } from './WorkoutDoneCard';

type WorkoutRunnerOverlayProps = {
  sessionId: string | null;
  run: WorkoutRun | null;
  /** The queue item the player shows. The cards are for the climb on the wall only. */
  displayedQueueItemUuid: string | null;
  /** The board the player draws, for the next climb's grade. */
  boardName: string;
  /** Another card or gate owns the board right now (end of the list, wrong board). Every card waits. */
  suppressed: boolean;
  /** "See your workout": the Record tab, once the player is out of the way. */
  onSeeWorkout: () => void;
};

export const WorkoutRunnerOverlay = memo(function WorkoutRunnerOverlay({
  sessionId,
  run,
  ...props
}: WorkoutRunnerOverlayProps) {
  if (sessionId === null || run === null) return null;
  return <WorkoutRunnerOverlayContent sessionId={sessionId} run={run} {...props} />;
});

type WorkoutRunnerOverlayContentProps = Omit<WorkoutRunnerOverlayProps, 'sessionId' | 'run'> & {
  sessionId: string;
  run: WorkoutRun;
};

function WorkoutRunnerOverlayContent({
  sessionId,
  run,
  displayedQueueItemUuid,
  boardName,
  suppressed,
  onSeeWorkout,
}: WorkoutRunnerOverlayContentProps) {
  const { readout, currentItem, nextItem } = useWorkoutRunner(sessionId, run);
  const { role, pacerDisplayName } = useSessionTimerDriver();
  const crewClockUnsupported = useCrewRestStatus() === 'unsupported';
  const { nextClimb, getQueueSnapshot } = useQueueActions();
  const phase = readout?.phase ?? null;
  const doneCard = useWorkoutDoneCard(run, phase);

  // Go now hides this rest's card; the next go on the climb is a new rest.
  const [hiddenRestKey, setHiddenRestKey] = useState<string | null>(null);
  const restCard = useMemo(
    () => (readout ? resolveWorkoutRestCard({ readout, nextItem, crewClockUnsupported }) : null),
    [readout, nextItem, crewClockUnsupported],
  );
  const restCardQueueItemUuid = restCard?.queueItemUuid ?? null;
  const restCardKey = restCard?.key ?? null;

  const handleSkipRest = useCallback(() => {
    if (restCardQueueItemUuid === null) return;
    skipRestOnWall({
      queueItemUuid: restCardQueueItemUuid,
      wallQueueItemUuid: getQueueSnapshot().currentClimbQueueItem?.uuid ?? null,
      pacing: getEffectiveRestPacing(),
      nowMs: nowMs(),
      moveWall: nextClimb,
    });
  }, [restCardQueueItemUuid, getQueueSnapshot, nextClimb]);
  const handleGoNow = useCallback(() => setHiddenRestKey(restCardKey), [restCardKey]);

  const onTheWall = currentItem !== null && currentItem.uuid === displayedQueueItemUuid;
  if (readout === null || !onTheWall || suppressed) return null;

  if (doneCard.open && phase === 'done') {
    return <WorkoutDoneCard totals={readout.totals} onSeeWorkout={onSeeWorkout} onDismiss={doneCard.close} />;
  }
  if (restCard === null || restCard.key === hiddenRestKey) return null;
  return (
    <WorkoutRestCard
      model={restCard}
      boardName={boardName}
      role={role}
      pacerDisplayName={pacerDisplayName}
      onSkipRest={handleSkipRest}
      onGoNow={handleGoNow}
    />
  );
}

/**
 * Whether "Workout done" is up: opened when the runner's phase turns `done`
 * while this is mounted (never on a mount that finds it done already), at most
 * once per run, and closed by the climber.
 */
function useWorkoutDoneCard(run: WorkoutRun, phase: WorkoutRunnerPhase | null): { open: boolean; close: () => void } {
  const [openForRun, setOpenForRun] = useState<WorkoutRun | null>(null);
  const previousPhaseRef = useRef(phase);
  const announcedRunRef = useRef<WorkoutRun | null>(null);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    // A readout that appeared already done (null before: no staged climb was
    // queued) is not the workout finishing.
    if (phase !== 'done' || previousPhase === 'done' || previousPhase === null) return;
    if (announcedRunRef.current === run) return;
    announcedRunRef.current = run;
    setOpenForRun(run);
  }, [run, phase]);

  const close = useCallback(() => setOpenForRun(null), []);
  return { open: openForRun === run, close };
}
