import { useEffect } from 'react';
import { useResolvedBleDeviceBoards } from '../../lib/ble/resolve-serials';
import { useBlePickerHost } from '../../providers/ble-picker-host';
import { DevicePickerSheet } from './DevicePickerSheet';

const EMPTY_DEVICES: [] = [];

type DevicePickerSheetHostProps = {
  /**
   * When true this host claims the picker, suppressing the app-root instance. Set
   * on the play route: a root-presented picker lands behind the modal route (and
   * presenting it forces the route to dismiss), so the route hosts its own from
   * inside its view controller, where it stacks above — like QueueSheet.
   */
  registerExternal?: boolean;
};

/**
 * Renders the BLE device picker from the shared picker-host context. Hosted at
 * app root by BluetoothProvider (for connects off the tab screens / accessory
 * bar) and, with `registerExternal`, inside the play route so a connect from the
 * lightbulb presents over the player instead of dismissing it.
 */
export function DevicePickerSheetHost({ registerExternal = false }: DevicePickerSheetHostProps) {
  const { pickerState, onSelect, currentBoardConfig, setHostedExternally, onNoLeds } = useBlePickerHost();
  const resolvedBoards = useResolvedBleDeviceBoards(pickerState?.devices ?? EMPTY_DEVICES);

  useEffect(() => {
    if (!registerExternal) return;
    setHostedExternally(true);
    return () => setHostedExternally(false);
  }, [registerExternal, setHostedExternally]);

  if (!pickerState) return null;

  return (
    <DevicePickerSheet
      devices={pickerState.devices}
      onSelect={onSelect}
      onDismiss={pickerState.handleCancel}
      isScanning={pickerState.isScanning}
      resolvedBoards={resolvedBoards}
      currentBoardConfig={currentBoardConfig}
      onNoLeds={onNoLeds}
    />
  );
}
