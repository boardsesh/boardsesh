import { AppState, Platform } from 'react-native';
import type { Device } from 'react-native-ble-plx';
import {
  WLED_BLE_SERVICE_UUID,
  WLED_BLE_CAPABILITIES_UUID,
  decodeUtf8,
  parseCapabilities,
  openWledBleSession,
  type WledBleSession,
  type WledBleCapabilities,
  type WledBleConnection,
} from '@boardsesh/wled-ble-protocol';
import { LedControllerError, createWledBleDriver } from '@boardsesh/led-controller';
import { getBleManager } from '../ble/ble-manager';
import { claimBleScan, releaseBleScan } from '../ble/ble-scan-slot';
import { uint8ArrayToBase64 } from '../ble/base64';
import { waitForBlePoweredOn } from '../ble/availability';
import { requestBleRuntimePermissions } from '../ble/use-ble-permissions';
import { setBackgroundSafeTimeout } from '../ble/background-safe-timeout';
import { getCredentialGeneration, subscribeToCredentialChanges } from '../privacy/privacy-cache';
import { subscribeSprayWallLedCacheErased } from './spray-wall-led-cache';

// IDs are phone-specific and intentionally never leave this in-memory cache.
const remembered = new Map<string, string>();
const active = new Set<AbortController>();
// Caller deadlines bound the UI wait, not native radio work. Keep late SDK
// operations quarantined so their cleanup cannot disconnect a newer session.
const pendingNative = new Set<symbol>();
const pendingDisconnects = new Map<string, Promise<unknown>>();
function trackNative<Result>(start: () => Promise<Result>): Promise<Result> {
  const token = Symbol('wled-native-operation');
  pendingNative.add(token);
  return Promise.resolve()
    .then(start)
    .finally(() => {
      pendingNative.delete(token);
    });
}
function retire(): void {
  remembered.clear();
  for (const controller of active) controller.abort();
}
subscribeToCredentialChanges(retire);
subscribeSprayWallLedCacheErased(() => retire());
AppState.addEventListener('change', (state) => {
  if (state === 'background') retire();
});

