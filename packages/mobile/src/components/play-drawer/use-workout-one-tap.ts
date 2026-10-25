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
// climb it left, and it logs there, against that queue item. When the wall
// moves to a climb without Fell / Sent, the player holds the row for that climb
// for the same couple of seconds (`use-workout-outcome-hold.ts`, `wallLeftAtMs`).
//
// The row says what each tap did (`WorkoutOneTapNotice`), not a toast: the
// player is a native modal on iOS, and the root toast overlay draws behind it.
// Only a save that lands after the row is gone falls back to the toast, since
// there is no row left to say it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { deriveAscentType, type TickStatus } from '@boardsesh/play-view';
import { logbookClimbAngleKey, useOptionalBoardLogbook } from '@boardsesh/board-react';
import { useToast } from '../../providers/toast-provider';
import { announceQueued } from '../../lib/announce-queued';
import { hapticSuccess } from '../../lib/haptics';
import { getWorkoutRunLog } from '../../lib/workout-run-store';
import { nowDate } from '../../lib/clock';
import { isFirstAscentTick, useHasPriorTickHistory, useTickSaver } from './use-tick-saver';
import { WALL_MOVED_GRACE_MS, type WorkoutOutcomeTarget } from './workout-outcome';

/**
 * A second tap within this long of the last one, on either button, is dropped:
 * a fumbled double tap must not log two goes, or a fall and a send.
 */
export const ONE_TAP_GUARD_MS = 700;

/** How long the tapped button says "Try logged" (or Flash / Send) before its label comes back. */
export const SAVED_NOTICE_MS = 2000;

/** How long a failure, or where to log a first ascent, holds the row unless tapped away. Long enough to read. */
export const MESSAGE_NOTICE_MS = 5000;

/**
 * What the row says about the last tap.
 *
 * A `saved` notice: the tapped button (Fell for a try, Sent for a flash or
 * send) shows the outcome in place of its label, and both buttons stay live.
 * Its `message` is the full sentence, naming the climb: the row shows it when
 * the go was logged on a climb that is no longer the one on screen, and a
 * screen reader hears it.
 *
 * A `message` notice: a failure, or where to log a first ascent. Both need
 * reading, so they take the whole row until tapped away or `MESSAGE_NOTICE_MS`
 * passes.
 */
export type WorkoutOneTapNotice =
  | { kind: 'saved'; status: TickStatus; queueItemUuid: string; message: string }
  | { kind: 'message'; tone: 'error' | 'info'; message: string };

export type WorkoutOneTap = {
  onFell: () => void;
  onSent: () => void;
  notice: WorkoutOneTapNotice | null;
  /** Clears the notice now, for a tap on the message. */
  dismissNotice: () => void;
};

/**
 * Fell and Sent for the climb on the wall. `openLogSheet` is the player's own
 * Log ascent opener: a spray climb nobody has sent needs a grade, which only the
 * sheet asks for, so its Sent opens the sheet instead of logging.
 *
 * `wallLeftAtMs` is set while the player holds the row for a climb the wall has
 * already left: `target` is that climb, a tap logs there only within
 * `WALL_MOVED_GRACE_MS` of the move, and never opens the sheet, which would open
 * on the climb now on screen.
 */
