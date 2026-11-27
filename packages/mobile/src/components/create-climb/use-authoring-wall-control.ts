import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BoardName, Climb } from '@boardsesh/shared-schema';
import type { SavedClimbSnapshot } from '@boardsesh/create-climb-react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import {
  useOptionalQuantumBluetoothActions,
  useOptionalQuantumBluetoothState,
} from '../../providers/quantum-bluetooth-context';
import { useToast } from '../../providers/toast-provider';
import { trackBoardConnectTapped } from '../../lib/analytics-board-connect';
import { useBleFrameWriter } from '../../lib/ble/use-ble-frame-writer';
import { useLightbulbLabels } from '../ble/use-lightbulb-labels';
import type { PlayDrawerLightbulbPressAction } from '../play-drawer/lightbulb-control';

type AuthoringBoard = { boardName: BoardName; layoutId: number; sizeId: number };

type AuthoringWallControlOptions = {
  board: AuthoringBoard;
  savedClimb: SavedClimbSnapshot | null;
  savedTargetCurrent: boolean;
  saveInFlightRef: { readonly current: boolean };
  isSaving: boolean;
  isValid: boolean;
  prepareClimb: () => Climb | null;
  commitClimb: (climb: Climb) => void;
  editSizeMismatch: boolean;
  handedOff: boolean;
  holdsJson: string;
  currentFrameBleString: () => string;
  playback: { isPlaying: boolean; currentFrameString: string | null };
  draftKey: string;
};

/**
 * Owns authoring transport policy. The editor supplies snapshots and queue
 * hand-off; this adapter decides whether the wall previews frames or requires
 * a saved route followed by an explicit controller-slot choice.
 */
