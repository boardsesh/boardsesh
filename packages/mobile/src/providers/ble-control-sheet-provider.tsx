// Provides the "open the BLE controls (Re-light / Turn off all lights /
// Disconnect)" action to app chrome and renders ONE sheet instance at app root
// for the persistent accessory bar's board control. The play route can't use
// this root instance — an @expo/ui sheet presents off the VC that owns its
// subtree, so a root sheet lands BEHIND the modal player — so PlayDrawer hosts
// its own BleControlSheetHost; see that component. The destructive Disconnect
// always stays behind this labelled menu.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useOptionalBluetoothContext } from './bluetooth-provider';
import { BleControlSheetHost } from '../components/ble/BleControlSheetHost';
import { trackBoardControlsOpened, type BoardControlsSource } from '../lib/analytics-board-connect';

type BleControlSheetContextValue = {
  /**
   * Reveal the BLE controls, saying which control asked. No-ops unless this
   * device holds the BLE link.
   */
  open: (source: BoardControlsSource) => void;
  close: () => void;
};

const BleControlSheetContext = createContext<BleControlSheetContextValue | null>(null);

export function BleControlSheetProvider({ children }: { children: ReactNode }) {
  const bluetooth = useOptionalBluetoothContext();
  const [visible, setVisible] = useState(false);

  const isConnected = bluetooth?.isConnected ?? false;

  const open = useCallback(
    (source: BoardControlsSource) => {
      // Nothing to control unless this device holds the link.
      if (!isConnected) return;
      trackBoardControlsOpened(source);
      setVisible(true);
    },
    [isConnected],
  );

  const close = useCallback(() => setVisible(false), []);

  const value = useMemo<BleControlSheetContextValue>(() => ({ open, close }), [open, close]);

  return (
    <BleControlSheetContext value={value}>
      {children}
      {/* Root instance, for the persistent accessory bar. The host self-closes on
          disconnect. */}
      <BleControlSheetHost visible={visible} onClose={close} />
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
