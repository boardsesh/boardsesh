import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import { formatWorkoutStagePosition } from '../../lib/workout-run-readout';

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

/** "Warm-up · 2 of 5" for a queue item in the workout, else null. */
export function useWorkoutStageLabel(
  run: WorkoutRun | null,
  queueUuids: readonly string[],
  queueItemUuid: string | null | undefined,
): string | null {
  const { t } = useTranslation('session');
  return useMemo(() => {
    if (!run || !queueItemUuid) return null;
    const position = locateInRun(run, queueItemUuid, queueUuids);
    return position ? formatWorkoutStagePosition(position, t) : null;
  }, [run, queueUuids, queueItemUuid, t]);
}
