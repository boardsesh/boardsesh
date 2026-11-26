import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import { BOARD_LAYER_COLORS } from '@boardsesh/board-layers';
import { quantumUuidsEqual } from '@boardsesh/ble-protocol/quantum';
import { announceQueued } from '../../lib/announce-queued';
import { hapticSelection } from '../../lib/haptics';
import {
  DEFAULT_KEEP_LIGHTING,
  KEEP_LIGHTING_CHOICES,
  sanitiseKeepLighting,
  type KeepLightingChoice,
} from '../../lib/keep-lighting';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { QueueActiveClimbContext } from '../../providers/queue/queue-contexts';
import { markWallCleared, resetWallCleared } from './wall-cleared-store';
import { getDriveMode, stopDrivingForLink } from '../play-drawer/drive-mode-store';
import {
  useOptionalQuantumBluetoothActions,
  useOptionalQuantumBluetoothState,
} from '../../providers/quantum-bluetooth-context';
import { disconnectAllBluetooth } from '../../lib/ble/bluetooth-status-store';
import { BleControlSheet } from './BleControlSheet';
import {
  QuantumBleControlSheet,
  type QuantumLayerControlRow,
  type QuantumLayerRemovalRow,
} from './QuantumBleControlSheet';
import { useSetting } from '../../settings';
import { trackSettingChanged } from '../../lib/settings-analytics';
import { keepLightingLabel } from '../settings/board-lighting/board-lighting-model';
import type { BleKeepLightingRowModel } from './BleKeepLightingRow';

/**
 * `Setting Changed`'s page for the switches on this sheet. Not a Settings page,
 * so the Settings root's ranking leaves it out; the keys are the Board page's.
 */
export const BOARD_CONTROLS_SETTINGS_PAGE = 'boardControls';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useQueueData } from '../../providers/queue-provider';
import { getQuantumGeometryGeneration, useQuantumGeometry } from '../../lib/quantum-geometry-store';
import {
  buildQuantumClimbLightTarget,
  deriveQuantumLayerAction,
  quantumLayerColorNumber,
} from '../../lib/ble/quantum-climb-lights';
import type { Climb } from '@boardsesh/shared-schema';

type BleControlSheetHostProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Disconnect Bluetooth when driving ends and Always drive the wall. Only the
   * player's own sheet drops them (#7000); the app-wide sheet (toolbar bulb,
   * Climbs header pill) always keeps them. Both keep the Stop driving after
   * row, unless Always drive the wall is on.
   */
  showLightingSwitches?: boolean;
  /**
   * The climb "Turn off all lights" marks dark. The player passes the climb
   * physically on the wall, so a lit preview that isn't the queue head reads
   * dark after it (#7000). Omitted, the queue's active climb, as the app-wide
   * sheet always has.
   */
  clearedClimbUuid?: string | null;
  /**
   * Light every climb (#7113): start driving the wall, the swipe's visible
   * alternative. The player passes it where the swipe is offered; with it the
   * sheet also opens with no link, showing only that row.
   */
  onDrive?: () => void;
  /** The player's status line at the top of its sheet (spec B3); the app-wide sheet has none. */
  status?: ReactNode;
  /** Exact editor snapshot when the sheet opens from create-climb. The queue
   * reducer may retain an older same-uuid WIP, so that path must not read it. */
  controlClimbTarget?: Climb | null;
};

/**
 * Renders the BLE controls sheet (Re-light / Turn off all lights / Disconnect)
 * with its standard handlers, leaving visible/onClose to the caller. Hosted in
 * Three places so the menu presents from the right view controller:
 *   - app root (BleControlSheetProvider) for the persistent accessory bar, and
 *   - inside the play route (PlayDrawer) and create drawer so their lightbulb
 *     sheets present above the owning modal route. An @expo/ui sheet presents
 *     from the view controller that owns its subtree.
 */
