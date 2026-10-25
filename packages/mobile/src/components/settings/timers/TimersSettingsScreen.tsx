import { useCallback, useMemo, useRef, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MoreForm } from '../../MoreForm';
import { TimerPairingSheet } from '../../ble/TimerPairingSheet';
import { useSessionTimerDriver } from '../../../hooks/use-session-timer-driver';
import { useViewerUserId } from '../../../hooks/use-viewer-user-id';
import { fetchAllMyBoards, useUpdateBoard } from '../../../lib/graphql/hooks';
import { useActiveBoard, useSetActiveBoard } from '../../../lib/graphql/use-active-board';
import { hapticSelection } from '../../../lib/haptics';
import { isRestTimerSoundAvailable } from '../../../lib/rest-timer-cues';
import { changeRestTimerMode } from '../../../lib/rest-timer-mode-change';
import { trackSettingChanged, withSettingTracking } from '../../../lib/settings-analytics';
import { useAuth } from '../../../providers/auth-provider';
import { useQueueSessionId } from '../../../providers/queue-provider';
import { useOptionalRogueTimer } from '../../../providers/rogue-timer-context';
import { useToast } from '../../../providers/toast-provider';
import { useSetting } from '../../../settings';
import { buildTimersModel, rogueTimerBoards } from './timers-model';

/**
 * Settings › Timers. The rest timer's saved defaults and its cues, over the same
 * settings the in-session sheet writes, so the two always agree. A cadence change
 * goes through `changeRestTimerMode`, the one re-arm rule the sheet uses too.
 * Every change reports one `Setting Changed` under the `timers` page.
 *
 * The gym timer section pairs a Rogue timer to each of the climber's own boards.
 * The pairing is saved on the board (`timerName`), the field the board form
 * writes too, and the pairing sheet is hosted here as a sibling of the form.
 */
export function TimersSettingsScreen() {
  const { t } = useTranslation('common');
  const [targetSeconds, setTargetSeconds] = useSetting('restTimerTargetSeconds');
  const [mode] = useSetting('restTimerMode');
  const [autoAdvance, setAutoAdvance] = useSetting('restTimerAutoAdvance');
  const [sound, setSound] = useSetting('restTimerSound');
  const { blockedReason } = useSessionTimerDriver();
  const { sessionId } = useQueueSessionId();
  const { fontScale } = useWindowDimensions();
  // A build property, fixed for the life of the app.
  const soundAvailable = isRestTimerSoundAvailable();

  const onTargetChange = useCallback(
    (seconds: number | null) => {
      hapticSelection();
      setTargetSeconds(seconds);
    },
    [setTargetSeconds],
  );
  const onModeChange = useCallback(
    (nextMode: 'afterTick' | 'onTheMinute') => {
      if (changeRestTimerMode(nextMode, sessionId)) hapticSelection();
    },
    [sessionId],
  );
  const onToggle = useCallback((apply: (enabled: boolean) => void) => {
    return (enabled: boolean) => {
      hapticSelection();
      apply(enabled);
    };
  }, []);

  const rogue = useRogueTimerPairing();

  const model = useMemo(
    () =>
      withSettingTracking(
        buildTimersModel({
          t,
          rest: {
            targetSeconds,
            mode,
            autoAdvance,
            autoAdvanceBlockedByCrew: blockedReason !== null,
            onTargetChange,
            onModeChange,
            onAutoAdvanceChange: onToggle(setAutoAdvance),
          },
          cues: {
            // No reader on this branch yet: the countdown buzz lands with #5396,
            // which passes `{ enabled, onChange }` here.
            countdownCues: null,
            sound: soundAvailable ? { enabled: sound, onChange: onToggle(setSound) } : null,
          },
          rogue: rogue.section,
          fontScale,
        }),
        'timers',
      ),
    [
      t,
      targetSeconds,
      mode,
      autoAdvance,
      blockedReason,
      onTargetChange,
      onModeChange,
      onToggle,
      setAutoAdvance,
      soundAvailable,
      sound,
      setSound,
      rogue.section,
      fontScale,
    ],
  );

  return (
    <View style={styles.root}>
      <MoreForm model={model} />
      {rogue.pairingOpen ? <TimerPairingSheet onSelect={rogue.onTimerPicked} onDismiss={rogue.closePairing} /> : null}
    </View>
  );
}

