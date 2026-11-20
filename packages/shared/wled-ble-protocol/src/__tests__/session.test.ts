import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BleCharacteristic, BleTransport, BoardLight } from '@boardsesh/ble-core';
import {
  createWledBleProtocol,
  openWledBleSession,
  encodeFrame,
  encodeUtf8,
  fragmentFrame,
  WledBleFrameAssembler,
  WLED_BLE_CAPABILITIES_UUID,
  WLED_BLE_RESPONSE_UUID,
  type WledBleCapabilities,
  type WledBleRequest,
} from '../index';

const firmware: WledBleCapabilities = {
  controllerId: 'wled-aabbccddeeff',
  protocolVersion: 1,
  name: 'Wall',
  wledVersion: '16.0.1',
  ledCount: 16,
  audio: false,
  maxMessageBytes: 8192,
};

function fixture() {
  let notify: ((bytes: Uint8Array) => void) | undefined;
  let notifyError: ((error: unknown) => void) | undefined;
  let disconnectListener: (() => void) | undefined;
  const assembler = new WledBleFrameAssembler();
  const requests: WledBleRequest[] = [];
  const chunks: Uint8Array[] = [];
  let segments = [0, 2];
  let handleRequest: ((request: WledBleRequest) => void) | undefined;
  const unsubscribe = vi.fn();
  const disconnect = vi.fn(async () => {});
  const respond = (id: string, result: unknown) => {
    for (const fragment of fragmentFrame(encodeFrame({ id, result }), 20)) notify?.(fragment);
  };
  const requestCharacteristic: BleCharacteristic = {
    writeWithResponse: true,
    writeWithoutResponse: false,
    async write(bytes, mode) {
      expect(mode).toBe('with-response');
      chunks.push(bytes.slice());
      const request = assembler.push(bytes) as WledBleRequest | null;
      if (!request) return;
      requests.push(request);
      if (handleRequest) {
        handleRequest(request);
        return;
      }
      respond(
        request.id,
        request.op === 'getInfo'
          ? { name: 'Wall', ver: '16.0.1', leds: { count: 16 } }
          : request.op === 'getState'
            ? { on: true, seg: segments.map((id) => ({ id })) }
            : { success: true },
      );
    },
  };
  const responseCharacteristic: BleCharacteristic = {
    writeWithResponse: false,
    writeWithoutResponse: false,
    write: async () => {
      throw new Error('Response is read-only');
    },
    subscribe: vi.fn(async (listener, onError) => {
      notify = listener;
      notifyError = onError;
      return unsubscribe;
    }),
  };
  const transport: BleTransport = {
    deviceId: 'platform-device-id',
    maxWriteBytes: 20,
    async getCharacteristic(target) {
      if (target.characteristicUuid === WLED_BLE_CAPABILITIES_UUID)
        return {
          ...responseCharacteristic,
          read: async () => encodeUtf8(JSON.stringify(firmware)),
        };
      return target.characteristicUuid === WLED_BLE_RESPONSE_UUID ? responseCharacteristic : requestCharacteristic;
    },
    onDisconnect(listener) {
      disconnectListener = listener;
      return () => {
        disconnectListener = undefined;
      };
    },
    disconnect,
  };
  return {
    transport,
    requests,
    chunks,
    disconnect,
    unsubscribe,
    requestCharacteristic,
    responseCharacteristic,
    respond,
    notify: (bytes: Uint8Array) => notify?.(bytes),
    failNotifications: (error: unknown) => notifyError?.(error),
    drop: () => disconnectListener?.(),
    setHandler: (handler?: (request: WledBleRequest) => void) => {
      handleRequest = handler;
    },
    setSegments: (ids: number[]) => {
      segments = ids;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('portable WLED sessions', () => {
  it('probes without writes, then lights and clears through acknowledged fragments', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol({ expectedControllerId: firmware.controllerId }).open(radio.transport);
    expect(session.controllerCapabilities).toEqual(firmware);
    expect(radio.requests).toEqual([]);
    await session.show([{ index: 3, color: [255, 0, 32] }]);
    expect(radio.requests.map((request) => request.op)).toEqual(['getInfo', 'getState', 'setState', 'setState']);
    expect(radio.requests.at(-1)).toMatchObject({ state: { seg: [{ i: [0, 16, '00000000', 3, 'FF002000'] }] } });
    expect(radio.chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    await session.clear();
    expect(radio.requests.at(-1)).toMatchObject({ op: 'setState', state: { on: false } });
    await session.disconnect();
    expect(radio.disconnect).toHaveBeenCalledOnce();
    expect(radio.unsubscribe).toHaveBeenCalledOnce();
  });

  it('refuses a mismatched stable controller before subscribing or writing', async () => {
    const radio = fixture();
    await expect(
      createWledBleProtocol({ expectedControllerId: 'wled-000000000000' }).open(radio.transport),
    ).rejects.toMatchObject({ code: 'controller-id-mismatch' });
    expect(radio.requests).toEqual([]);
    expect(radio.responseCharacteristic.subscribe).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('respects an ATT payload maximum smaller than twenty bytes', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open({ ...radio.transport, maxWriteBytes: 7 });
    await session.request('getInfo');
    expect(radio.chunks.every((chunk) => chunk.length <= 7)).toBe(true);
    await session.disconnect();
  });

  it.each([0, -1, 1.5, Number.NaN])('refuses invalid payload maximum %s before probing', async (maxWriteBytes) => {
    const radio = fixture();
    await expect(createWledBleProtocol().open({ ...radio.transport, maxWriteBytes })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    expect(radio.requests).toHaveLength(0);
    expect(radio.responseCharacteristic.subscribe).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('observes disconnects during the initial capability read and closes immediately', async () => {
    const radio = fixture();
    let finishRead!: (bytes: Uint8Array) => void;
    const originalGet = radio.transport.getCharacteristic;
    const read = vi.fn(
      () =>
        new Promise<Uint8Array>((resolve) => {
          finishRead = resolve;
        }),
    );
    radio.transport.getCharacteristic = async (target, signal) => {
      const characteristic = await originalGet(target, signal);
      return target.characteristicUuid === WLED_BLE_CAPABILITIES_UUID ? { ...characteristic, read } : characteristic;
    };
    const opening = createWledBleProtocol().open(radio.transport);
    const rejected = expect(opening).rejects.toMatchObject({ code: 'disconnected' });
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    radio.drop();
    await rejected;
    finishRead(encodeUtf8(JSON.stringify(firmware)));
    await Promise.resolve();
    expect(radio.responseCharacteristic.subscribe).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('snapshots protocol options and advertises only configured roles', async () => {
    const radio = fixture();
    const color: [number, number, number] = [0, 255, 0];
    const options = { brightness: 80, rolePalette: { start: color } };
    const protocol = createWledBleProtocol(options);
    options.brightness = 200;
    color[0] = 255;
    const session = await protocol.open(radio.transport);
    expect(session.capabilities.roles).toEqual(['start']);
    await session.show([{ index: 1, role: 'start' }]);
    expect(radio.requests.at(-2)).toMatchObject({ state: { bri: 80 } });
    expect(radio.requests.at(-1)).toMatchObject({ state: { seg: [{ i: [0, 16, '00000000', 1, '00FF0000'] }] } });
    await session.disconnect();
  });

  it('snapshots options supplied directly to open', async () => {
    const radio = fixture();
    const color: [number, number, number] = [0, 255, 0];
    const options = { rolePalette: { start: color } };
    const opening = openWledBleSession(radio.transport, firmware, options);
    color[1] = 0;
    const session = await opening;
    await session.show([{ index: 1, role: 'start' }]);
    expect(radio.requests.at(-1)).toMatchObject({ state: { seg: [{ i: [0, 16, '00000000', 1, '00FF0000'] }] } });
    await session.disconnect();
  });

  it('disconnects the radio even when unsubscribing throws', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.unsubscribe.mockImplementation(() => {
      throw new Error('unsubscribe failed');
    });
    await expect(session.disconnect()).rejects.toThrow('unsubscribe failed');
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('validates show and raw state input before any request write', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    await expect(session.show([])).rejects.toBeDefined();
    await expect(session.show([{ index: 16, color: [255, 0, 0] }])).rejects.toBeDefined();
    await expect(session.show([{ index: 2, role: 'start' }])).rejects.toBeDefined();
    await expect(session.request('setState', { ps: 4 })).rejects.toMatchObject({ code: 'disallowed-state' });
    expect(radio.requests).toEqual([]);
    await session.disconnect();
  });

  it('serializes raw requests with complete lighting operations and snapshots inputs', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.setHandler(() => {});
    const first = session.request('getInfo');
    const color: [number, number, number] = [12, 34, 56];
    const lights: BoardLight[] = [{ index: 4, color }];
    const second = session.show(lights);
    color[0] = 255;
    lights.length = 0;
    await vi.waitFor(() => expect(radio.requests).toHaveLength(1));
    radio.setHandler();
    radio.respond(radio.requests[0].id, { name: 'Wall', ver: '16.0.1', leds: { count: 16 } });
    await Promise.all([first, second]);
    expect(radio.requests.at(-1)).toMatchObject({ state: { seg: [{ i: [0, 16, '00000000', 4, '0C223800'] }] } });
    await session.disconnect();
  });

  it('re-reads external segment changes before each show on a persistent connection', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol({ rolePalette: { start: [0, 255, 0] } }).open(radio.transport);
    await session.show([{ index: 1, role: 'start' }]);
    radio.setSegments([0, 7]);
    await session.show([{ index: 5, role: 'start' }]);
    expect(radio.requests.at(-2)).toMatchObject({ state: { seg: [{ id: 0 }, { id: 7, on: false }] } });
    expect(radio.requests.at(-1)).toMatchObject({ state: { seg: [{ i: [0, 16, '00000000', 5, '00FF0000'] }] } });
    await session.disconnect();
  });

  it('rejects mismatched response IDs and closes without replay', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.setHandler(() => radio.respond('wrong-id', {}));
    await expect(session.request('getInfo')).rejects.toMatchObject({ code: 'invalid-response' });
    await session.disconnect();
    expect(radio.requests).toHaveLength(1);
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('ends a partial response after five seconds without replaying the request', async () => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.setHandler((request) => radio.notify(encodeFrame({ id: request.id, result: {} }).slice(0, 2)));
    const request = session.request('getInfo');
    const rejected = expect(request).rejects.toMatchObject({ code: 'fragment-timeout' });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    await session.disconnect();
    expect(radio.requests).toHaveLength(1);
  });

  it('times out a silent controller after twelve seconds', async () => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.setHandler(() => {});
    const request = session.request('getInfo');
    const rejected = expect(request).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(12000);
    await rejected;
    await session.disconnect();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a stalled ATT write and never starts a second request', async () => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    const write = vi.spyOn(radio.requestCharacteristic, 'write').mockImplementation(() => new Promise(() => {}));
    const active = session.request('getInfo');
    const queued = session.clear();
    const activeFailed = expect(active).rejects.toMatchObject({ code: 'timeout' });
    const queuedFailed = expect(queued).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([activeFailed, queuedFailed]);
    await session.disconnect();
    expect(write).toHaveBeenCalledOnce();
  });

  it('removes a subscription that finishes after open was cancelled', async () => {
    const radio = fixture();
    let finishSubscription!: (remove: () => void) => void;
    radio.responseCharacteristic.subscribe = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          finishSubscription = resolve;
        }),
    );
    const abort = new AbortController();
    const opening = createWledBleProtocol().open(radio.transport, { signal: abort.signal });
    const rejected = expect(opening).rejects.toBeDefined();
    await vi.waitFor(() => expect(radio.responseCharacteristic.subscribe).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    finishSubscription(radio.unsubscribe);
    await vi.waitFor(() => expect(radio.unsubscribe).toHaveBeenCalledOnce());
    expect(radio.disconnect).toHaveBeenCalledOnce();
    expect(radio.requests).toHaveLength(0);
  });

  it('contains teardown failures from a late subscription', async () => {
    const radio = fixture();
    let finishSubscription!: (remove: () => void) => void;
    radio.responseCharacteristic.subscribe = vi.fn(
      () =>
        new Promise<() => void>((resolve) => {
          finishSubscription = resolve;
        }),
    );
    const abort = new AbortController();
    const opening = createWledBleProtocol().open(radio.transport, { signal: abort.signal });
    const rejected = expect(opening).rejects.toBeDefined();
    await vi.waitFor(() => expect(radio.responseCharacteristic.subscribe).toHaveBeenCalledOnce());
    abort.abort();
    await rejected;
    const remove = vi.fn(() => {
      throw new Error('late removal failed');
    });
    finishSubscription(remove);
    await vi.waitFor(() => expect(remove).toHaveBeenCalledOnce());
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects queued work on disconnect and tears subscriptions down once', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.setHandler(() => {});
    const active = session.request('getInfo');
    const queued = session.clear();
    const activeRejected = expect(active).rejects.toBeDefined();
    const queuedRejected = expect(queued).rejects.toBeDefined();
    await vi.waitFor(() => expect(radio.requests).toHaveLength(1));
    await Promise.all([session.disconnect(), session.disconnect()]);
    await Promise.all([activeRejected, queuedRejected]);
    expect(radio.requests).toHaveLength(1);
    expect(radio.unsubscribe).toHaveBeenCalledOnce();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects pending requests on notification failure', async () => {
    const radio = fixture();
    const session = await createWledBleProtocol().open(radio.transport);
    radio.setHandler(() => {});
    const pending = session.request('getInfo');
    const failed = expect(pending).rejects.toThrow('notification lost');
    await vi.waitFor(() => expect(radio.requests).toHaveLength(1));
    radio.failNotifications(new Error('notification lost'));
    await failed;
    await session.disconnect();
  });
});