export function useAuthoringWallControl(options: AuthoringWallControlOptions) {
  const {
    board,
    savedClimb,
    savedTargetCurrent,
    saveInFlightRef,
    isSaving,
    isValid,
    prepareClimb,
    commitClimb,
    editSizeMismatch,
    handedOff,
    holdsJson,
    currentFrameBleString,
    playback,
    draftKey,
  } = options;
  const bluetooth = useOptionalBluetoothContext();
  const quantum = useOptionalQuantumBluetoothState();
  const quantumActions = useOptionalQuantumBluetoothActions();
  const { showToast } = useToast();
  const { t } = useTranslation('climbs');
  const { t: tCommon } = useTranslation('common');
  const explicitSlots = quantum?.status !== undefined && quantum.status !== 'inactive';
  const wallMatchesEditor =
    (board.boardName !== 'woods' && board.boardName !== 'spray') ||
    (bluetooth?.boardName === board.boardName &&
      bluetooth.layoutId === board.layoutId &&
      bluetooth.sizeId === board.sizeId);
  const connected = explicitSlots
    ? quantum.status === 'connected'
    : Boolean(bluetooth?.isConnected || (bluetooth?.boardName === 'spray' && bluetooth.canDriveWall)) &&
      wallMatchesEditor;
  const available = explicitSlots ? quantum.isAvailable !== false : bluetooth !== null;
  const pending = explicitSlots ? quantum.status === 'connecting' : (bluetooth?.loading ?? false);
  const [controlsVisible, setControlsVisible] = useState(false);
  const [controlClimbTarget, setControlClimbTarget] = useState<Climb | null>(null);

  const savedRouteReady = Boolean(savedClimb?.controllerRouteUuid && savedTargetCurrent);
  const ensureCanSetActive = useCallback(() => {
    if (board.boardName === 'quantum' && (!savedRouteReady || saveInFlightRef.current)) {
      showToast(tCommon('lightControl.quantum.saveFirst'), 'info');
      return false;
    }
    if (board.boardName === 'spray' && !savedClimb) {
      showToast(t('mobile.create.save.beforeLogging'), 'info');
      return false;
    }
    return true;
  }, [board.boardName, savedRouteReady, saveInFlightRef, savedClimb, showToast, tCommon, t]);

  const setActive = useCallback(() => {
    if (!ensureCanSetActive()) return;
    const climb = prepareClimb();
    if (climb) commitClimb(climb);
  }, [ensureCanSetActive, prepareClimb, commitClimb]);

  const pressAction: PlayDrawerLightbulbPressAction = explicitSlots
    ? connected
      ? 'openControls'
      : 'connect'
    : bluetooth?.isConnected
      ? 'disconnect'
      : board.boardName === 'spray'
        ? bluetooth?.virtualWallHeld
          ? 'releaseWall'
          : 'takeWall'
        : 'connect';
  const labels = useLightbulbLabels(pressAction);
  const onPress = useCallback(() => {
    if (!available || pending) return;
    if (explicitSlots) {
      if (!quantumActions) return;
      if (!connected) {
        void quantumActions.connect();
        return;
      }
      if (!ensureCanSetActive()) return;
      const climb = prepareClimb();
      if (!climb) return;
      commitClimb(climb);
      // The queue ignores same-UUID Set Active. Hold the exact saved editor
      // snapshot beside the sheet so an existing queue entry cannot retarget it.
      setControlClimbTarget(climb);
      setControlsVisible(true);
      return;
    }
    if (!bluetooth) return;
    if (!wallMatchesEditor || editSizeMismatch) {
      showToast(t('mobile.create.wallSizeMismatch'), 'info');
      return;
    }
    if (bluetooth.isConnected) {
      void bluetooth.disconnect();
      return;
    }
    if (board.boardName === 'spray') {
      if (bluetooth.virtualWallHeld) bluetooth.releaseVirtualWall();
      else bluetooth.takeVirtualWall();
      return;
    }
    trackBoardConnectTapped({ surface: 'create_climb', boardName: bluetooth.boardName, reconnect: false });
    void bluetooth.connect(currentFrameBleString());
  }, [
    available,
    pending,
    explicitSlots,
    quantumActions,
    connected,
    ensureCanSetActive,
    prepareClimb,
    commitClimb,
    bluetooth,
    wallMatchesEditor,
    editSizeMismatch,
    showToast,
    t,
    board.boardName,
    currentFrameBleString,
  ]);
  const closeControls = useCallback(() => {
    setControlsVisible(false);
    setControlClimbTarget(null);
  }, []);

  // Explicit-slot controllers never receive paint, playback or queue auto-writes.
  const previewsFrames = connected && !explicitSlots && !editSizeMismatch && !handedOff;
  const sendFramesRef = useRef(bluetooth?.sendFramesToBoard);
  sendFramesRef.current = bluetooth?.sendFramesToBoard;
  const invalidateWallState = bluetooth?.invalidateWallState;
  const invalidateWallStateRef = useRef(invalidateWallState);
  invalidateWallStateRef.current = invalidateWallState;
  useEffect(() => {
    if (!previewsFrames || playback.isPlaying) return;
    const handle = setTimeout(() => {
      invalidateWallStateRef.current?.();
      void sendFramesRef.current?.(currentFrameBleString());
    }, 250);
    return () => clearTimeout(handle);
  }, [holdsJson, previewsFrames, playback.isPlaying, currentFrameBleString]);
  useBleFrameWriter({
    frame: playback.isPlaying && previewsFrames ? playback.currentFrameString : null,
    send: bluetooth?.sendFramesToBoard,
    mirrored: false,
    resetKey: draftKey,
    // Authoring bypasses the queue auto-sender, invalidating its remembered wall.
    onWrite: invalidateWallState,
  });

  return useMemo(
    () => ({
      available,
      connected,
      pending,
      pressAction,
      ...labels,
      onPress,
      canSetActive: isValid && (board.boardName !== 'quantum' || (savedRouteReady && !isSaving)),
      setActive,
      controlsVisible,
      controlClimbTarget,
      closeControls,
    }),
    [
      available,
      connected,
      pending,
      pressAction,
      labels.accessibilityLabel,
      labels.drivingAccessibilityLabel,
      onPress,
      isValid,
      board.boardName,
      savedRouteReady,
      isSaving,
      setActive,
      controlsVisible,
      controlClimbTarget,
      closeControls,
    ],
  );
}

export type AuthoringWallControl = ReturnType<typeof useAuthoringWallControl>;
