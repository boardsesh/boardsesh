import { useCallback, useMemo } from 'react';
import { locateInRun, type WorkoutRun } from '@boardsesh/playlist-generator';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { useTranslation } from 'react-i18next';
import { useQueueActions, useQueueData, useQueueSessionId } from '../providers/queue-provider';
import { useDrawerHost } from '../providers/drawer-host-provider';
import { useToast } from '../providers/toast-provider';
import {
  countWorkoutRunTicks,
  getWorkoutRunForSession,
  getWorkoutRunLog,
  isWorkoutRunPendingStart,
  markWorkoutRunStarted,
  useWorkoutRun,
  useWorkoutRunPendingStart,
} from '../lib/workout-run-store';
import { armRestTimerForWorkout, syncRestTimerStagePacing } from '../lib/rest-timer-effective';
import { resolveStageRestPacing } from '../lib/rest-timer-pacing';
import { clearRestTimerQueueEnded, getRestTimerState, resumeRestTimer } from '../lib/rest-timer-store';
import { nowMs } from '../lib/clock';
import { reportError } from '../lib/error-reporting';

// Shared across root/player pill hosts and the Workout card. A navigation
// callback may synchronously re-enter another host before preparation is consumed.
let launchingSessionId: string | null = null;

function firstQueuedWorkoutItem(run: WorkoutRun, queue: readonly ClimbQueueItem[]): ClimbQueueItem | null {
  const stagedUuids = new Set(run.stages.flatMap((stage) => stage.itemUuids));
  return queue.find((item) => stagedUuids.has(item.uuid)) ?? null;
}

/** One explicit launch action for the floating pill and Workout's card. */
export function useStartWorkout(): {
  pending: boolean;
  firstItem: ClimbQueueItem | null;
  startWorkout: () => void;
} {
  const { sessionId } = useQueueSessionId();
  const { queue } = useQueueData();
  const { getQueueSnapshot, setCurrentClimb } = useQueueActions();
  const { openPlayDrawer } = useDrawerHost();
  const { showToast } = useToast();
  const { t } = useTranslation('session');
  const run = useWorkoutRun(sessionId);
  const pending = useWorkoutRunPendingStart(sessionId);
  const firstItem = useMemo(() => (run ? firstQueuedWorkoutItem(run, queue) : null), [run, queue]);

  const startWorkout = useCallback(() => {
    if (sessionId === null || launchingSessionId !== null || !isWorkoutRunPendingStart(sessionId)) return;
    const currentRun = getWorkoutRunForSession(sessionId);
    if (currentRun === null) return;
    const snapshot = getQueueSnapshot();
    if (snapshot.sessionId !== sessionId) return;
    const item = firstQueuedWorkoutItem(currentRun, snapshot.queue);
    if (item === null) return;

    launchingSessionId = sessionId;
    try {
      // Commit the existing queue item first. A bare player open may create a
      // new uuid or only browse on a crew phone, losing the workout's identity.
      setCurrentClimb(item, { playlistSuggestionSource: null });
      openPlayDrawer(item.climb, { committedExternally: true });

      // Nothing touches the clock before navigation succeeds. A failed open
      // leaves the prepared card/pill available even if the wall already moved.
      const startedAtMs = nowMs();
      const queueUuids = snapshot.queue.map((queueItem) => queueItem.uuid);
      const stagePacing = resolveStageRestPacing({
        sessionId,
        run: currentRun,
        position: locateInRun(currentRun, item.uuid, queueUuids),
        queueItemUuid: item.uuid,
        repsLogged: countWorkoutRunTicks(getWorkoutRunLog(sessionId), item.uuid),
      });
      armRestTimerForWorkout(sessionId, currentRun, startedAtMs);
      if (stagePacing !== null) {
        // Resume rebases the old anchor, so it must precede the fresh launch
        // boundary. After-tick workouts still wait for their own first tick.
        if (!getRestTimerState().isRunning) resumeRestTimer(startedAtMs);
        syncRestTimerStagePacing(
          stagePacing,
          startedAtMs,
          stagePacing.mode === 'onTheMinute' ? 'anchorNow' : 'waitForTick',
        );
        // A previous queue's terminal beat does not finish this new workout.
        // Keep the fresh interval above, or wait for the new climb's own tick.
        clearRestTimerQueueEnded(startedAtMs, stagePacing.mode, stagePacing.mode === 'onTheMinute' ? 'keep' : 'clear');
      }
      markWorkoutRunStarted(sessionId);
    } catch (error) {
      reportError(error, { tags: { source: 'startWorkout' } });
      showToast(t('mobile.workoutRunner.startError'), 'error');
    } finally {
      launchingSessionId = null;
    }
  }, [sessionId, getQueueSnapshot, setCurrentClimb, openPlayDrawer, showToast, t]);

  return { pending, firstItem, startWorkout };
}
