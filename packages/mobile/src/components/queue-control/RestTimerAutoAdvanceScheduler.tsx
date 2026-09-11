// Fires the rest timer's auto-advance (#5378). Renders nothing and sets no state
// per tick: it owns ONE `setTimeout` for the exact remaining milliseconds, so a
// running timer costs the app tree nothing between beats.
//
// Everything here is a guard. The failure mode this component can produce is
// "the wall changed under a climber", so each rule below is paired with a test
// that asserts it does NOT fire.

import { useCallback, useEffect, useRef } from 'react';
import { AppState } from 'react-native';
import { useTranslation } from 'react-i18next';
import { computeNavigationStateWithSuggestions } from '@boardsesh/play-view';
import { toBoardName } from '@boardsesh/board-config';
import {
  useQueueActions,
  useQueueData,
  useIsSharedSession,
  usePlaylistSuggestionSource,
} from '../../providers/queue-provider';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useBoardConnectionState } from '../ble/use-board-connection-state';
import { useToast } from '../../providers/toast-provider';
import { useKeepAwakeWhile } from '../../hooks/use-keep-awake-while';
import { useSetting } from '../../settings';
import { useRestTimerState } from '../../hooks/use-rest-timer';
import { nowMs } from '../../lib/clock';
import { hapticLight, hapticMedium, hapticSuccess } from '../../lib/haptics';
import {
  noteRestTimerAutoAdvanceFired,
  noteRestTimerQueueEnded,
  reanchorRestTimerAfterBackground,
} from '../../lib/rest-timer-store';
import {
  AUTO_ADVANCE_WARNING_LEAD_MS,
  getAutoAdvanceDeadlineMs,
  shouldScheduleAutoAdvance,
} from '../../lib/rest-timer-auto-advance';

const KEEP_AWAKE_TAG = 'rest-timer';

