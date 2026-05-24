import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import {
  getAuroraBluetoothPacket,
  parseApiLevel,
  parseSerialNumber,
  type LedColorOverrides,
} from '@boardsesh/ble-protocol/aurora';
import { getMoonboardBluetoothPacket } from '@boardsesh/ble-protocol/moonboard';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { RNBleAdapter } from './adapter';
import type { BluetoothAdapter, DevicePickerFn, DiscoveredDevice } from './types';
import type { HoldPlacement } from '../../components/board-renderer/types';

export type PickerState = {
  devices: DiscoveredDevice[];
  isScanning: boolean;
  handleSelect: (deviceId: string) => void;
  handleCancel: () => void;
};

type GetLedPlacementsFn = (boardName: string, layoutId: number, sizeId: number) => Record<number, number>;
let cachedGetLedPlacements: GetLedPlacementsFn | null = null;

export const convertToMirroredFramesString = (frames: string, holdsData: HoldPlacement[]): string => {
  const holdIdToMirroredIdMap = new Map<number, number>();
  for (const hold of holdsData) {
    if (hold.mirroredHoldId) {
      holdIdToMirroredIdMap.set(hold.id, hold.mirroredHoldId);
    }
  }

  return frames
    .split('p')
    .filter((hold) => hold)
    .map((holdEntry) => {
      const [holdId, stateCode] = holdEntry.split('r').map((str) => Number(str));
      const mirroredHoldId = holdIdToMirroredIdMap.get(holdId);

      if (mirroredHoldId === undefined) {
        throw new Error(`Mirrored hold ID is not defined for hold ID ${holdId}.`);
      }

      return `p${mirroredHoldId}r${stateCode}`;
    })
    .join('');
};

type UseBoardBluetoothOptions = {
  boardName?: string;
  layoutId?: number;
  sizeId?: number;
  holdsData?: HoldPlacement[];
  ledColorOverrides?: LedColorOverrides;
  onConnectionChange?: (connected: boolean) => void;
  onConnectSuccess?: (serial: string | null) => void;
};

const KEEP_AWAKE_TAG = 'boardsesh-ble';

