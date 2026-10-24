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
//
// The wall can move on under a tap: an on-the-minute beat advances whether the
// climber logged or not. Nobody gets a go on the new climb within a couple of
// seconds of it lighting up, so a tap that soon after the wall moved is for the
// climb it left, and it logs there, against that queue item.
import { useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { deriveAscentType, type TickStatus } from '@boardsesh/play-view';
import { logbookClimbAngleKey, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { useToast } from '../../providers/toast-provider';
import { getWorkoutRunLog } from '../../lib/workout-run-store';
import { isFirstAscentTick, useHasPriorTickHistory, useTickSaver } from './use-tick-saver';
import type { WorkoutOutcomeTarget } from './workout-outcome';

/**
 * A second tap within this long of the last one, on either button, is dropped:
 * a fumbled double tap must not log two goes, or a fall and a send.
 */
export const ONE_TAP_GUARD_MS = 700;

/**
 * A tap within this long of the wall moving on logs for the climb it left. Long
 * enough for a climber who topped out just before an on-the-minute beat to reach
 * the button, too short for a go on the climb that just lit up.
 */
export const WALL_MOVED_GRACE_MS = 2000;

export type WorkoutOneTap = {
  onFell: () => void;
  onSent: () => void;
};

/**
 * Fell and Sent for the climb on the wall. `openLogSheet` is the player's own
 * Log ascent opener: a spray climb nobody has sent needs a grade, which only the
 * sheet asks for, so its Sent opens the sheet instead of logging.
 */
export function useWorkoutOneTap(target: WorkoutOutcomeTarget, openLogSheet: () => void): WorkoutOneTap {
  const wallLeft = useClimbTheWallLeft(target);
  const onTheWall = useOneTapLogger(target, openLogSheet);
  // Bound to the climb the wall just left, or to the same climb as `onTheWall`
  // while it hasn't moved. The sheet opens on the climb on screen, so this one
  // has no opener.
  const justLeft = useOneTapLogger(wallLeft?.target ?? target, null);
  // Wall-clock, not `nowMs()`: screenshot mode freezes that, and a frozen clock
  // would drop every tap after the first.
  const lastTapAtRef = useRef<number | null>(null);

  /** The logger this tap goes to, or null when the tap guard drops it. */
  const claimTap = useCallback((): OneTapLogger | null => {
    const tappedAtMs = Date.now();
    const lastTapAtMs = lastTapAtRef.current;
    if (lastTapAtMs !== null && tappedAtMs - lastTapAtMs < ONE_TAP_GUARD_MS) return null;
    lastTapAtRef.current = tappedAtMs;
    return wallLeft !== null && tappedAtMs - wallLeft.leftAtMs < WALL_MOVED_GRACE_MS ? justLeft : onTheWall;
  }, [wallLeft, justLeft, onTheWall]);

  const onFell = useCallback(() => claimTap()?.logFell(), [claimTap]);
  const onSent = useCallback(() => claimTap()?.logSent(), [claimTap]);

  return { onFell, onSent };
}

/** The climb the wall moved on from, and when, as the row saw it. */
type WallLeft = { target: WorkoutOutcomeTarget; leftAtMs: number };

/**
 * The target the row showed before the climb on the wall last changed, stamped
 * with when the row saw it change. Null until it changes while the row is up.
 * A new target for the same queue item (a refreshed climb) is not a move.
 */
function useClimbTheWallLeft(target: WorkoutOutcomeTarget): WallLeft | null {
  const shownRef = useRef(target);
  const wallLeftRef = useRef<WallLeft | null>(null);
  if (shownRef.current.queueItemUuid !== target.queueItemUuid) {
    wallLeftRef.current = { target: shownRef.current, leftAtMs: Date.now() };
  }
  shownRef.current = target;
  return wallLeftRef.current;
}

type OneTapLogger = {
  logFell: () => void;
  logSent: () => void;
};

/**
 * What a tap logs on one climb. `openLogSheet` is null when the sheet would open
 * on another climb than this one (the climb the wall just left), and a first
 * ascent there says where to log it instead.
 */
function useOneTapLogger(target: WorkoutOutcomeTarget, openLogSheet: (() => void) | null): OneTapLogger {
  const { t } = useTranslation('session');
  const { showToast } = useToast();
  const { climb, queueItemUuid, sessionId, boardName, layoutId, sizeId, setIds, angle, isMirror } = target;
  // No `active`: the tap is the commit, so each save takes the wall as it is.
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
  const boardLogbook = useOptionalBoardLogbook();

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
          // The climb this row was showing, even when the wall has since moved on.
          queueItemUuid,
        },
        {
          onSaved: () => {
            // Named, because a tap just after the wall moved logs the climb it
            // left, which is no longer the one on screen.
            const message =
              status === 'attempt'
                ? t('playView.workoutOutcome.attemptLogged', { name: climb.name })
                : status === 'flash'
                  ? t('playView.workoutOutcome.flashLogged', { name: climb.name })
                  : t('playView.workoutOutcome.sendLogged', { name: climb.name });
            showToast(message, 'success');
          },
          onFailed: (message) => showToast(message, 'error'),
        },
      );
    },
    [save, climb, angle, isMirror, queueItemUuid, showToast, t],
  );

  const logFell = useCallback(() => logGo('attempt'), [logGo]);

  const logSent = useCallback(() => {
    const runLogHere = getWorkoutRunLog(sessionId).filter((entry) => entry.queueItemUuid === queueItemUuid);
    if (isFirstAscentTick(boardName, climb.ascensionist_count ?? 0)) {
      // The queue's copy of the climb never learns of a send, so it still reads
      // "nobody has sent it" after the climber's own first ascent. Their send in
      // this block, or in the logbook at this angle, says otherwise.
      const sentInThisBlock = runLogHere.some((entry) => entry.status !== 'attempt');
      const sentInLogbook = (boardLogbook?.logbookByClimbAngle.get(logbookClimbAngleKey(climb.uuid, angle)) ?? []).some(
        (entry) => entry.is_ascent,
      );
      if (!sentInThisBlock && !sentInLogbook) {
        if (openLogSheet) openLogSheet();
        else showToast(t('playView.workoutOutcome.wallMovedFirstAscent', { name: climb.name }), 'info');
        return;
      }
    }
    // A fall on this very queue item earlier in the block means this go is not
    // a flash, even before the logbook has caught up with it.
    logGo(deriveAscentType(hasPriorHistory || runLogHere.length > 0, 1));
  }, [
    sessionId,
    queueItemUuid,
    boardName,
    climb,
    angle,
    boardLogbook,
    openLogSheet,
    showToast,
    t,
    hasPriorHistory,
    logGo,
  ]);

  return useMemo(() => ({ logFell, logSent }), [logFell, logSent]);
}