/**
 * Every page of `myBoards`, under the `myBoards` root so `updateBoard`'s
 * invalidation refetches it. One page is not enough: it mixes owned and followed
 * boards in pin and recency order, so a home wall behind 20 followed gym boards
 * would never show.
 */
const ROGUE_TIMER_BOARDS_QUERY_KEY = ['myBoards', 'rogueTimerBoards'] as const;

/**
 * The gym timer section's data and its writes. Pairing saves the board's
 * `timerName` and, for the active board, re-saves the stored copy the Rogue
 * provider connects from: `updateBoard` refreshes the board lists but never the
 * active board (see app/boards/edit.tsx).
 */
function useRogueTimerPairing() {
  const { t } = useTranslation('common');
  const { isAuthenticated } = useAuth();
  const viewerUserId = useViewerUserId();
  const { data: boards } = useQuery({
    queryKey: ROGUE_TIMER_BOARDS_QUERY_KEY,
    queryFn: fetchAllMyBoards,
    enabled: isAuthenticated,
  });
  const { data: activeBoard } = useActiveBoard();
  const setActiveBoard = useSetActiveBoard();
  const { mutateAsync: updateBoard } = useUpdateBoard();
  const linkStatus = useOptionalRogueTimer()?.status ?? 'idle';
  const { showToast } = useToast();

  const [pairingBoardUuid, setPairingBoardUuid] = useState<string | null>(null);
  const [savingBoardUuid, setSavingBoardUuid] = useState<string | null>(null);

  // Read when a save lands: the active board may change while it is out.
  const activeBoardRef = useRef(activeBoard);
  activeBoardRef.current = activeBoard;

  const saveTimerName = useCallback(
    async (boardUuid: string, timerName: string | null) => {
      setSavingBoardUuid(boardUuid);
      try {
        const updated = await updateBoard({ boardUuid, timerName });
        // Counted, never named: the event carries no device name.
        trackSettingChanged('timers', 'rogueTimer', timerName ? 'paired' : 'removed');
        const currentActiveBoard = activeBoardRef.current;
        if (currentActiveBoard?.uuid === updated.uuid) {
          await setActiveBoard({ ...currentActiveBoard, timerName: updated.timerName ?? null });
        }
      } catch {
        showToast(t('mobile.settings.timers.rogueSaveFailed'), 'error');
      } finally {
        setSavingBoardUuid((saving) => (saving === boardUuid ? null : saving));
      }
    },
    [updateBoard, setActiveBoard, showToast, t],
  );

  const onPair = useCallback((boardUuid: string) => {
    hapticSelection();
    setPairingBoardUuid(boardUuid);
  }, []);
  const onRemove = useCallback(
    (boardUuid: string) => {
      hapticSelection();
      void saveTimerName(boardUuid, null);
    },
    [saveTimerName],
  );
  const closePairing = useCallback(() => setPairingBoardUuid(null), []);
  const onTimerPicked = useCallback(
    (pickedTimerName: string) => {
      const boardUuid = pairingBoardUuid;
      setPairingBoardUuid(null);
      const timerName = pickedTimerName.trim();
      if (boardUuid && timerName) void saveTimerName(boardUuid, timerName);
    },
    [pairingBoardUuid, saveTimerName],
  );

  const activeBoardUuid = activeBoard?.uuid ?? null;
  // Hidden signed out (a pairing is saved on the board), and until the boards
  // and the climber's id are known, so "no boards yet" never flashes up for
  // someone who has them.
  const section = useMemo(
    () =>
      isAuthenticated && boards && viewerUserId !== null
        ? {
            boards: rogueTimerBoards({ boards, viewerUserId, activeBoardUuid, savingBoardUuid, linkStatus }),
            onPair,
            onRemove,
          }
        : null,
    [isAuthenticated, boards, viewerUserId, activeBoardUuid, savingBoardUuid, linkStatus, onPair, onRemove],
  );

  return { section, pairingOpen: pairingBoardUuid !== null, onTimerPicked, closePairing };
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