export function useBoardBluetooth({
  boardName,
  layoutId,
  sizeId,
  holdsData,
  ledColorOverrides,
  onConnectionChange,
  onConnectSuccess,
}: UseBoardBluetoothOptions) {
  const { t } = useTranslation('settings');
  const [loading, setLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);

  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const pickerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Keep the screen awake while connected to a board
  useEffect(() => {
    if (isConnected) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    }
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG);
    };
  }, [isConnected]);

  const devicePicker = useCallback<DevicePickerFn>((subscribe) => {
    return new Promise<string>((resolve, reject) => {
      pickerRejectRef.current = reject;

      const cleanup = () => {
        pickerRejectRef.current = null;
        setPickerState(null);
      };

      const handleSelect = (deviceId: string) => {
        cleanup();
        resolve(deviceId);
      };

      const handleCancel = () => {
        cleanup();
        reject(new Error('Device selection cancelled'));
      };

      setPickerState({ devices: [], isScanning: true, handleSelect, handleCancel });

      subscribe((devices) => {
        setPickerState((prev) => (prev ? { ...prev, devices } : null));
      });
    });
  }, []);

  const handleDisconnection = useCallback(() => {
    setIsConnected(false);
    onConnectionChange?.(false);
  }, [onConnectionChange]);

  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal) => {
      if (!adapterRef.current || !boardName || layoutId === undefined || sizeId === undefined) return;

      try {
        if (boardName === 'moonboard') {
          if (!frames) return;
          const moonboardResult = getMoonboardBluetoothPacket(frames);
          await adapterRef.current.write(moonboardResult.packet, signal);
          // TODO: analytics (Phase 6)
          return true;
        }

        // Empty frames = "clear all LEDs" for Aurora boards
        if (frames === '') {
          const clearResult = getAuroraBluetoothPacket('', {}, boardName as AuroraBoardName, apiLevelRef.current);
          await adapterRef.current.write(clearResult.packet, signal);
          return true;
        }

        let framesToSend = frames;

        if (mirrored && holdsData && holdsData.length > 0) {
          framesToSend = convertToMirroredFramesString(frames, holdsData);
        }

        if (!cachedGetLedPlacements) {
          const mod = await import('@boardsesh/board-constants/led-placements');
          cachedGetLedPlacements = mod.getLedPlacements as GetLedPlacementsFn;
        }
        const getLedPlacementsFn = cachedGetLedPlacements;
        const placementPositions = getLedPlacementsFn(boardName, layoutId, sizeId);

        if (Object.keys(placementPositions).length === 0) {
          console.error(
            `[BLE] LED placement map is empty for ${boardName} layout=${layoutId} size=${sizeId}. Board configuration may be incorrect or LED data may need regeneration.`,
          );
          Alert.alert(t('settings.ble.notAvailable'), t('settings.ble.errorLedMissing'));
          return false;
        }

        const result = getAuroraBluetoothPacket(
          framesToSend,
          placementPositions,
          boardName as AuroraBoardName,
          apiLevelRef.current,
          ledColorOverrides,
        );

        const skippedCount = result.skippedPositionCount + result.skippedRoleCount;

        if (skippedCount > 0 && result.packet.length === 0) {
          console.warn(`[BLE] All ${result.totalPlacements} placements skipped — climb incompatible with board`);
          Alert.alert(t('settings.ble.notAvailable'), t('settings.ble.errorIncompatible'));
          return false;
        }

        if (skippedCount > 0) {
          console.warn(`[BLE] ${skippedCount} of ${result.totalPlacements} placements skipped`);
        }

        await adapterRef.current.write(result.packet, signal);
        // TODO: analytics (Phase 6)
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Error sending frames to board:', error);
        return false;
      }
    },
    [boardName, layoutId, sizeId, holdsData, ledColorOverrides],
  );

  const connect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => {
      if (!boardName) {
        console.error('Cannot connect to Bluetooth without board name');
        return false;
      }

      setLoading(true);

      try {
        const adapter = new RNBleAdapter(devicePicker);

        const available = await adapter.isAvailable();
        if (!available) {
          Alert.alert(t('settings.ble.notAvailable'), t('settings.ble.notAvailable'));
          return false;
        }

        // Clean up any existing adapter
        if (adapterRef.current) {
          unsubDisconnectRef.current?.();
          await adapterRef.current.disconnect();
        }

        const connection = await adapter.requestAndConnect(targetSerial);
        apiLevelRef.current = parseApiLevel(connection.deviceName);

        unsubDisconnectRef.current = adapter.onDisconnect(handleDisconnection);
        adapterRef.current = adapter;

        // TODO: analytics (Phase 6)

        // Parse serial for Aurora boards
        let parsedSerial: string | null = null;
        if (boardName !== 'moonboard' && connection.deviceName) {
          parsedSerial = parseSerialNumber(connection.deviceName) ?? null;
        }

        // Send initial frames if provided
        if (initialFrames) {
          await sendFramesToBoard(initialFrames, mirrored);
        }

        setIsConnected(true);
        onConnectionChange?.(true);
        onConnectSuccess?.(parsedSerial);
        return true;
      } catch (error) {
        console.error('Error connecting to Bluetooth:', error);
        setIsConnected(false);

        const errorMessage = error instanceof Error ? error.message : String(error);
        const isUserCancel =
          /user cancelled|cancel/i.test(errorMessage) || /Device selection cancelled/i.test(errorMessage);

        if (!isUserCancel) {
          Alert.alert(t('settings.ble.notAvailable'), t('settings.ble.errorConnectionFailed'));
        }

        // TODO: analytics (Phase 6)
      } finally {
        setLoading(false);
      }

      return false;
    },
    [handleDisconnection, boardName, onConnectionChange, onConnectSuccess, sendFramesToBoard, devicePicker],
  );

  const disconnect = useCallback(async () => {
    unsubDisconnectRef.current?.();
    unsubDisconnectRef.current = null;
    const adapter = adapterRef.current;
    adapterRef.current = null;
    setIsConnected(false);
    onConnectionChange?.(false);
    // TODO: analytics (Phase 6)
    await adapter?.disconnect();
  }, [onConnectionChange]);

  // Clean up on unmount
  useEffect(() => {
    return () => {
      pickerRejectRef.current?.(new Error('Component unmounted'));
      pickerRejectRef.current = null;
      unsubDisconnectRef.current?.();
      void adapterRef.current?.disconnect();
    };
  }, []);

  return {
    isConnected,
    loading,
    connect,
    disconnect,
    sendFramesToBoard,
    pickerState,
  };
}
