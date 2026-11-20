import {
  BleSessionRuntime,
  BleError,
  bounded,
  defaultBleScheduler,
  resolveRgb,
  snapshotLights,
  throwIfAborted,
  type BleOpenOptions,
  type BleScheduler,
  type BleTransport,
  type BoardBleCapabilities,
  type BoardBleProtocol,
  type BoardBleSession,
  type BoardLight,
  type BoardRole,
  type RolePalette,
} from '@boardsesh/ble-core';
import {
  WLED_BLE_SERVICE_UUID,
  WLED_BLE_CAPABILITIES_UUID,
  WLED_BLE_REQUEST_UUID,
  WLED_BLE_RESPONSE_UUID,
  WLED_BLE_FRAGMENT_TIMEOUT_MS,
  WledBleFrameAssembler,
  WledBleProtocolError,
  decodeUtf8,
  encodeFrame,
  fragmentFrame,
  parseCapabilities,
  parseRequest,
  parseResponse,
  type WledBleCapabilities,
  type WledBleOperation,
} from './protocol';
import { createWledCommandDriver } from './lighting';

export interface WledBleSession extends BoardBleSession {
  readonly controllerCapabilities: Readonly<WledBleCapabilities>;
  request(op: WledBleOperation, state?: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface WledBleSessionOptions extends BleOpenOptions {
  /** Stable firmware identity, distinct from a platform-specific peripheral ID. */
  expectedControllerId?: string;
  rolePalette?: RolePalette;
  /** WLED master brightness, clamped to 1–255; defaults to 64. */
  brightness?: number;
}

const WLED_ROLES: readonly BoardRole[] = ['start', 'hand', 'foot', 'finish'];

function snapshotOptions(options: WledBleSessionOptions): WledBleSessionOptions {
  const rolePalette: Partial<Record<BoardRole, readonly [number, number, number]>> = {};
  for (const role of WLED_ROLES) {
    if (options.rolePalette?.[role] !== undefined) {
      rolePalette[role] = resolveRgb({ index: 0, role }, options.rolePalette);
    }
  }
  return { ...options, rolePalette };
}

function capabilitiesForPalette(palette?: RolePalette): BoardBleCapabilities {
  return {
    rgb: true,
    roles: WLED_ROLES.filter((role) => palette?.[role] !== undefined),
    readback: true,
  };
}

/** A capability probe does not subscribe or change the controller's lighting state. */
export async function readWledBleCapabilities(
  transport: BleTransport,
  signal: AbortSignal,
  scheduler: BleScheduler = defaultBleScheduler,
): Promise<WledBleCapabilities> {
  const characteristic = await bounded(
    transport.getCharacteristic(
      {
        serviceUuid: WLED_BLE_SERVICE_UUID,
        characteristicUuid: WLED_BLE_CAPABILITIES_UUID,
      },
      signal,
    ),
    signal,
    10_000,
    scheduler,
  );
  if (!characteristic.read) throw new WledBleProtocolError('capabilities-unavailable');
  const bytes = await bounded(characteristic.read(signal), signal, 10_000, scheduler);
  return parseCapabilities(JSON.parse(decodeUtf8(bytes)) as unknown);
}

/**
 * Open a session after a capability probe. Takes ownership of the transport,
 * including cleanup on initialization failure. Native selection can reuse its
 * already-validated probe without opening a second connection.
 */
async function initializeWledBleSession(
  transport: BleTransport,
  loadCapabilities: (signal: AbortSignal, scheduler: BleScheduler) => Promise<WledBleCapabilities>,
  options: WledBleSessionOptions = {},
): Promise<WledBleSession> {
  const scheduler = options.scheduler ?? defaultBleScheduler;
  const brightness = options.brightness;
  const capabilities = capabilitiesForPalette(options.rolePalette);
  const assembler = new WledBleFrameAssembler();
  let unsubscribe: (() => void) | undefined;
  let cancelFragmentTimeout: (() => void) | undefined;
  let pendingReject: ((error: unknown) => void) | undefined;
  let responseListener: ((payload: unknown) => void) | undefined;
  const runtime = new BleSessionRuntime(
    {
      deviceId: transport.deviceId,
      deviceName: transport.deviceName,
      maxWriteBytes: transport.maxWriteBytes,
      getCharacteristic: (target, signal) => transport.getCharacteristic(target, signal),
      onDisconnect: (listener) => transport.onDisconnect(listener),
      async disconnect() {
        try {
          try {
            cancelFragmentTimeout?.();
          } finally {
            unsubscribe?.();
          }
        } finally {
          assembler.reset();
          await transport.disconnect();
        }
      },
    },
    scheduler,
  );
  const abortOpen = () => {
    void runtime.disconnect().catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortOpen, { once: true });
  if (options.signal?.aborted) abortOpen();
  const fail = (error: unknown) => {
    pendingReject?.(error);
    void runtime.disconnect(error).catch(() => undefined);
  };
  try {
    throwIfAborted(runtime.signal);
    if (!Number.isSafeInteger(transport.maxWriteBytes) || transport.maxWriteBytes < 1) {
      throw new BleError('invalid-input', 'maxWriteBytes must be a positive integer');
    }
    const payloadBytes = Math.min(512, transport.maxWriteBytes);
    const firmware = Object.freeze({ ...parseCapabilities(await loadCapabilities(runtime.signal, scheduler)) });
    throwIfAborted(runtime.signal);
    if (options.expectedControllerId !== undefined && firmware.controllerId !== options.expectedControllerId) {
      throw new WledBleProtocolError('controller-id-mismatch');
    }
    const requestCharacteristic = await bounded(
      transport.getCharacteristic(
        {
          serviceUuid: WLED_BLE_SERVICE_UUID,
          characteristicUuid: WLED_BLE_REQUEST_UUID,
        },
        runtime.signal,
      ),
      runtime.signal,
      10_000,
      scheduler,
    );
    const responseCharacteristic = await bounded(
      transport.getCharacteristic(
        {
          serviceUuid: WLED_BLE_SERVICE_UUID,
          characteristicUuid: WLED_BLE_RESPONSE_UUID,
        },
        runtime.signal,
      ),
      runtime.signal,
      10_000,
      scheduler,
    );
    if (!requestCharacteristic.writeWithResponse || !responseCharacteristic.subscribe) {
      throw new WledBleProtocolError('unsupported-characteristics');
    }
    const subscribing = responseCharacteristic.subscribe(
      (bytes) => {
        if (runtime.signal.aborted) return;
        try {
          const payload = assembler.push(bytes, scheduler.now());
          cancelFragmentTimeout?.();
          cancelFragmentTimeout =
            payload === null
              ? scheduler.setTimeout(
                  () => fail(new WledBleProtocolError('fragment-timeout')),
                  WLED_BLE_FRAGMENT_TIMEOUT_MS,
                )
              : undefined;
          if (payload !== null) responseListener?.(payload);
        } catch (error) {
          fail(error);
        }
      },
      fail,
      runtime.signal,
    );
    // A subscription can finish after cancellation; tear that late listener down too.
    void subscribing.then(
      (remove) => {
        if (runtime.signal.aborted) {
          try {
            remove();
          } catch {
            /* The transport has already been disconnected. */
          }
        }
      },
      () => undefined,
    );
    unsubscribe = await bounded(subscribing, runtime.signal, 10_000, scheduler);
    throwIfAborted(runtime.signal);
    let requestCounter = 0;
    const prepare = (op: WledBleOperation, state?: Record<string, unknown>) => {
      const id = `b${++requestCounter}`;
      const payload = parseRequest(op === 'setState' ? { id, op, state } : { id, op }, firmware.ledCount);
      // Encoding here snapshots caller-owned state before it can wait in the queue.
      return { id, frame: encodeFrame(payload, firmware.maxMessageBytes) };
    };
    async function exchange(prepared: { id: string; frame: Uint8Array }, signal: AbortSignal): Promise<unknown> {
      const abort = () => fail(new WledBleProtocolError('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const response = new Promise<unknown>((resolve, reject) => {
        pendingReject = reject;
        responseListener = (payload) => {
          try {
            resolve(parseResponse(payload, prepared.id));
          } catch (error) {
            reject(error);
          }
        };
      });
      // Observe rejection before the first write; a controller can respond immediately.
      const completed = bounded(response, signal, 12_000, scheduler);
      void completed.catch(fail);
      try {
        for (const fragment of fragmentFrame(prepared.frame, payloadBytes)) {
          throwIfAborted(signal);
          await bounded(requestCharacteristic.write(fragment, 'with-response', signal), signal, 10_000, scheduler);
        }
        return await completed;
      } catch (error) {
        fail(error);
        throw error;
      } finally {
        signal.removeEventListener('abort', abort);
        pendingReject = undefined;
        responseListener = undefined;
        assembler.reset();
        cancelFragmentTimeout?.();
        cancelFragmentTimeout = undefined;
      }
    }
    function lighting(signal: AbortSignal) {
      return createWledCommandDriver(
        async (_target, path, _requestSignal, command) =>
          exchange(prepare(command ? 'setState' : path === 'info' ? 'getInfo' : 'getState', command), signal),
        { autoOff: false },
      );
    }
    return {
      capabilities,
      controllerCapabilities: firmware,
      request(op, state, signal) {
        try {
          const prepared = prepare(op, state);
          return runtime.run((activeSignal) => exchange(prepared, activeSignal), signal);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      show(lights: readonly BoardLight[], signal?: AbortSignal) {
        try {
          const snapshot = snapshotLights(lights, capabilities, firmware.ledCount - 1, options.rolePalette);
          const pixels = snapshot.map((light) => ({
            index: light.index,
            color: resolveRgb(light, options.rolePalette),
          }));
          return runtime.run(
            (activeSignal) =>
              // Re-read segments on every show: another WLED client may have changed them.
              lighting(activeSignal)
                .createPreview('', { brightness })
                .show(
                  pixels.map((pixel) => pixel.index),
                  pixels,
                ),
            signal,
          );
        } catch (error) {
          return Promise.reject(error);
        }
      },
      clear: (signal) => runtime.run((activeSignal) => lighting(activeSignal).turnOff('', activeSignal), signal),
      disconnect: () => runtime.disconnect(),
      onDisconnect: (listener) => runtime.onDisconnect(listener),
    };
  } catch (error) {
    await runtime.disconnect().catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortOpen);
  }
}

/** Takes ownership of a transport whose capabilities were already probed by the caller. */
export function openWledBleSession(
  transport: BleTransport,
  controllerCapabilities: WledBleCapabilities,
  options: WledBleSessionOptions = {},
): Promise<WledBleSession> {
  const firmware = { ...controllerCapabilities };
  let configuration: WledBleSessionOptions;
  try {
    configuration = snapshotOptions(options);
  } catch (error) {
    return transport
      .disconnect()
      .catch(() => undefined)
      .then(() => {
        throw error;
      });
  }
  return initializeWledBleSession(transport, async () => firmware, configuration);
}

export function createWledBleProtocol(
  options: Omit<WledBleSessionOptions, keyof BleOpenOptions> = {},
): BoardBleProtocol<WledBleSession> {
  const configuration = snapshotOptions(options);
  return {
    id: 'wled-ble',
    discovery: { serviceUuids: [WLED_BLE_SERVICE_UUID] },
    open(transport, openOptions = {}) {
      // The same runtime observes disconnects before the first probe, during
      // subscription setup, and for the entire returned session lifetime.
      return initializeWledBleSession(
        transport,
        (signal, scheduler) => readWledBleCapabilities(transport, signal, scheduler),
        { ...configuration, ...openOptions },
      );
    },
  };
}
