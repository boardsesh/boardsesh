// One-tap Fell / Sent in a timed workout block (#6231, #5380).
//
// In a 4x4, a limit block or on the minute the climber logs every go, so the
// player's small row becomes two buttons: Fell logs one try at once, Sent logs
// a flash or a send. Both go through the same save path as the Log ascent
// sheet (`useTickSaver`), so the rest timer and the workout's tick log see the
// tick with its status and queue item exactly as they would from the sheet.
//
// A fall is logged the moment it is tapped, never held back for a "tries" count
// at the end: nothing is lost when the climber ends the workout early, the app
// is killed, or the phone goes offline mid-block.
import { useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { deriveAscentType, type TickStatus } from '@boardsesh/play-view';
import { useToast } from '../../providers/toast-provider';
import { getWorkoutRunLog } from '../../lib/workout-run-store';
import { isFirstAscentTick, useHasPriorTickHistory, useTickSaver } from './use-tick-saver';
import type { WorkoutOutcomeTarget } from './workout-outcome';

/**
 * A second tap within this long of the last one, on either button, is dropped:
 * a fumbled double tap must not log two goes, or a fall and a send.
 */
export const ONE_TAP_GUARD_MS = 700;

export type WorkoutOneTap = {
  onFell: () => void;
  onSent: () => void;
};

/**
 * Fell and Sent for one climb. `openLogSheet` is the player's own Log ascent
 * opener: a spray climb nobody has sent needs a grade, which only the sheet
 * asks for, so its Sent opens the sheet instead of logging.
 */
export function useWorkoutOneTap(target: WorkoutOutcomeTarget, openLogSheet: () => void): WorkoutOneTap {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const { climb, queueItemUuid, sessionId, boardName, layoutId, sizeId, setIds, angle, isMirror } = target;
  const { save, tickBoardName } = useTickSaver({
    climb,
    climbUuid: climb.uuid,
    boardName,
    layoutId,
    sizeId,
    setIds,
    sessionId,
    surface: 'mobile_workout_runner',
  });
  const hasPriorHistory = useHasPriorTickHistory(climb.uuid, tickBoardName, angle);
  // Wall-clock, not `nowMs()`: screenshot mode freezes that, and a frozen clock
  // would drop every tap after the first.
  const lastTapAtRef = useRef<number | null>(null);

  const claimTap = useCallback((): boolean => {
    const tappedAtMs = Date.now();
    const lastTapAtMs = lastTapAtRef.current;
    if (lastTapAtMs !== null && tappedAtMs - lastTapAtMs < ONE_TAP_GUARD_MS) return false;
    lastTapAtRef.current = tappedAtMs;
    return true;
  }, []);

  const logGo = useCallback(
    (status: TickStatus) => {
      const baseAscensionistCount = climb.ascensionist_count ?? 0;
      save(
        {
          status,
          attemptCount: 1,
          angle,
          isMirror,
          isBenchmark: climb.benchmark_difficulty != null,
          quality: null,
          difficulty: null,
          comment: '',
          climbedAtIso: new Date().toISOString(),
          baseAscensionistCount,
          gradeName: null,
        },
        {
          onSaved: () => {
            const message =
              status === 'attempt'
                ? t('playView.workoutOutcome.attemptLogged')
                : status === 'flash'
                  ? t('playView.workoutOutcome.flashLogged')
                  : t('playView.workoutOutcome.sendLogged');
            showToast(message, 'success');
          },
          onFailed: (message) => showToast(message, 'error'),
        },
      );
    },
    [save, climb, angle, isMirror, showToast, t],
  );

  const onFell = useCallback(() => {
    if (!claimTap()) return;
    logGo('attempt');
  }, [claimTap, logGo]);

  const onSent = useCallback(() => {
    if (!claimTap()) return;
    if (isFirstAscentTick(boardName, climb.ascensionist_count ?? 0)) {
      openLogSheet();
      return;
    }
    // A fall on this very queue item earlier in the block means this go is not
    // a flash, even before the logbook has caught up with it.
    const triedHere = getWorkoutRunLog(sessionId).some((entry) => entry.queueItemUuid === queueItemUuid);
    logGo(deriveAscentType(hasPriorHistory || triedHere, 1));
  }, [claimTap, boardName, climb, openLogSheet, sessionId, queueItemUuid, hasPriorHistory, logGo]);

  return { onFell, onSent };
}
