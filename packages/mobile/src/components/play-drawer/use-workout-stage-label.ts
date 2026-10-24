import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import { useQueueSessionId } from '../../providers/queue-provider';
import { formatWorkoutStagePositionWithTry } from '../../lib/workout-run-readout';
import { workoutTryNumber } from '../../lib/workout-runner-readout';
import { useWorkoutRunLog } from '../../lib/workout-run-store';

const NO_QUEUE_UUIDS: readonly string[] = [];

/**
 * The queue's uuids, but only while a workout is running: without a run there is
 * nothing to locate, so a queue change costs nothing.
 */
export function useWorkoutQueueUuids(
  run: WorkoutRun | null,
  queue: ReadonlyArray<{ uuid: string }>,
): readonly string[] {
  return useMemo(() => (run ? queue.map((item) => item.uuid) : NO_QUEUE_UUIDS), [run, queue]);
}

/**
 * "Warm-up · 2 of 5" for a queue item in the workout, else null. A limit climb
 * also says which try the climber is on, from the ticks logged on it on this
 * phone: "Limit Bouldering · 2 of 3 · Try 3".
 */
export function useWorkoutStageLabel(
  run: WorkoutRun | null,
  queueUuids: readonly string[],
  queueItemUuid: string | null | undefined,
): string | null {
  const { t } = useTranslation('session');
  const { sessionId } = useQueueSessionId();
  // Without a run the log is never read: a session with no workout pays nothing.
  const log = useWorkoutRunLog(run ? sessionId : null);
  return useMemo(() => {
    if (!run || !queueItemUuid) return null;
    const position = locateInRun(run, queueItemUuid, queueUuids);
    if (!position) return null;
    return formatWorkoutStagePositionWithTry(position, workoutTryNumber(run, position.stageId, queueItemUuid, log), t);
  }, [run, queueUuids, queueItemUuid, log, t]);
}
