// Hosts a single BLE controls sheet (Re-light / Turn off all lights /
// Disconnect) at app root so every surface opens the SAME labelled menu — the
// play-drawer lightbulb and the persistent accessory bar's board control — and
// the destructive Disconnect always stays behind a label. Wraps
// DrawerHostProvider (which renders PlayDrawer as a sibling of its children) so
// both the drawer and the bar descend from it, and sits inside
// BluetoothProviderWrapper for the BLE callbacks. The active board (for
// supportsClearLights) comes from useActiveBoard, since this is above the
// drawer host.

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toBoardName } from '@boardsesh/board-config';
import { useOptionalBluetoothContext } from './bluetooth-provider';
import { useActiveBoard } from '../lib/graphql/use-active-board';
import { disconnectAllBluetooth } from '../lib/ble/bluetooth-status-store';
import { BleControlSheet } from '../components/ble/BleControlSheet';

type BleControlSheetContextValue = {
  /** Reveal the BLE controls. No-ops unless this device holds the BLE link. */
  open: () => void;
  close: () => void;
};

const BleControlSheetContext = createContext<BleControlSheetContextValue | null>(null);

export function BleControlSheetProvider({ children }: { children: ReactNode }) {
  const bluetooth = useOptionalBluetoothContext();
  const { data: activeBoard } = useActiveBoard();
  const [visible, setVisible] = useState(false);

  const isConnected = bluetooth?.isConnected ?? false;

  const open = useCallback(() => {
    // Nothing to control unless this device holds the link.
    if (!isConnected) return;
    setVisible(true);
  }, [isConnected]);

  const close = useCallback(() => setVisible(false), []);

  // Close if the link drops while the sheet is open — otherwise it lingers
  // showing Re-light / Disconnect actions that no-op on a dead link (mirrors the
  // old in-drawer close-on-disconnect effect).
  useEffect(() => {
    if (!isConnected) setVisible(false);
  }, [isConnected]);

  const handleReassert = useCallback(() => {
    bluetooth?.armUndoWallChangeToast();
    bluetooth?.reassertWall();
  }, [bluetooth]);

  const handleClearLights = useCallback(() => {
    void bluetooth?.clearBoard();
  }, [bluetooth]);

  const value = useMemo<BleControlSheetContextValue>(() => ({ open, close }), [open, close]);

  return (
    <BleControlSheetContext value={value}>
      {children}
      {bluetooth ? (
        <BleControlSheet
          visible={visible}
          onReassert={handleReassert}
          onClearLights={handleClearLights}
          // MoonBoard's protocol has no clear-all frame; hide the row there.
          supportsClearLights={toBoardName(activeBoard?.boardType) !== 'moonboard'}
          onDisconnect={disconnectAllBluetooth}
          onClose={close}
        />
      ) : null}
    </BleControlSheetContext>
  );
}

export function useBleControlSheet(): BleControlSheetContextValue {
  const value = useContext(BleControlSheetContext);
  if (value === null) {
    throw new Error('useBleControlSheet must be used within a BleControlSheetProvider');
  }
  return value;
}
