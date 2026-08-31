import { useCallback, useEffect, useMemo, useState } from 'react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import {
  useOptionalQuantumBluetoothActions,
  useOptionalQuantumBluetoothState,
} from '../../providers/quantum-bluetooth-provider';
import { disconnectAllBluetooth } from '../../lib/ble/bluetooth-status-store';
import { BleControlSheet } from './BleControlSheet';
import { QuantumBleControlSheet, type QuantumLayerControlRow } from './QuantumBleControlSheet';
import { useSetting } from '../../settings';
import { useAutoDisconnectTimeoutLabels } from './use-auto-disconnect-timeout-labels';
import { useActiveBoard } from '../../lib/graphql/use-active-board';
import { useQueueData } from '../../providers/queue-provider';
import { getQuantumGeometryGeneration, useQuantumGeometry } from '../../lib/quantum-geometry-store';
import { buildQuantumClimbLightTarget, deriveQuantumLayerAction } from '../../lib/ble/quantum-climb-lights';
import type { Climb } from '@boardsesh/shared-schema';

type BleControlSheetHostProps = {
  visible: boolean;
  onClose: () => void;
  /** Exact editor snapshot when the sheet opens from create-climb. The queue
   * reducer may retain an older same-uuid WIP, so that path must not read it. */
  quantumClimbOverride?: Climb | null;
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
export function BleControlSheetHost({ visible, onClose, quantumClimbOverride }: BleControlSheetHostProps) {
  const bluetooth = useOptionalBluetoothContext();
  const quantumState = useOptionalQuantumBluetoothState();
  const quantumActions = useOptionalQuantumBluetoothActions();
  const quantumActive = quantumState?.status !== undefined && quantumState.status !== 'inactive';
  const isConnected = quantumActive ? quantumState.status === 'connected' : (bluetooth?.isConnected ?? false);
  const { data: activeBoard } = useActiveBoard();
  const { currentClimbQueueItem } = useQueueData();
  const quantumGeometry = useQuantumGeometry(
    activeBoard?.layoutId ?? 0,
    activeBoard?.sizeId ?? 0,
    quantumActive && activeBoard?.boardType === 'quantum',
  );
  const [busySlot, setBusySlot] = useState<number | null>(null);
  const [clearing, setClearing] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [autoDisconnectEnabled, setAutoDisconnectEnabled] = useSetting('autoDisconnectBle');
  const [lightOnSwipe, setLightOnSwipe] = useSetting('lightOnSwipe');
  const [lightOnClimbTap, setLightOnClimbTap] = useSetting('lightOnClimbTap');
  const timeoutSeconds = bluetooth?.autoDisconnectTimeoutSeconds ?? 30;
  const timeoutLabels = useAutoDisconnectTimeoutLabels();
  const autoDisconnectTimeoutLabel = timeoutLabels[timeoutSeconds] ?? String(timeoutSeconds);

  // Close if the link drops while the sheet is open — otherwise it lingers
  // showing Re-light / Disconnect actions that no-op on a dead link.
  useEffect(() => {
    if (!isConnected && visible) onClose();
  }, [isConnected, visible, onClose]);

  useEffect(() => {
    if (!visible) {
      setBusySlot(null);
      setClearing(false);
      setActionFailed(false);
    }
  }, [visible]);

  const quantumTargetResult = useMemo(() => {
    const climb = quantumClimbOverride ?? currentClimbQueueItem?.climb;
    if (!climb || !activeBoard || activeBoard.boardType !== 'quantum') return null;
    return buildQuantumClimbLightTarget(
      climb,
      quantumGeometry,
      activeBoard.layoutId,
      getQuantumGeometryGeneration(activeBoard.layoutId, activeBoard.sizeId),
    );
  }, [activeBoard, currentClimbQueueItem?.climb, quantumClimbOverride, quantumGeometry]);
  const quantumTarget = quantumTargetResult?.ok ? quantumTargetResult.target : null;
  const targetError = quantumTargetResult && !quantumTargetResult.ok ? quantumTargetResult.reason : null;
  const quantumRows = useMemo<QuantumLayerControlRow[]>(
    () =>
      (quantumState?.layers ?? []).map((layer) => ({
        slot: layer.slot,
        colorKey: layer.color.key,
        colorHex: layer.color.hex,
        action: deriveQuantumLayerAction(layer, quantumState?.roster?.players ?? [], quantumTarget),
      })),
    [quantumState?.layers, quantumState?.roster?.players, quantumTarget],
  );

  const handleQuantumLayerPress = useCallback(
    (row: QuantumLayerControlRow) => {
      if (!quantumActions || busySlot !== null || clearing) return;
      setBusySlot(row.slot);
      setActionFailed(false);
      const operation =
        row.action.kind === 'remove'
          ? quantumActions.removeLayer({ slot: row.slot, controllerRouteUuid: row.action.activeRouteUuid })
          : quantumTarget
            ? quantumActions.activateLayer({ slot: row.slot, ...quantumTarget })
            : Promise.reject(new Error('Quantum climb has no safe light target'));
      void operation.catch(() => setActionFailed(true)).finally(() => setBusySlot(null));
    },
    [busySlot, clearing, quantumActions, quantumTarget],
  );

  const handleQuantumClearAll = useCallback(() => {
    if (!quantumActions || busySlot !== null || clearing) return;
    setClearing(true);
    setActionFailed(false);
    void quantumActions
      .clearAll({ confirmed: true })
      .catch(() => setActionFailed(true))
      .finally(() => setClearing(false));
  }, [busySlot, clearing, quantumActions]);

  const handleQuantumDisconnect = useCallback(() => {
    void quantumActions?.disconnect();
  }, [quantumActions]);

  const handleReassert = useCallback(() => {
    bluetooth?.armUndoWallChangeToast();
    bluetooth?.reassertWall();
  }, [bluetooth]);

  const handleClearLights = useCallback(() => {
    void bluetooth?.clearBoard();
  }, [bluetooth]);

  if (quantumActive && quantumActions && quantumState) {
    return (
      <QuantumBleControlSheet
        visible={visible}
        rows={quantumRows}
        targetError={targetError}
        busySlot={busySlot}
        clearing={clearing}
        actionFailed={actionFailed}
        hasActivePlayers={(quantumState.roster?.players.length ?? 0) > 0}
        onLayerPress={handleQuantumLayerPress}
        onClearAll={handleQuantumClearAll}
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
      onDisconnect={disconnectAllBluetooth}
      autoDisconnectEnabled={autoDisconnectEnabled}
      autoDisconnectTimeoutLabel={autoDisconnectTimeoutLabel}
      onToggleAutoDisconnect={setAutoDisconnectEnabled}
      lightOnSwipe={lightOnSwipe}
      onToggleLightOnSwipe={setLightOnSwipe}
      lightOnClimbTap={lightOnClimbTap}
      onToggleLightOnClimbTap={setLightOnClimbTap}
      onClose={onClose}
    />
  );
}
