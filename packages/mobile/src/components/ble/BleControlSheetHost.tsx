import { useCallback, useEffect } from 'react';
import { useOptionalBluetoothContext } from '../../providers/bluetooth-provider';
import { disconnectAllBluetooth } from '../../lib/ble/bluetooth-status-store';
import { BleControlSheet } from './BleControlSheet';

type BleControlSheetHostProps = {
  visible: boolean;
  onClose: () => void;
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
export function BleControlSheetHost({ visible, onClose }: BleControlSheetHostProps) {
  const bluetooth = useOptionalBluetoothContext();
  const isConnected = bluetooth?.isConnected ?? false;

  // Close if the link drops while the sheet is open — otherwise it lingers
  // showing Re-light / Disconnect actions that no-op on a dead link.
  useEffect(() => {
    if (!isConnected && visible) onClose();
  }, [isConnected, visible, onClose]);

  const handleReassert = useCallback(() => {
    bluetooth?.armUndoWallChangeToast();
    bluetooth?.reassertWall();
  }, [bluetooth]);

  const handleClearLights = useCallback(() => {
    void bluetooth?.clearBoard();
  }, [bluetooth]);

  if (!bluetooth) return null;

  return (
    <BleControlSheet
      visible={visible}
      onReassert={handleReassert}
      onClearLights={handleClearLights}
      onDisconnect={disconnectAllBluetooth}
      onClose={onClose}
    />
  );
}
