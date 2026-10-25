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
// Cards show only for the climb on the wall: a preview of another climb (a
// crew's swipe) hides them (the inner part stays mounted, so the workout
// finishing meanwhile still shows its card on the way back). A solo swipe is
// not a preview: it moves the wall, and the rest ends with the move, as on Next,
// so swiping back finds no rest card until the next go. They also wait while
// something else owns the board: the end-of-list card or the switch-board gate.
//
// "Workout done" opens when the workout finishes while the player is up, never
// because the player opened on a workout that was already done (the Record
// tab's card says so there), and once per run: adding a block makes a new run,
// whose end gets its own. Whether it is up lives in `workout-done-card-store`,
// not here: a tablet keeps a play pane per tab, and all of them show the one
// card, so closing it on one closes it on every pane. See your workout closes
// it too, since the pane stays up beside the Record tab.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { useQueueActions } from '../../providers/queue-provider';
import { useWorkoutRunner } from '../../hooks/use-workout-runner';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { useSessionTimerDriver } from '../../hooks/use-session-timer-driver';
import { getEffectiveRestPacing, useEffectiveRestPacing } from '../../hooks/use-effective-rest-pacing';
import { nowMs } from '../../lib/clock';
import { restSkipAllowed, skipRestOnWall } from '../../lib/rest-timer-skip';
import {
  announceWorkoutDone,
  closeWorkoutDoneCard,
  holdWorkoutDoneCard,
  useWorkoutDoneCardOpen,
} from '../../lib/workout-done-card-store';
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
  // What the timer really runs on (a crew clock wins over the stage), so Skip
  // rest shows only where the tap, which reads the same, would move the wall.
  const effectivePacing = useEffectiveRestPacing();
  const restState = useRestTimerState();
  const { nextClimb, getQueueSnapshot } = useQueueActions();
  const phase = readout?.phase ?? null;
  const doneCardOpen = useWorkoutDoneCard(run, phase);

  // Go now hides this rest's card; the next go on the climb is a new rest.
  const [hiddenRestKey, setHiddenRestKey] = useState<string | null>(null);
  const wallQueueItemUuid = currentItem?.uuid ?? null;
  const restCard = useMemo(() => {
    if (!readout) return null;
    const skipAllowed =
      readout.current !== null &&
      restSkipAllowed(
        { queueItemUuid: readout.current.queueItemUuid, wallQueueItemUuid, pacing: effectivePacing },
        restState,
      );
    return resolveWorkoutRestCard({ readout, nextItem, skipAllowed });
  }, [readout, nextItem, wallQueueItemUuid, effectivePacing, restState]);
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
  // Closed before leaving: the tablet's pane stays up beside the Record tab, and
  // would keep the modal card (and its Android back handler) over its board.
  const handleSeeWorkout = useCallback(() => {
    closeWorkoutDoneCard();
    onSeeWorkout();
  }, [onSeeWorkout]);

  const onTheWall = currentItem !== null && currentItem.uuid === displayedQueueItemUuid;
  if (readout === null || !onTheWall || suppressed) return null;

  if (doneCardOpen && phase === 'done') {
    return <WorkoutDoneCard totals={readout.totals} onSeeWorkout={handleSeeWorkout} onDismiss={closeWorkoutDoneCard} />;
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
 * Whether "Workout done" is up for `run`: opened when the runner's phase turns
 * `done` while this is mounted (never on a mount that finds it done already),
 * at most once per run across every player, and closed by the climber
 * (`closeWorkoutDoneCard`) or by the last player unmounting.
 */
function useWorkoutDoneCard(run: WorkoutRun, phase: WorkoutRunnerPhase | null): boolean {
  const open = useWorkoutDoneCardOpen(run);
  const previousPhaseRef = useRef(phase);

  // Declared first, so the hold is in place before this mount can announce.
  useEffect(() => holdWorkoutDoneCard(), []);

  useEffect(() => {
    const previousPhase = previousPhaseRef.current;
    previousPhaseRef.current = phase;
    // A readout that appeared already done (null before: no staged climb was
    // queued) is not the workout finishing.
    if (phase !== 'done' || previousPhase === 'done' || previousPhase === null) return;
    announceWorkoutDone(run);
  }, [run, phase]);

  return open;
}
