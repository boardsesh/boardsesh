import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import { useQueueSessionId } from '../../providers/queue-provider';
import { formatWorkoutStageParts } from '../../lib/workout-run-readout';
import { workoutClimbGo } from '../../lib/workout-runner-readout';
import { useWorkoutRunLog } from '../../lib/workout-run-store';
import type { TrackLabelParts } from './track-label-text';

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
 * Where a queue item sits in the workout, for the player's top bar: "Warm-up"
 * and "2 of 5", in the same two pieces as a list's name and count. A limit
 * climb also says which try the climber is on, from the ticks logged on it on
 * this phone: "Limit Bouldering" and "2 of 3 · Try 3"; a 4x4 climb says its rep
 * and set: "4x4" and "Rep 3 of 4 · Set 2 of 4". Null for a climb outside the
 * workout.
 */
export function useWorkoutStageParts(
  run: WorkoutRun | null,
  queueUuids: readonly string[],
  queueItemUuid: string | null | undefined,
): TrackLabelParts | null {
  const { t } = useTranslation('session');
  const { sessionId } = useQueueSessionId();
  // Without a run the log is never read: a session with no workout pays nothing.
  const log = useWorkoutRunLog(run ? sessionId : null);
  return useMemo(() => {
    if (!run || !queueItemUuid) return null;
    const position = locateInRun(run, queueItemUuid, queueUuids);
    if (!position) return null;
    const go = workoutClimbGo(run, position.stageId, queueItemUuid, log);
    const { stage, count, accessibilityLabel } = formatWorkoutStageParts(position, go, t);
    return { name: stage, count, accessibilityLabel };
  }, [run, queueUuids, queueItemUuid, log, t]);
}
