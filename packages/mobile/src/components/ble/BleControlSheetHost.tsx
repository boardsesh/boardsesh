import { useCallback, useContext, useEffect } from 'react';
import { isMoonboardBoardName } from '@boardsesh/board-config';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { QueueActiveClimbContext } from '../../providers/queue/queue-contexts';
import { markWallCleared, resetWallCleared } from './wall-cleared-store';
import { disconnectAllBluetooth } from '../../lib/ble/bluetooth-status-store';
import { BleControlSheet } from './BleControlSheet';
import { useSetting } from '../../settings';
import { useAutoDisconnectTimeoutLabels } from './use-auto-disconnect-timeout-labels';

type BleControlSheetHostProps = {
  visible: boolean;
  onClose: () => void;
  /**
   * Auto-disconnect and the two lighting switches. Only the player's own sheet
   * drops them (#7000); the app-wide sheet (toolbar
   * bulb, Climbs header pill) always keeps them.
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
};

/**
 * Renders the BLE controls sheet (Re-light / Turn off all lights / Disconnect)
 * with its standard handlers, leaving visible/onClose to the caller. Hosted in
 * TWO places so the menu presents from the right view controller:
 *   - app root (BleControlSheetProvider) for the persistent accessory bar, and
 *   - inside the play route (PlayDrawer) so the lightbulb's sheet presents ABOVE
 *     the route instead of behind it (an @expo/ui sheet presents off the VC that
 *     owns its subtree; a root-only instance lands under the modal player).
 */
export function BleControlSheetHost({
  visible,
  onClose,
  showLightingSwitches = true,
  clearedClimbUuid,
  onDrive,
}: BleControlSheetHostProps) {
  const bluetooth = useOptionalBluetoothContext();
  const isConnected = bluetooth?.isConnected ?? false;
  const [autoDisconnectEnabled, setAutoDisconnectEnabled] = useSetting('autoDisconnectBle');
  const showLightAdjacentHolds = isMoonboardBoardName(bluetooth?.boardName);
  const [lightOnSwipe, setLightOnSwipe] = useSetting('lightOnSwipe');
  const [lightOnClimbTap, setLightOnClimbTap] = useSetting('lightOnClimbTap');
  const timeoutSeconds = bluetooth?.autoDisconnectTimeoutSeconds ?? 30;
  const timeoutLabels = useAutoDisconnectTimeoutLabels();
  const autoDisconnectTimeoutLabel = timeoutLabels[timeoutSeconds] ?? String(timeoutSeconds);

  // Close if the link drops while the sheet is open — otherwise it lingers
  // showing Re-light / Disconnect actions that no-op on a dead link. A sheet
  // offering Light every climb stays: that row connects first.
  useEffect(() => {
    if (!isConnected && visible && !onDrive) onClose();
  }, [isConnected, visible, onClose, onDrive]);

  // Read without the throwing hook: the root host can mount outside a queue.
  const activeClimbUuid = useContext(QueueActiveClimbContext)?.activeClimbUuid ?? null;

  const handleReassert = useCallback(() => {
    resetWallCleared();
    bluetooth?.armUndoWallChangeToast();
    bluetooth?.reassertWall();
  }, [bluetooth]);

  // This phone's wall button reads the local store (#6939); every other viewer
  // hears it through board presence (#7015).
  const handleClearLights = useCallback(() => {
    markWallCleared(clearedClimbUuid === undefined ? activeClimbUuid : clearedClimbUuid);
    void bluetooth?.turnOffAllLights();
  }, [bluetooth, activeClimbUuid, clearedClimbUuid]);

  const handleToggleLightAdjacentHolds = useCallback(
    (enabled: boolean) => {
      bluetooth?.setMoonboardLightAdjacentHolds(enabled);
      bluetooth?.reassertWall();
    },
    [bluetooth],
  );

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
      showLightAdjacentHolds={showLightAdjacentHolds}
      lightAdjacentHoldsEnabled={bluetooth.moonboardLightAdjacentHolds}
      onToggleLightAdjacentHolds={handleToggleLightAdjacentHolds}
      lightOnSwipe={lightOnSwipe}
      onToggleLightOnSwipe={setLightOnSwipe}
      lightOnClimbTap={lightOnClimbTap}
      onToggleLightOnClimbTap={setLightOnClimbTap}
      showLightingSwitches={showLightingSwitches}
      linked={isConnected}
      onDrive={onDrive}
      onClose={onClose}
    />
  );
}
