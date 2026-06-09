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
import { isDisconnectionError } from '@boardsesh/ble-protocol/connection-error';
import type { AuroraBoardName } from '@boardsesh/shared-schema';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { createBluetoothAdapter, isNativeIosBleAdapter } from './adapter-factory';
import { requestBleRuntimePermissions } from './use-ble-permissions';
import type { BluetoothAdapter, DevicePickerFn, DiscoveredDevice } from './types';
import type { HoldPlacement } from '../../components/board-renderer/types';
import { track } from '../analytics';

// Exported for testing — isolates the .packet extraction so regressions are caught.
export async function dispatchMoonboardPacket(
  frames: string,
  write: BluetoothAdapter['write'],
  signal?: AbortSignal,
): Promise<true | undefined> {
  if (!frames) return undefined;
  const { packet } = getMoonboardBluetoothPacket(frames);
  await write(packet, signal);
  return true;
}

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

/**
 * Create a single AbortSignal that fires when either of the two input signals
 * is aborted. This lets us combine a caller-supplied signal with an internal
 * one without losing either.
 */
function mergeAbortSignals(signalA: AbortSignal, signalB: AbortSignal): AbortSignal {
  const controller = new AbortController();

  const onAbort = () => {
    controller.abort();
    signalA.removeEventListener('abort', onAbort);
    signalB.removeEventListener('abort', onAbort);
  };

  if (signalA.aborted || signalB.aborted) {
    controller.abort();
    return controller.signal;
  }

  signalA.addEventListener('abort', onAbort);
  signalB.addEventListener('abort', onAbort);

  return controller.signal;
}