function bytesFromBase64(encoded: string | null): Uint8Array {
  if (!encoded) throw new LedControllerError('not-wled');
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}
function check(signal: AbortSignal): void {
  if (signal.aborted) throw new LedControllerError('cancelled');
}
function bounded<Result>(operation: Promise<Result>, signal: AbortSignal, timeoutMs = 10000): Promise<Result> {
  return new Promise((resolve, reject) => {
    const abort = () => finish(new LedControllerError('cancelled'));
    let done = false;
    const cancelTimeout = setBackgroundSafeTimeout(() => finish(new LedControllerError('timeout')), timeoutMs);
    function finish(error?: Error, result?: Result) {
      if (done) return;
      done = true;
      cancelTimeout();
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result!);
    }
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (result) => finish(undefined, result),
      (error: unknown) => finish(error instanceof Error ? error : new LedControllerError('unavailable')),
    );
  });
}
async function disconnectDevice(deviceId: string): Promise<void> {
  const controller = new AbortController();
  let disconnecting = pendingDisconnects.get(deviceId);
  if (!disconnecting) {
    disconnecting = trackNative(() => getBleManager().cancelDeviceConnection(deviceId));
    pendingDisconnects.set(deviceId, disconnecting);
    const forget = () => {
      if (pendingDisconnects.get(deviceId) === disconnecting) pendingDisconnects.delete(deviceId);
    };
    void disconnecting.then(forget, forget);
  }
  try {
    await bounded(disconnecting, controller.signal, 1800);
  } catch {
    // The caller can finish after 1.8 seconds, but pendingNative still excludes
    // every new operation until this actual native cancellation has settled.
  }
}
function operationController(signal?: AbortSignal) {
  // Discovery must not connect to or disconnect a peripheral an active write owns.
  if (active.size > 0 || pendingNative.size > 0) throw new LedControllerError('unavailable');
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  active.add(controller);
  return {
    controller,
    release: () => {
      active.delete(controller);
      signal?.removeEventListener('abort', abort);
    },
  };
}
async function permitted(signal: AbortSignal) {
  if (Platform.OS === 'web' || AppState.currentState === 'background') throw new LedControllerError('unavailable');
  check(signal);
  if (!(await requestBleRuntimePermissions())) throw new LedControllerError('unavailable');
  check(signal);
  if (!(await waitForBlePoweredOn())) throw new LedControllerError('unavailable');
  check(signal);
}
async function scan(signal: AbortSignal): Promise<string[]> {
  check(signal);
  if (pendingNative.size > 0) throw new LedControllerError('unavailable');
  const token = Symbol('wled-ble-scan');
  if (!claimBleScan(token)) throw new LedControllerError('unavailable');
  const candidates = new Set<string>();
  try {
    return await new Promise<string[]>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        cancelTimeout();
        signal.removeEventListener('abort', abort);
        if (releaseBleScan(token)) void getBleManager().stopDeviceScan();
        if (error) reject(error);
        else resolve([...candidates]);
      };
      const abort = () => finish(new LedControllerError('cancelled'));
      const cancelTimeout = setBackgroundSafeTimeout(() => finish(), 5000);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      try {
        void getBleManager().startDeviceScan([WLED_BLE_SERVICE_UUID], { allowDuplicates: false }, (error, device) => {
          if (settled) return;
          if (error) {
            finish(new LedControllerError('unavailable'));
            return;
          }
          if (device && candidates.size < 16) candidates.add(device.id);
        });
      } catch {
        finish(new LedControllerError('unavailable'));
      }
    });
  } finally {
    if (releaseBleScan(token)) void getBleManager().stopDeviceScan();
  }
}
async function open(
  deviceId: string,
  signal: AbortSignal,
): Promise<{ device: Device; capabilities: WledBleCapabilities }> {
  check(signal);
  if (pendingNative.size > 0) throw new LedControllerError('unavailable');
  let abandoned = false;
  const abort = () => {
    abandoned = true;
    void disconnectDevice(deviceId);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const connecting = trackNative(() =>
      getBleManager()
        .connectToDevice(deviceId, { timeout: 8000 })
        .then(async (connected) => {
          // Schedule late cleanup before releasing the native-operation token.
          // This covers caller cancellation AND the bounded connect deadline.
          if (signal.aborted || abandoned) await disconnectDevice(deviceId);
          return connected;
        }),
    );
    let device = await bounded(connecting, signal);
    check(signal);
    device = await bounded(
      trackNative(() => device.discoverAllServicesAndCharacteristics()),
      signal,
    );
    check(signal);
    if (Platform.OS === 'android') {
      try {
        device = await bounded(
          trackNative(() => device.requestMTU(185)),
          signal,
          2000,
        );
      } catch {
        check(signal);
      }
    }
    const characteristic = await bounded(
      trackNative(() => device.readCharacteristicForService(WLED_BLE_SERVICE_UUID, WLED_BLE_CAPABILITIES_UUID)),
      signal,
    );
    check(signal);
    const capabilities = parseCapabilities(JSON.parse(decodeUtf8(bytesFromBase64(characteristic.value))));
    return { device, capabilities };
  } catch (error) {
    abandoned = true;
    await disconnectDevice(deviceId);
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

/** Owner selection probes capabilities only: it never writes lighting state. */
export async function discoverWledBluetooth(signal?: AbortSignal): Promise<WledBleCapabilities[]> {
  const { controller, release } = operationController(signal);
  const generation = getCredentialGeneration();
  try {
    await permitted(controller.signal);
    const candidates = await scan(controller.signal);
    const controllers = new Map<string, WledBleCapabilities>();
    for (const deviceId of candidates) {
      check(controller.signal);
      if (pendingNative.size > 0) throw new LedControllerError('unavailable');
      try {
        const opened = await open(deviceId, controller.signal);
        check(controller.signal);
        if (getCredentialGeneration() !== generation) throw new LedControllerError('cancelled');
        remembered.set(opened.capabilities.controllerId, deviceId);
        controllers.set(opened.capabilities.controllerId, opened.capabilities);
      } catch {
        check(controller.signal);
      } finally {
        await disconnectDevice(deviceId);
      }
    }
    return [...controllers.values()];
  } finally {
    release();
  }
}

function sessionError(error: unknown): unknown {
  if (typeof error !== 'object' || error === null || !('code' in error)) return error;
  const code = error.code;
  if (code === 'cancelled' || code === 'disconnected' || code === 'fragment-timeout') {
    return new LedControllerError('cancelled');
  }
  if (code === 'timeout') return new LedControllerError('timeout');
  return error;
}

async function connect(controllerId: string, signal?: AbortSignal): Promise<WledBleConnection> {
  const { controller, release } = operationController(signal);
  const generation = getCredentialGeneration();
  let device: Device | null = null;
  let session: WledBleSession | undefined;
  let closing: Promise<void> | undefined;
  const onAbort = () => {
    if (session) void session.disconnect().catch(() => undefined);
    else if (device) void disconnectDevice(device.id);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  function close(): Promise<void> {
    if (closing) return closing;
    closing = Promise.resolve().then(async () => {
      controller.abort();
      controller.signal.removeEventListener('abort', onAbort);
      try {
        if (session) await session.disconnect();
        else if (device) await disconnectDevice(device.id);
      } finally {
        release();
      }
    });
    return closing;
  }
  try {
    await permitted(controller.signal);
    const cached = remembered.get(controllerId);
    let opened: Awaited<ReturnType<typeof open>> | null = null;
    if (cached) {
      try {
        const candidate = await open(cached, controller.signal);
        if (candidate.capabilities.controllerId === controllerId) opened = candidate;
        else await disconnectDevice(cached);
      } catch {
        check(controller.signal);
      }
      if (!opened) remembered.delete(controllerId);
    }
    if (!opened) {
      for (const deviceId of await scan(controller.signal)) {
        check(controller.signal);
        if (pendingNative.size > 0) throw new LedControllerError('unavailable');
        try {
          const candidate = await open(deviceId, controller.signal);
          if (candidate.capabilities.controllerId === controllerId) {
            opened = candidate;
            break;
          }
        } catch {
          check(controller.signal);
        }
        await disconnectDevice(deviceId);
      }
    }
    if (!opened) throw new LedControllerError('unavailable');
    device = opened.device;
    check(controller.signal);
    if (getCredentialGeneration() !== generation) throw new LedControllerError('cancelled');
    remembered.set(controllerId, device.id);
    const connectedDevice = device;
    const capabilities = opened.capabilities;
    session = await openWledBleSession(
      {
        deviceId: connectedDevice.id,
        deviceName: connectedDevice.name ?? undefined,
        maxWriteBytes: Math.max(20, Math.min(512, (connectedDevice.mtu || 23) - 3)),
        async getCharacteristic(target) {
          return {
            writeWithResponse: true,
            writeWithoutResponse: false,
            async write(bytes, _mode, requestSignal) {
              if (requestSignal?.aborted) throw new LedControllerError('cancelled');
              await trackNative(() =>
                connectedDevice.writeCharacteristicWithResponseForService(
                  target.serviceUuid,
                  target.characteristicUuid,
                  uint8ArrayToBase64(bytes),
                ),
              );
            },
            async read(requestSignal) {
              if (requestSignal?.aborted) throw new LedControllerError('cancelled');
              const characteristic = await trackNative(() =>
                connectedDevice.readCharacteristicForService(target.serviceUuid, target.characteristicUuid),
              );
              return bytesFromBase64(characteristic.value);
            },
            async subscribe(listener, onError, requestSignal) {
              if (requestSignal?.aborted) throw new LedControllerError('cancelled');
              // ble-plx returns a cancellation handle, not a CCCD-ready promise.
              // Preserve native operation ordering; real-device notification setup
              // remains a QA requirement (see the WLED package README).
              const subscription = connectedDevice.monitorCharacteristicForService(
                target.serviceUuid,
                target.characteristicUuid,
                (error, characteristic) => {
                  if (error) {
                    onError(new LedControllerError('cancelled'));
                    return;
                  }
                  try {
                    listener(bytesFromBase64(characteristic?.value ?? null));
                  } catch {
                    onError(new LedControllerError('cancelled'));
                  }
                },
              );
              return () => subscription.remove();
            },
          };
        },
        onDisconnect(listener) {
          const subscription = getBleManager().onDeviceDisconnected(connectedDevice.id, () =>
            listener(new LedControllerError('cancelled')),
          );
          return () => subscription.remove();
        },
        disconnect: () => disconnectDevice(connectedDevice.id),
      },
      capabilities,
      {
        expectedControllerId: controllerId,
        signal: controller.signal,
        scheduler: { now: () => Date.now(), setTimeout: setBackgroundSafeTimeout },
      },
    );
    check(controller.signal);
    const activeSession = session;
    return {
      capabilities,
      disconnect: close,
      async request(op, state, requestSignal) {
        check(controller.signal);
        try {
          return await activeSession.request(op, state, requestSignal);
        } catch (error) {
          throw sessionError(error);
        }
      },
    };
  } catch (error) {
    await close();
    throw sessionError(error);
  }
}
export const nativeWledBleDriver = createWledBleDriver({ connect });