export function BleControlSheetHost({
  controlClimbTarget,
  visible,
  onClose,
  showLightingSwitches = true,
  clearedClimbUuid,
  onDrive,
  status,
}: BleControlSheetHostProps) {
  const { t } = useTranslation('common');
  const bluetooth = useOptionalBluetoothContext();
  const quantumState = useOptionalQuantumBluetoothState();
  const quantumActions = useOptionalQuantumBluetoothActions();
  const quantumActive = quantumState?.status !== undefined && quantumState.status !== 'inactive';
  const isConnected = quantumActive
    ? quantumState.status === 'connected'
    : Boolean(bluetooth?.isConnected || (bluetooth?.boardName === 'spray' && bluetooth.canDriveWall));
  const { data: activeBoard } = useActiveBoard();
  const { currentClimbQueueItem } = useQueueData();
  const quantumGeometry = useQuantumGeometry(
    activeBoard?.layoutId ?? 0,
    activeBoard?.sizeId ?? 0,
    quantumActive && activeBoard?.boardType === 'quantum',
  );
  const [busyAction, setBusyAction] = useState<string | number | null>(null);
  const [actionFailed, setActionFailed] = useState(false);
  const wallIdentity = `${bluetooth?.boardName}:${bluetooth?.layoutId}:${bluetooth?.sizeId}`;
  const currentWall = useRef(wallIdentity);
  currentWall.current = wallIdentity;
  const [disconnectWhenDrivingEnds, setDisconnectWhenDrivingEnds] = useSetting('disconnectWhenDrivingEnds');
  const showLightAdjacentHolds = isMoonboardBoardName(bluetooth?.boardName);
  const [alwaysDrive, setAlwaysDrive] = useSetting('alwaysDrive');
  // Stop driving after (2.7, spec B4), the sheet's first row on both sheets:
  // the timer at the wall in two taps (WCAG 2.2.1), the same choice on every
  // board, MoonBoards included. Left out while Always drive the wall is on: it
  // drives with no end, so no timer applies.
  const [storedKeepLighting, setKeepLighting] = useSetting('putOnBoardKeepsLighting');
  const keepLightingChoice = sanitiseKeepLighting(storedKeepLighting, DEFAULT_KEEP_LIGHTING);
  const keepLighting = useMemo<BleKeepLightingRowModel>(
    () => ({
      label: t('settings:ble.lighting.keep.label'),
      choice: keepLightingChoice,
      options: KEEP_LIGHTING_CHOICES.map((choice) => ({ key: choice, label: keepLightingLabel(t, choice) })),
      onChange: (choice: KeepLightingChoice) => {
        hapticSelection();
        // Reported like the Board page's row of the same key.
        trackSettingChanged(BOARD_CONTROLS_SETTINGS_PAGE, 'putOnBoardKeepsLighting', choice);
        setKeepLighting(choice);
      },
    }),
    [t, keepLightingChoice, setKeepLighting],
  );

  // Close if the link drops while the sheet is open — otherwise it lingers
  // showing Re-light / Disconnect actions that no-op on a dead link. A sheet
  // offering Light every climb stays: that row connects first.
  useEffect(() => {
    if (!isConnected && visible && !onDrive) onClose();
  }, [isConnected, visible, onClose, onDrive]);

  // Read without the throwing hook: the root host can mount outside a queue.
  const activeClimbUuid = useContext(QueueActiveClimbContext)?.activeClimbUuid ?? null;

  useEffect(() => {
    if (!visible) {
      setBusyAction(null);
      setActionFailed(false);
    }
  }, [visible]);

  const quantumTargetResult = useMemo(() => {
    const climb = controlClimbTarget ?? currentClimbQueueItem?.climb;
    if (!quantumActive || !climb || !activeBoard || activeBoard.boardType !== 'quantum') return null;
    return buildQuantumClimbLightTarget(
      climb,
      quantumGeometry,
      activeBoard.layoutId,
      getQuantumGeometryGeneration(activeBoard.layoutId, activeBoard.sizeId),
    );
  }, [activeBoard, currentClimbQueueItem?.climb, controlClimbTarget, quantumActive, quantumGeometry]);
  const quantumTarget = quantumTargetResult?.ok ? quantumTargetResult.target : null;
  const targetError = quantumTargetResult && !quantumTargetResult.ok ? quantumTargetResult.reason : null;
  const quantumPlayer = quantumState?.player;
  const quantumPlayers = quantumState?.roster?.players;
  const quantumRows = useMemo<QuantumLayerControlRow[]>(() => {
    if (!quantumPlayer || !quantumPlayers) return [];
    return BOARD_LAYER_COLORS.map((color, slot) => ({
      slot,
      colorKey: color.key,
      colorHex: color.hex,
      action: deriveQuantumLayerAction(quantumPlayer.controllerUserUuid, color, quantumPlayers, quantumTarget),
    }));
  }, [quantumPlayer, quantumPlayers, quantumTarget]);
  const quantumRemovals = useMemo<QuantumLayerRemovalRow[]>(() => {
    if (!quantumPlayer || !quantumPlayers) return [];
    const ownedUserUuids = [quantumPlayer.controllerUserUuid, ...quantumPlayer.legacyCleanupUserUuids];
    return quantumPlayers.flatMap((player) => {
      if (!ownedUserUuids.some((userUuid) => quantumUuidsEqual(userUuid, player.userId))) return [];
      const color = BOARD_LAYER_COLORS.find((candidate) => quantumLayerColorNumber(candidate) === player.color);
      return [
        {
          controllerUserUuid: player.userId,
          controllerRouteUuid: player.routeId,
          colorKey: color?.key,
          colorHex: '#' + player.color.toString(16).padStart(6, '0'),
        },
      ];
    });
  }, [quantumPlayer, quantumPlayers]);

  const handleQuantumLayerPress = useCallback(
    (row: QuantumLayerControlRow) => {
      if (!quantumActions || busyAction !== null || !quantumTarget) return;
      if (row.action.kind !== 'light' && row.action.kind !== 'replace') return;
      setBusyAction(row.slot);
      setActionFailed(false);
      void quantumActions
        .activateLayer({
          slot: row.slot,
          ...quantumTarget,
          expectedOwnedRouteUuid: row.action.kind === 'replace' ? row.action.activeRouteUuid : undefined,
        })
        .catch(() => setActionFailed(true))
        .finally(() => setBusyAction(null));
    },
    [busyAction, quantumActions, quantumTarget],
  );

  const handleQuantumRemove = useCallback(
    (row: QuantumLayerRemovalRow) => {
      if (!quantumActions || busyAction !== null) return;
      setBusyAction(row.controllerUserUuid);
      setActionFailed(false);
      void quantumActions
        .removeLayer(row)
        .catch(() => setActionFailed(true))
        .finally(() => setBusyAction(null));
    },
    [busyAction, quantumActions],
  );

  const handleQuantumDisconnect = useCallback(() => {
    void quantumActions?.disconnect();
  }, [quantumActions]);

  const handleReassert = useCallback(() => {
    resetWallCleared();
    bluetooth?.armUndoWallChangeToast();
    bluetooth?.reassertWall();
  }, [bluetooth]);

  // This phone's wall button reads the local store (#6939); every other viewer
  // hears it through board presence (#7015). A dark wall is the climber
  // stopping: a drive ends here, timed or not, as a press on the wall button
  // would end it, so the next pick is a preview and the button's Put on board
  // means what it says. With Disconnect Bluetooth when driving ends on, the
  // board is let go once the lights are off, never before the write.
  const handleClearLights = useCallback(() => {
    const drive = getDriveMode();
    let lightsOff: () => void = () => {};
    const cleared = new Promise<void>((resolve) => {
      lightsOff = resolve;
    });
    if (drive) {
      stopDrivingForLink({ disconnectAfter: () => cleared });
      announceQueued(t('session:playView.wallControl.stoppedDriving'));
    }
    const targetClimbUuid = clearedClimbUuid === undefined ? activeClimbUuid : clearedClimbUuid;
    // A LAN write can fail or be cancelled, so a spray wall with no radio reads
    // dark only once its controller has acknowledged the blank frame.
    if (bluetooth?.boardName === 'spray' && !bluetooth.isConnected) {
      void bluetooth.turnOffAllLights().then((lightsAreOff) => {
        lightsOff();
        if (lightsAreOff && currentWall.current === wallIdentity) markWallCleared(targetClimbUuid);
      }, lightsOff);
      return;
    }
    markWallCleared(targetClimbUuid);
    const write = bluetooth?.turnOffAllLights();
    if (write) void write.then(lightsOff, lightsOff);
    else lightsOff();
  }, [bluetooth, activeClimbUuid, clearedClimbUuid, t, wallIdentity]);

  const handleToggleLightAdjacentHolds = useCallback(
    (enabled: boolean) => {
      trackSettingChanged(BOARD_CONTROLS_SETTINGS_PAGE, 'moonboardLightAdjacentHolds', enabled);
      bluetooth?.setMoonboardLightAdjacentHolds(enabled);
      bluetooth?.reassertWall();
    },
    [bluetooth],
  );
  const handleDisconnect = useCallback(() => {
    if (bluetooth?.boardName === 'spray' && !bluetooth.isConnected) bluetooth.releaseVirtualWall();
    else disconnectAllBluetooth();
  }, [bluetooth]);

  // The same `Setting Changed` the Board page's rows send, so a switch flipped
  // here (the lightbulb's long press) is counted too.
  const handleToggleDisconnectWhenDrivingEnds = useCallback(
    (enabled: boolean) => {
      trackSettingChanged(BOARD_CONTROLS_SETTINGS_PAGE, 'disconnectWhenDrivingEnds', enabled);
      setDisconnectWhenDrivingEnds(enabled);
    },
    [setDisconnectWhenDrivingEnds],
  );
  const handleToggleAlwaysDrive = useCallback(
    (enabled: boolean) => {
      trackSettingChanged(BOARD_CONTROLS_SETTINGS_PAGE, 'alwaysDrive', enabled);
      setAlwaysDrive(enabled);
    },
    [setAlwaysDrive],
  );
  if (quantumActive && quantumActions && quantumState) {
    return (
      <QuantumBleControlSheet
        visible={visible}
        rows={quantumRows}
        targetError={targetError}
        removals={quantumRemovals}
        busyAction={busyAction}
        actionFailed={actionFailed}
        onLayerPress={handleQuantumLayerPress}
        onRemove={handleQuantumRemove}
        onDisconnect={handleQuantumDisconnect}
        onClose={onClose}
      />
    );
  }

  if (!bluetooth) return null;

  return (
    <BleControlSheet
      visible={visible}
      onReassert={handleReassert}
      onClearLights={handleClearLights}
      onDisconnect={handleDisconnect}
      disconnectWhenDrivingEnds={disconnectWhenDrivingEnds}
      onToggleDisconnectWhenDrivingEnds={handleToggleDisconnectWhenDrivingEnds}
      showLightAdjacentHolds={showLightAdjacentHolds}
      lightAdjacentHoldsEnabled={bluetooth.moonboardLightAdjacentHolds}
      onToggleLightAdjacentHolds={handleToggleLightAdjacentHolds}
      alwaysDrive={alwaysDrive}
      onToggleAlwaysDrive={handleToggleAlwaysDrive}
      showLightingSwitches={showLightingSwitches}
      showDisconnectWhenDrivingEnds={bluetooth.isConnected}
      linked={isConnected}
      onDrive={onDrive}
      status={status}
      keepLighting={alwaysDrive ? undefined : keepLighting}
      onClose={onClose}
    />
  );
}