function classifyBleFailureReason(error: unknown): string {
  if (isDisconnectionError(error)) return 'disconnected';
  if (error instanceof Error && error.message.includes('Mirrored hold ID')) return 'missing_mirror_mapping';
  if (error instanceof DOMException) return `dom_${error.name || 'exception'}`;
  return 'write_failed';
}

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

  // Remember the board (serial + which config it was paired against) so a later
  // involuntary drop can be recovered with a silent reconnect to the same board
  // (the lightbulb tap, native shells). Only valid while the current route still
  // points at the same board — switching board/layout/size invalidates it and
  // callers fall back to the picker. Mirrors the web `reconnectSerialForCurrentBoard`.
  const [lastConnectedBoard, setLastConnectedBoard] = useState<{ serial: string; configKey: string } | null>(null);

  const adapterRef = useRef<BluetoothAdapter | null>(null);
  const apiLevelRef = useRef<number>(3);
  const unsubDisconnectRef = useRef<(() => void) | null>(null);
  const writeAbortRef = useRef<AbortController | null>(null);

  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const pickerRejectRef = useRef<((error: Error) => void) | null>(null);

  // Keep the screen awake while connected to a board
  useEffect(() => {
    if (isConnected) {
      activateKeepAwakeAsync(KEEP_AWAKE_TAG).catch(() => {});
    } else {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
    }
    return () => {
      deactivateKeepAwake(KEEP_AWAKE_TAG).catch(() => {});
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

      subscribe(
        (devices) => {
          setPickerState((prev) => (prev ? { ...prev, devices } : null));
        },
        () => {
          // Scan window closed — drop the spinner. The picker stays open (a
          // device was found but not yet picked, or it shows the empty state).
          setPickerState((prev) => (prev ? { ...prev, isScanning: false } : null));
        },
      );
    });
  }, []);

  const handleDisconnection = useCallback(() => {
    setIsConnected(false);
    onConnectionChange?.(false);
  }, [onConnectionChange]);

  const sendFramesToBoard = useCallback(
    async (frames: string, mirrored: boolean = false, signal?: AbortSignal) => {
      if (!adapterRef.current || !boardName || layoutId === undefined || sizeId === undefined) return;
      const boardAnalyticsProperties = { boardName, layoutId, sizeId, mirrored };

      // Create an AbortController for this write so connect() can cancel
      // an in-flight write when creating a new adapter.
      const writeAbort = new AbortController();
      writeAbortRef.current = writeAbort;

      // Combine caller-provided signal with the internal abort controller
      const combinedSignal = signal ? mergeAbortSignals(signal, writeAbort.signal) : writeAbort.signal;

      try {
        if (boardName === 'moonboard') {
          const sent = await dispatchMoonboardPacket(
            frames,
            adapterRef.current.write.bind(adapterRef.current),
            combinedSignal,
          );
          if (sent) track(SHARED_EVENTS.ClimbSentToBoardSuccess, boardAnalyticsProperties);
          return sent;
        }

        // Empty frames = "clear all LEDs" for Aurora boards
        if (frames === '') {
          const clearResult = getAuroraBluetoothPacket('', {}, boardName as AuroraBoardName, apiLevelRef.current);
          await adapterRef.current.write(clearResult.packet, combinedSignal);
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
          Alert.alert(t('ble.notAvailable'), t('ble.errorLedMissing'));
          track(SHARED_EVENTS.ClimbSentToBoardFailure, {
            ...boardAnalyticsProperties,
            failureReason: 'missing_led_placements',
          });
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
          Alert.alert(t('ble.notAvailable'), t('ble.errorIncompatible'));
          track(SHARED_EVENTS.ClimbSentToBoardFailure, {
            ...boardAnalyticsProperties,
            failureReason: 'incompatible_climb',
          });
          return false;
        }

        if (skippedCount > 0) {
          console.warn(`[BLE] ${skippedCount} of ${result.totalPlacements} placements skipped`);
        }

        await adapterRef.current.write(result.packet, combinedSignal);
        track(SHARED_EVENTS.ClimbSentToBoardSuccess, boardAnalyticsProperties);
        return true;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        console.error('Error sending frames to board:', error);
        track(SHARED_EVENTS.ClimbSentToBoardFailure, {
          ...boardAnalyticsProperties,
          failureReason: classifyBleFailureReason(error),
        });
        // A write that fails because the link is gone (the board dropped or
        // another device grabbed it — these boards are last-connection-wins) is
        // often the only signal we get: the adapter's disconnect event may never
        // fire. Mark the connection lost so the lightbulb stops showing
        // "connected" and a deliberate reconnect can run. The native adapters
        // throw the plain-Error signatures the predicate matches ("Not
        // connected", "Device disconnected during write").
        if (isDisconnectionError(error)) {
          // The tug-of-war signal: we believed we were connected but a write just
          // failed on a dead link. On a shared board this is usually another
          // device having grabbed it. Recorded so the two-climber case is visible.
          track(SHARED_EVENTS.BluetoothConnectionStolen, { boardName, layoutId, sizeId });
          handleDisconnection();
        }
        return false;
      }
    },
    [boardName, layoutId, sizeId, holdsData, ledColorOverrides, handleDisconnection],
  );

  const connect = useCallback(
    async (initialFrames?: string, mirrored?: boolean, targetSerial?: string) => {
      if (!boardName) {
        console.error('Cannot connect to Bluetooth without board name');
        return false;
      }

      setLoading(true);

      try {
        const permissionsGranted = await requestBleRuntimePermissions({ requestNotificationPermission: true });
        if (!permissionsGranted) {
          Alert.alert(t('ble.permissionRequired'), t('ble.errorPermissionDenied'));
          return false;
        }

        const adapter = createBluetoothAdapter(devicePicker);

        const available = await adapter.isAvailable();
        if (!available) {
          Alert.alert(t('ble.notAvailable'), t('ble.notAvailable'));
          return false;
        }

        // Abort any in-flight write from the previous adapter so it
        // doesn't keep writing on a potentially-disconnected device.
        writeAbortRef.current?.abort();
        writeAbortRef.current = null;

        // Clean up any existing adapter
        if (adapterRef.current) {
          unsubDisconnectRef.current?.();
          try {
            await adapterRef.current.disconnect();
          } catch {
            // The previous adapter may already be torn down — e.g. after a
            // write-failure disconnect (another device grabbed the board) the
            // link is dead, and disconnecting a dead handle can reject. We're
            // replacing it anyway, so swallow it rather than aborting the
            // reconnect with a spurious error.
          }
        }

        // Surface the scan on the session-recording timeline / PostHog. `reconnect`
        // distinguishes a deliberate same-board serial reconnect (lightbulb) from a
        // fresh picker-driven connect.
        track(SHARED_EVENTS.BluetoothScanStarted, { boardName, layoutId, sizeId, reconnect: !!targetSerial });

        const connection = await adapter.requestAndConnect(targetSerial);
        apiLevelRef.current = parseApiLevel(connection.deviceName);

        unsubDisconnectRef.current = adapter.onDisconnect(handleDisconnection);
        adapterRef.current = adapter;

        // Push board configuration into the native BoardBleManager so the
        // Dynamic Island widget intent path (next/prev tapped while the app
        // is backgrounded) can encode wall packets from queue items stored in
        // the App Group without going through JS. No-op on Android.
        if (isNativeIosBleAdapter(adapter) && layoutId !== undefined && sizeId !== undefined) {
          try {
            await adapter.configureBoard({
              boardName,
              layoutId,
              sizeId,
              apiLevel: apiLevelRef.current,
              deviceName: connection.deviceName,
              colorOverrides: ledColorOverrides
                ? Object.fromEntries(
                    Object.entries(ledColorOverrides).filter(([, value]) => typeof value === 'string') as [
                      string,
                      string,
                    ][],
                  )
                : undefined,
            });
          } catch (error) {
            console.warn('[BLE] Failed to push board configuration to native side:', error);
          }
        }

        // Parse serial for Aurora boards
        let parsedSerial: string | null = null;
        if (boardName !== 'moonboard' && connection.deviceName) {
          parsedSerial = parseSerialNumber(connection.deviceName) ?? null;
        }

        // Remember the board (keyed to the config it was paired against) so an
        // involuntary drop can be recovered with a silent reconnect. Only Aurora
        // boards expose a parseable serial; moonboard can't be reconnected by serial.
        if (parsedSerial) {
          setLastConnectedBoard({ serial: parsedSerial, configKey: `${boardName}::${layoutId}::${sizeId}` });
        }

        // Send initial frames if provided
        if (initialFrames) {
          await sendFramesToBoard(initialFrames, mirrored);
        }

        setIsConnected(true);
        onConnectionChange?.(true);
        onConnectSuccess?.(parsedSerial);
        track(SHARED_EVENTS.BluetoothConnectionSuccess, { boardName, layoutId, sizeId });
        return true;
      } catch (error) {
        console.error('Error connecting to Bluetooth:', error);
        setIsConnected(false);

        // Dismiss the picker sheet if it's still showing. When a reconnect-by-
        // serial grace window opens the picker but nothing ever advertises, the
        // adapter rejects the selection promise on the scan timeout without
        // settling the picker's own promise — so the sheet (and its spinner)
        // would otherwise stay mounted until the user swipes it away. Settle the
        // dangling picker promise before clearing it (matching the unmount
        // cleanup) so it can't leak.
        pickerRejectRef.current?.(new Error('Connection failed'));
        pickerRejectRef.current = null;
        setPickerState(null);

        const errorMessage = error instanceof Error ? error.message : String(error);
        const isUserCancel =
          /user cancelled|cancel/i.test(errorMessage) || /Device selection cancelled/i.test(errorMessage);

        if (!isUserCancel) {
          Alert.alert(t('ble.notAvailable'), t('ble.errorConnectionFailed'));
        }

        track(SHARED_EVENTS.BluetoothConnectionFailed, {
          boardName,
          layoutId,
          sizeId,
          failureReason: classifyBleFailureReason(error),
        });
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
    // A deliberate disconnect clears the remembered board — only an involuntary
    // drop should offer a silent same-board reconnect.
    setLastConnectedBoard(null);
    onConnectionChange?.(false);
    await adapter?.disconnect();
  }, [onConnectionChange]);

  // Serial to silently reconnect to for the board currently in view, or null
  // when nothing is remembered or the user switched boards (in which case the
  // caller opens the device picker instead).
  //
  // Deliberately keyed on board+layout+size only — NOT set_ids, which web's
  // boardIdentityKey also folds in. The mobile BluetoothProvider is handed a
  // single global activeBoard (no set_ids), and the LED placement map keys on
  // layout+size alone, so a same-board reconnect renders identically regardless
  // of set_ids. Don't thread set_ids in here without also passing it to the
  // provider.
  const currentConfigKey =
    boardName && layoutId !== undefined && sizeId !== undefined ? `${boardName}::${layoutId}::${sizeId}` : null;
  const reconnectSerialForCurrentBoard =
    lastConnectedBoard && currentConfigKey && lastConnectedBoard.configKey === currentConfigKey
      ? lastConnectedBoard.serial
      : null;

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
    reconnectSerialForCurrentBoard,
  };
}