export function useWorkoutOneTap(
  target: WorkoutOutcomeTarget,
  openLogSheet: () => void,
  wallLeftAtMs: number | null = null,
): WorkoutOneTap {
  const { notice, report, dismissNotice } = useOneTapNotice();
  const wallLeft = useClimbTheWallLeft(target);
  // Bound to the climb the row was handed: the one on the wall, or, while the
  // row is held, the one the wall left.
  const forTarget = useOneTapLogger(target, wallLeftAtMs === null ? openLogSheet : null, report);
  // Bound to the climb the wall just left, or to the same climb as `forTarget`
  // while it hasn't moved. The sheet opens on the climb on screen, so this one
  // has no opener.
  const justLeft = useOneTapLogger(wallLeft?.target ?? target, null, report);
  // Wall-clock, not `nowMs()`: screenshot mode freezes that, and a frozen clock
  // would drop every tap after the first.
  const lastTapAtRef = useRef<number | null>(null);

  /** The logger this tap goes to, or null when the tap guard or a spent hold drops it. */
  const claimTap = useCallback((): OneTapLogger | null => {
    const tappedAtMs = Date.now();
    // Held for the climb the wall left, and the swap is late: the climber is on
    // the next climb by now, and it has no Fell / Sent.
    if (wallLeftAtMs !== null && tappedAtMs - wallLeftAtMs >= WALL_MOVED_GRACE_MS) return null;
    const lastTapAtMs = lastTapAtRef.current;
    if (lastTapAtMs !== null && tappedAtMs - lastTapAtMs < ONE_TAP_GUARD_MS) return null;
    lastTapAtRef.current = tappedAtMs;
    if (wallLeftAtMs !== null) return forTarget;
    return wallLeft !== null && tappedAtMs - wallLeft.leftAtMs < WALL_MOVED_GRACE_MS ? justLeft : forTarget;
  }, [wallLeftAtMs, wallLeft, justLeft, forTarget]);

  const onFell = useCallback(() => claimTap()?.logFell(), [claimTap]);
  const onSent = useCallback(() => claimTap()?.logSent(), [claimTap]);

  return { onFell, onSent, notice, dismissNotice };
}

type ReportNotice = (notice: WorkoutOneTapNotice) => void;

/**
 * The row's notice, and how a logger reports one. While the row is up the
 * notice goes to the row, with the success haptic (the toast used to own it;
 * a failure already buzzed in `useTickSaver`) and a spoken copy, since the
 * buttons keep their own labels for a screen reader. Once the row is gone (the
 * player closed, a swipe to a preview) a late save falls back to the toast.
 */
function useOneTapNotice(): { notice: WorkoutOneTapNotice | null; report: ReportNotice; dismissNotice: () => void } {
  const { showToast } = useToast();
  const [notice, setNotice] = useState<WorkoutOneTapNotice | null>(null);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const report = useCallback<ReportNotice>(
    (reportedNotice) => {
      if (!mountedRef.current) {
        showToast(reportedNotice.message, reportedNotice.kind === 'saved' ? 'success' : reportedNotice.tone);
        return;
      }
      if (reportedNotice.kind === 'saved') hapticSuccess();
      announceQueued(reportedNotice.message);
      setNotice(reportedNotice);
    },
    [showToast],
  );

  // Each new notice replaces the last and restarts the clock.
  useEffect(() => {
    if (notice === null) return undefined;
    const timeout = setTimeout(() => setNotice(null), notice.kind === 'saved' ? SAVED_NOTICE_MS : MESSAGE_NOTICE_MS);
    return () => clearTimeout(timeout);
  }, [notice]);

  const dismissNotice = useCallback(() => setNotice(null), []);

  return { notice, report, dismissNotice };
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
function useOneTapLogger(
  target: WorkoutOutcomeTarget,
  openLogSheet: (() => void) | null,
  report: ReportNotice,
): OneTapLogger {
  const { t } = useTranslation('session');
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
          // The app clock, so a screenshot capture dates the go at its frozen now,
          // the same instant the rest timer reads it against.
          climbedAtIso: nowDate().toISOString(),
          baseAscensionistCount,
          gradeName: null,
          // The climb this row was showing, even when the wall has since moved on.
          // It still counts only at the angle that queue item is up at.
          queueItem: { uuid: queueItemUuid, climb },
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
            report({ kind: 'saved', status, queueItemUuid, message });
          },
          onFailed: (message) => report({ kind: 'message', tone: 'error', message }),
        },
      );
    },
    [save, climb, angle, isMirror, queueItemUuid, report, t],
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
        else
          report({
            kind: 'message',
            tone: 'info',
            message: t('playView.workoutOutcome.wallMovedFirstAscent', { name: climb.name }),
          });
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
    report,
    t,
    hasPriorHistory,
    logGo,
  ]);

  return useMemo(() => ({ logFell, logSent }), [logFell, logSent]);
}
