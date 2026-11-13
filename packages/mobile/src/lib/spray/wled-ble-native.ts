import { AppState, Platform } from 'react-native';
import type { Device, Subscription } from 'react-native-ble-plx';
import {
  WLED_BLE_SERVICE_UUID,
  WLED_BLE_CAPABILITIES_UUID,
  WLED_BLE_REQUEST_UUID,
  WLED_BLE_RESPONSE_UUID,
  WledBleFrameAssembler,
  decodeUtf8,
  encodeFrame,
  fragmentFrame,
  parseCapabilities,
  parseResponse,
  type WledBleCapabilities,
  type WledBleConnection,
  type WledBleOperation,
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
  try {
    await bounded(Promise.resolve(getBleManager().cancelDeviceConnection(deviceId)), controller.signal, 1800);
  } catch {
    /* Firmware's idle timeout also releases an unreachable radio. */
  }
}
function operationController(signal?: AbortSignal) {
  // Discovery must not connect to or disconnect a peripheral an active write owns.
  if (active.size > 0) throw new LedControllerError('unavailable');
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
  const abort = () => {
    void disconnectDevice(deviceId);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    const connecting = getBleManager().connectToDevice(deviceId, { timeout: 8000 });
    // A native connection may resolve after cancellation; never retain that link.
    void connecting.then(
      () => {
        if (signal.aborted) void disconnectDevice(deviceId);
      },
      () => undefined,
    );
    let device = await bounded(connecting, signal);
    check(signal);
    device = await bounded(device.discoverAllServicesAndCharacteristics(), signal);
    check(signal);
    if (Platform.OS === 'android') {
      try {
        device = await bounded(device.requestMTU(185), signal, 2000);
      } catch {
        check(signal);
      }
    }
    const characteristic = await bounded(
      device.readCharacteristicForService(WLED_BLE_SERVICE_UUID, WLED_BLE_CAPABILITIES_UUID),
      signal,
    );
    check(signal);
    const capabilities = parseCapabilities(JSON.parse(decodeUtf8(bytesFromBase64(characteristic.value))));
    return { device, capabilities };
  } catch (error) {
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

let requestCounter = 0;
async function connect(controllerId: string, signal?: AbortSignal): Promise<WledBleConnection> {
  const { controller, release } = operationController(signal);
  const generation = getCredentialGeneration();
  let device: Device | null = null;
  let subscription: Subscription | null = null;
  let disconnected: Subscription | null = null;
  let pendingReject: ((error: Error) => void) | null = null;
  let cancelFragmentTimeout: (() => void) | null = null;
  let closed = false;
  const onAbort = () => {
    pendingReject?.(new LedControllerError('cancelled'));
    if (device) void disconnectDevice(device.id);
  };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  async function close() {
    if (closed) return;
    closed = true;
    controller.abort();
    cancelFragmentTimeout?.();
    subscription?.remove();
    disconnected?.remove();
    release();
    if (device) await disconnectDevice(device.id);
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
    let responseListener: ((payload: unknown) => void) | null = null;
    const assembler = new WledBleFrameAssembler();
    subscription = device.monitorCharacteristicForService(
      WLED_BLE_SERVICE_UUID,
      WLED_BLE_RESPONSE_UUID,
      (error, characteristic) => {
        if (closed) return;
        if (error) {
          controller.abort();
          return;
        }
        try {
          const payload = assembler.push(bytesFromBase64(characteristic?.value ?? null));
          cancelFragmentTimeout?.();
          cancelFragmentTimeout = payload === null ? setBackgroundSafeTimeout(() => controller.abort(), 5000) : null;
          if (payload !== null) responseListener?.(payload);
        } catch {
          controller.abort();
        }
      },
    );
    disconnected = getBleManager().onDeviceDisconnected(device.id, () => controller.abort());
    return {
      capabilities,
      disconnect: close,
      async request(
        op: WledBleOperation,
        state?: Record<string, unknown>,
        requestSignal?: AbortSignal,
      ): Promise<unknown> {
        check(controller.signal);
        if (pendingReject) throw new LedControllerError('command-failed');
        const id = `m${++requestCounter}`;
        const frame = encodeFrame(op === 'setState' ? { id, op, state } : { id, op }, capabilities.maxMessageBytes);
        const abort = () => controller.abort();
        requestSignal?.addEventListener('abort', abort, { once: true });
        if (requestSignal?.aborted) abort();
        const response = new Promise<unknown>((resolve, reject) => {
          pendingReject = reject;
          responseListener = (payload) => {
            try {
              resolve(parseResponse(payload, id));
            } catch (error) {
              reject(error);
            }
          };
        });
        // Attach before any write: a fast peripheral may indicate immediately.
        const completed = bounded(response, controller.signal, 12000);
        void completed.catch(() => controller.abort());
        try {
          const payloadBytes = Math.max(20, Math.min(512, (connectedDevice.mtu || 23) - 3));
          for (const fragment of fragmentFrame(frame, payloadBytes)) {
            check(controller.signal);
            await bounded(
              connectedDevice.writeCharacteristicWithResponseForService(
                WLED_BLE_SERVICE_UUID,
                WLED_BLE_REQUEST_UUID,
                uint8ArrayToBase64(fragment),
              ),
              controller.signal,
            );
          }
          return await completed;
        } catch (error) {
          controller.abort();
          throw error;
        } finally {
          pendingReject = null;
          responseListener = null;
          assembler.reset();
          cancelFragmentTimeout?.();
          cancelFragmentTimeout = null;
          requestSignal?.removeEventListener('abort', abort);
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export const nativeWledBleDriver = createWledBleDriver({ connect });
