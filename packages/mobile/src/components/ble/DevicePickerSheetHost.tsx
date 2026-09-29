import { useEffect, useId } from 'react';
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
 * bar) and, with `registerExternal`, inside the play and create-climb routes so
 * a connect from their lightbulb presents over the route instead of behind it.
 *
 * Two `registerExternal` hosts can be mounted at once (e.g. the player is
 * pushed on top of create-climb without unmounting it), so registering alone
 * doesn't decide whether THIS instance renders the sheet — only the
 * most-recently-registered host (`activeExternalHostId`) does. Rendering
 * unconditionally here would double-present the same picker session into two
 * sheet hosts and trip the sheet coordinator's displacement handling.
 */
export function DevicePickerSheetHost({ registerExternal = false }: DevicePickerSheetHostProps) {
  const hostId = useId();
  const {
    pickerState,
    onSelect,
    currentBoardConfig,
    registerExternalHost,
    activeExternalHostId,
    onNoLeds,
    onScanAgain,
  } = useBlePickerHost();
  const resolvedBoards = useResolvedBleDeviceBoards(pickerState?.devices ?? EMPTY_DEVICES);

  useEffect(() => {
    if (!registerExternal) return undefined;
    return registerExternalHost(hostId);
  }, [registerExternal, registerExternalHost, hostId]);

  if (!pickerState) return null;
  if (registerExternal && activeExternalHostId !== hostId) return null;

  return (
    <DevicePickerSheet
      key={pickerState.sessionId}
      devices={pickerState.devices}
      onSelect={onSelect}
      onDismiss={pickerState.handleCancel}
      isScanning={pickerState.isScanning}
      resolvedBoards={resolvedBoards}
      currentBoardConfig={currentBoardConfig}
      onNoLeds={onNoLeds}
      onScanAgain={onScanAgain}
      mode={pickerState.mode}
      open={pickerState.presented}
      closing={pickerState.closing}
      onClosed={pickerState.handleClosed}
      onSearchAnyBoard={pickerState.handleSearchAnyBoard}
      onDisplaced={pickerState.handleDisplaced}
    />
  );
}
