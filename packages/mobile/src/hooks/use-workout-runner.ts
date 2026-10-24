// The workout runner's inputs, read once (#6291): the queue, what Next lands on,
// the run's tick log, the rest timer's state and whether this phone may move the
// wall (the scheduler's crew rule), turned into the pure
// `describeWorkoutRunner` readout. Every runner surface (the Record tab's
// "Your workout" card, the player's cards) reads through here, so they agree.
//
// Mount it only while a run exists: it subscribes to the queue and the rest
// timer store. Neither changes per second, so it never re-renders on the clock;
// countdown digits come from the `RestTimerClock` leaf.

import { useMemo } from 'react';
import type { WorkoutRun } from '@boardsesh/playlist-generator';
import { selectNextQueueItemWithSuggestions } from '@boardsesh/play-view';
import { isClimbOnReachableBoard, type ClimbQueueItem } from '@boardsesh/queue';
import { toBoardName } from '@boardsesh/board-config';
import { usePlaylistSuggestionSource, useQueueData } from '../providers/queue-provider';
import { useReachableBoardKeys } from '../providers/queue/use-reachable-board-keys';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { useWorkoutRunLog } from '../lib/workout-run-store';
import { describeWorkoutRunner, type WorkoutRunnerReadout } from '../lib/workout-runner-readout';
import { useRestTimerState } from './use-rest-timer';
import { useSessionTimerDriver } from './use-session-timer-driver';

export type WorkoutRunner = {
  /** Null once no staged climb is left in the queue. */
  readout: WorkoutRunnerReadout | null;
  /** The climb on the wall now. */
  currentItem: ClimbQueueItem | null;
  /** What Next (and the rest timer's advance) lands on, with the same board rules the scheduler uses. */
  nextItem: ClimbQueueItem | null;
  /** The queued item `readout.resumeUuid` names, to go back to the workout from an off-plan climb. */
  resumeItem: ClimbQueueItem | null;
};

export function useWorkoutRunner(sessionId: string, run: WorkoutRun): WorkoutRunner {
  const { queue, currentClimbQueueItem } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const { data: activeBoard } = useActiveBoard();
  const reachableBoardKeys = useReachableBoardKeys(activeBoard);
  const restState = useRestTimerState();
  const log = useWorkoutRunLog(sessionId);
  // In a crew only the phone holding the wall moves it, so a passenger's rest
  // never promises the next climb. The scheduler reads the same rule.
  const { canAdvanceQueue } = useSessionTimerDriver();

  const queueUuids = useMemo(() => queue.map((item) => item.uuid), [queue]);

  // The same selection the auto-advance scheduler and the player's Next make: the
  // active board's compatibility and the gym's other walls, and the list being
  // walked, if any.
  const nextItem = useMemo(() => {
    const boardName = activeBoard ? toBoardName(activeBoard.boardType) : undefined;
    const activeConfig = activeBoard && boardName ? { boardName, layoutId: activeBoard.layoutId } : undefined;
    const isReachable =
      reachableBoardKeys.size === 0
        ? undefined
        : (climb: { boardType?: string | null; layoutId?: number | null }) =>
            isClimbOnReachableBoard(climb, reachableBoardKeys);
    return selectNextQueueItemWithSuggestions(
      queue,
      currentClimbQueueItem,
      playlistSuggestionSource,
      activeConfig,
      isReachable,
    ).item;
  }, [queue, currentClimbQueueItem, playlistSuggestionSource, activeBoard, reachableBoardKeys]);

  const currentUuid = currentClimbQueueItem?.uuid ?? null;
  const nextUuid = nextItem?.uuid ?? null;
  const readout = useMemo(
    () => describeWorkoutRunner({ run, queueUuids, currentUuid, nextUuid, log, rest: restState, canAdvanceQueue }),
    [run, queueUuids, currentUuid, nextUuid, log, restState, canAdvanceQueue],
  );

  const resumeUuid = readout?.resumeUuid ?? null;
  const resumeItem = useMemo(
    () => (resumeUuid === null ? null : (queue.find((item) => item.uuid === resumeUuid) ?? null)),
    [queue, resumeUuid],
  );

  return { readout, currentItem: currentClimbQueueItem, nextItem, resumeItem };
}
