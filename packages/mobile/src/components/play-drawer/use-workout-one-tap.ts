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
//
// The MiniPlayer's Fell / Sent (#6940) sit over the tab screens, where the
// root toast is in view, so they pass `messages: 'toast'`: a failure, or where
// to log a first ascent, is a toast there, and a saved go still marks the
// tapped button.
//
// The guard, the in-flight saves and the notice are shared by every surface
// (`workout-one-tap-store.ts`): UIKit mounts the MiniPlayer twice, and the
// player's row can be up beside it, so per-hook state would let two surfaces
// each take a tap within the guard.
import { useCallback, useEffect, useMemo, useRef } from 'react';
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
import {
  claimOneTapGuard,
  clearOneTapNotice,
  hasOneTapNoticeReader,
  isOneTapSavePending,
  markOneTapSavePending,
  setOneTapNotice,
  settleOneTapSave,
  useSharedOneTapNotice,
} from './workout-one-tap-store';

/**
 * A second tap within this long of the last one, on either button and on any
 * surface, is dropped: a fumbled double tap must not log two goes, or a fall
 * and a send.
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

export type WorkoutOneTapOptions = {
  /**
   * Where a failure, or where to log a first ascent, is said. `row` (the
   * player): the row takes it, as the root toast draws behind the player.
   * `toast` (the MiniPlayer): the root toast, which is in view over the tabs.
   */
  messages?: 'row' | 'toast';
};

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
  { messages = 'row' }: WorkoutOneTapOptions = {},
): WorkoutOneTap {
  const { notice, report, dismissNotice } = useOneTapNotice(messages, target.queueItemUuid);
  const wallLeft = useClimbTheWallLeft(target);
  // Bound to the climb the row was handed: the one on the wall, or, while the
  // row is held, the one the wall left.
  const forTarget = useOneTapLogger(target, wallLeftAtMs === null ? openLogSheet : null, report);
  // Bound to the climb the wall just left, or to the same climb as `forTarget`
  // while it hasn't moved. The sheet opens on the climb on screen, so this one
  // has no opener.
  const justLeft = useOneTapLogger(wallLeft?.target ?? target, null, report);

  /** The logger this tap goes to, or null when the tap guard or a spent hold drops it. */
  const claimTap = useCallback((): OneTapLogger | null => {
    // Wall-clock, not `nowMs()`: screenshot mode freezes that, and a frozen
    // clock would drop every tap after the first.
    const tappedAtMs = Date.now();
    // Held for the climb the wall left, and the swap is late: the climber is on
    // the next climb by now, and it has no Fell / Sent.
    if (wallLeftAtMs !== null && tappedAtMs - wallLeftAtMs >= WALL_MOVED_GRACE_MS) return null;
    if (!claimOneTapGuard(tappedAtMs, ONE_TAP_GUARD_MS)) return null;
    if (wallLeftAtMs !== null) return forTarget;
    return wallLeft !== null && tappedAtMs - wallLeft.leftAtMs < WALL_MOVED_GRACE_MS ? justLeft : forTarget;
  }, [wallLeftAtMs, wallLeft, justLeft, forTarget]);

  const onFell = useCallback(() => claimTap()?.logFell(), [claimTap]);
  const onSent = useCallback(() => claimTap()?.logSent(), [claimTap]);

  return { onFell, onSent, notice, dismissNotice };
}

type ReportNotice = (notice: WorkoutOneTapNotice) => void;

/**
 * The notice every surface shows, and how a logger reports one. While the
 * tapped surface is up and some surface can show the notice, it goes there,
 * with the success haptic (the toast used to own it; a failure already buzzed
 * in `useTickSaver`) and a spoken copy, since the buttons keep their own
 * labels for a screen reader. Otherwise (the player closed or swiped to a
 * preview before the save landed, or the MiniPlayer now shows another climb)
 * it falls back to the toast, whose line names the climb. With
 * `messages: 'toast'` a message is always a toast, and the surface marks only
 * a saved go on `queueItemUuid`, the climb its buttons log.
 */
function useOneTapNotice(
  messages: 'row' | 'toast',
  queueItemUuid: string,
): {
  notice: WorkoutOneTapNotice | null;
  report: ReportNotice;
  dismissNotice: () => void;
} {
  const { showToast } = useToast();
  const notice = useSharedOneTapNotice(messages, queueItemUuid);
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const report = useCallback<ReportNotice>(
    (reportedNotice) => {
      if (
        !mountedRef.current ||
        (messages === 'toast' && reportedNotice.kind === 'message') ||
        !hasOneTapNoticeReader(reportedNotice)
      ) {
        showToast(reportedNotice.message, reportedNotice.kind === 'saved' ? 'success' : reportedNotice.tone);
        return;
      }
      if (reportedNotice.kind === 'saved') hapticSuccess();
      announceQueued(reportedNotice.message);
      // Each new notice replaces the last and restarts the clock.
      setOneTapNotice(reportedNotice, reportedNotice.kind === 'saved' ? SAVED_NOTICE_MS : MESSAGE_NOTICE_MS);
    },
    [showToast, messages],
  );

  return { notice, report, dismissNotice: clearOneTapNotice };
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
      // A save for this queue item from another surface hasn't settled yet.
      if (isOneTapSavePending(queueItemUuid)) return;
      markOneTapSavePending(queueItemUuid);
      const baseAscensionistCount = climb.ascensionist_count ?? 0;
      const started = save(
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
            settleOneTapSave(queueItemUuid);
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
          onFailed: (message) => {
            settleOneTapSave(queueItemUuid);
            report({ kind: 'message', tone: 'error', message });
          },
        },
      );
      // This surface's own save was still in flight: nothing was sent.
      if (!started) settleOneTapSave(queueItemUuid);
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