export function RestTimerAutoAdvanceScheduler() {
  const { t } = useTranslation('session');
  const timerState = useRestTimerState();
  const [targetSeconds] = useSetting('restTimerTargetSeconds');
  const [autoAdvance] = useSetting('restTimerAutoAdvance');
  const [mode] = useSetting('restTimerMode');

  const { nextClimb } = useQueueActions();
  const { queue, currentClimbQueueItem } = useQueueData();
  const playlistSuggestionSource = usePlaylistSuggestionSource();
  const isSharedSession = useIsSharedSession();
  const { inAppBoardConnection } = useBoardConnectionState();
  const { data: activeBoard } = useActiveBoard();
  const { showToast } = useToast();

  // In a crew, only the climber driving the wall may move the shared queue —
  // `nextClimb` broadcasts, so a passenger's timer would change everyone's climb.
  // Solo there is nothing to stomp on, so no board link is required.
  const canDriveWall = !isSharedSession || inAppBoardConnection === 'connectedByMe';

  // Read through refs so the scheduling effect depends only on the timer's own
  // inputs. Re-running it on every queue edit would cancel and reschedule the
  // pending advance constantly, and a queue edit is not a reason to restart a rest.
  // The dead-end message is resolved HERE, with the `t` react-i18next bound, and
  // carried as a finished string. Calling `inputs.t('...')` inside the callback
  // instead would read as a property access to `check:i18n:orphans`, which can
  // only bind a plain `t(...)` identifier call — and the key would be reported
  // as orphaned even though it is used.
  const queueEndedMessage = t('mobile.restTimer.queueEndedToast');
  const advanceInputsRef = useRef({
    queue,
    currentClimbQueueItem,
    playlistSuggestionSource,
    activeBoard,
    showToast,
    queueEndedMessage,
  });
  advanceInputsRef.current = {
    queue,
    currentClimbQueueItem,
    playlistSuggestionSource,
    activeBoard,
    showToast,
    queueEndedMessage,
  };

  const fireAdvance = useCallback(
    (expectedCycleId: number) => {
      const inputs = advanceInputsRef.current;
      const activeConfig = inputs.activeBoard
        ? (() => {
            const boardName = toBoardName(inputs.activeBoard.boardType);
            return boardName ? { boardName, layoutId: inputs.activeBoard.layoutId } : undefined;
          })()
        : undefined;

      // `nextClimb` is a SILENT no-op at a dead end, so never call it blind —
      // the beat would keep running with the wall never changing and nothing
      // said. Ask the same selector the play drawer uses for its Next affordance.
      const { canNext } = computeNavigationStateWithSuggestions(
        inputs.queue,
        inputs.currentClimbQueueItem,
        inputs.playlistSuggestionSource,
        activeConfig,
      );

      if (!canNext) {
        noteRestTimerQueueEnded();
        inputs.showToast(inputs.queueEndedMessage, 'info');
        return;
      }

      // Claim the cycle BEFORE advancing: a stale timeout from a re-run effect
      // or a remount loses the race here rather than skipping a second climb.
      if (!noteRestTimerAutoAdvanceFired(expectedCycleId, mode, nowMs())) return;

      hapticMedium();
      nextClimb();
    },
    [mode, nextClimb],
  );

  const scheduled = shouldScheduleAutoAdvance({ state: timerState, targetSeconds, autoAdvance, canDriveWall });
  const deadlineMs = scheduled
    ? getAutoAdvanceDeadlineMs({ mode, anchorMs: timerState.anchorMs, targetSeconds, nowMs: nowMs() })
    : null;

  // Keep the screen up while an advance is pending: timers are suspended in the
  // background and BLE writes need the app active, so a sleeping phone is a
  // timer that silently stops.
  useKeepAwakeWhile(scheduled, KEEP_AWAKE_TAG);

  const { cycleId } = timerState;
  useEffect(() => {
    if (deadlineMs === null) return undefined;

    const remainingMs = deadlineMs - nowMs();
    // Already past: a back-dated tick, or the app was asleep. Don't fire — the
    // AppState effect below re-anchors instead of advancing for a beat nobody saw.
    if (remainingMs <= 0) return undefined;

    const warnTimeout =
      remainingMs > AUTO_ADVANCE_WARNING_LEAD_MS
        ? setTimeout(() => hapticLight(), remainingMs - AUTO_ADVANCE_WARNING_LEAD_MS)
        : null;
    const fireTimeout = setTimeout(() => fireAdvance(cycleId), remainingMs);

    return () => {
      if (warnTimeout !== null) clearTimeout(warnTimeout);
      clearTimeout(fireTimeout);
    };
  }, [cycleId, deadlineMs, fireAdvance]);

  // Target reached with auto-advance off: one haptic and the digits go red (the
  // colour lives in the pill). Fires once per cycle, never while an advance is
  // pending, so the two never double up.
  const reachedCycleRef = useRef<number | null>(null);
  const { anchorMs, armed, isRunning } = timerState;
  useEffect(() => {
    if (!armed || !isRunning || scheduled) return undefined;
    if (anchorMs === null || targetSeconds === null || targetSeconds <= 0) return undefined;
    if (reachedCycleRef.current === cycleId) return undefined;

    const remainingMs = anchorMs + targetSeconds * 1000 - nowMs();
    if (remainingMs <= 0) {
      reachedCycleRef.current = cycleId;
      return undefined;
    }

    const timeout = setTimeout(() => {
      reachedCycleRef.current = cycleId;
      hapticSuccess();
    }, remainingMs);
    return () => clearTimeout(timeout);
  }, [anchorMs, armed, cycleId, isRunning, scheduled, targetSeconds]);

  // Coming back from the background, a deadline that passed while away was never
  // actionable. Re-anchor and start a fresh cycle rather than moving the wall for
  // an interval the climber never watched.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextAppState) => {
      if (nextAppState !== 'active') return;
      reanchorRestTimerAfterBackground(nowMs(), deadlineMs);
    });
    return () => subscription.remove();
  }, [deadlineMs]);

  return null;
}
