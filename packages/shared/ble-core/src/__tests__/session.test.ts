import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BleError,
  BleSessionRuntime,
  bounded,
  connectBoard,
  createWriteSession,
  snapshotLights,
  writeChunks,
  type BleCharacteristic,
  type BleTransport,
  type BoardLight,
} from '../index';

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const characteristic: BleCharacteristic = {
    writeWithResponse: true,
    writeWithoutResponse: true,
    write: vi.fn(async () => {}),
  };
  let dropped: (error?: unknown) => void = () => {};
  const unsubscribe = vi.fn();
  const transport: BleTransport = {
    deviceId: 'selected-device',
    maxWriteBytes: 20,
    getCharacteristic: vi.fn(async () => characteristic),
    onDisconnect: (listener) => {
      dropped = listener;
      return unsubscribe;
    },
    disconnect: vi.fn(async () => {}),
  };
  return { characteristic, transport, unsubscribe, drop: (error?: unknown) => dropped(error) };
}

afterEach(() => vi.useRealTimers());

describe('connection session ownership', () => {
  it('serializes logical operations and recovers after an ordinary operation error', async () => {
    const { transport } = fixture();
    const runtime = new BleSessionRuntime(transport);
    const gate = deferred<void>();
    const calls: number[] = [];
    const first = runtime.run(async () => {
      calls.push(1);
      await gate.promise;
      throw new Error('failed');
    });
    const rejected = expect(first).rejects.toThrow('failed');
    const second = runtime.run(async () => {
      calls.push(2);
    });
    await vi.waitFor(() => expect(calls).toEqual([1]));
    gate.resolve();
    await rejected;
    await second;
    expect(calls).toEqual([1, 2]);
  });

  it('does not overlap a platform operation that ignores caller cancellation', async () => {
    const { transport } = fixture();
    const runtime = new BleSessionRuntime(transport);
    const gate = deferred<void>();
    const controller = new AbortController();
    const first = runtime.run(() => gate.promise, controller.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' });
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    await rejected;
    const next = vi.fn(async () => {});
    const second = runtime.run(next);
    await Promise.resolve();
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
    gate.resolve();
    await second;
    expect(next).toHaveBeenCalledOnce();
  });

  it('invalidates queued operations immediately and waits for radio cleanup only once', async () => {
    const { transport, unsubscribe } = fixture();
    const cleanup = deferred<void>();
    vi.mocked(transport.disconnect).mockImplementation(() => cleanup.promise);
    const runtime = new BleSessionRuntime(transport);
    const first = runtime.run(() => new Promise<void>(() => {}));
    const queued = vi.fn(async () => {});
    const second = runtime.run(queued);
    const failures = Promise.all([
      expect(first).rejects.toMatchObject({ code: 'disconnected' }),
      expect(second).rejects.toMatchObject({ code: 'disconnected' }),
    ]);
    const listener = vi.fn();
    runtime.onDisconnect(listener);
    const closing = runtime.disconnect();
    expect(runtime.disconnect()).toBe(closing);
    await failures;
    expect(queued).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(transport.disconnect).toHaveBeenCalledOnce();
    cleanup.resolve();
    await closing;
  });

  it('retains the specific cause when a session fails', async () => {
    const { transport, drop } = fixture();
    const runtime = new BleSessionRuntime(transport);
    const pending = runtime.run(() => new Promise<void>(() => {}));
    const error = new BleError('timeout');
    const rejected = expect(pending).rejects.toBe(error);
    drop(error);
    await rejected;
    await runtime.disconnect();
  });

  it('closes a late connection returned after cancellation', async () => {
    const { transport } = fixture();
    const controller = new AbortController();
    const connecting = deferred<BleTransport>();
    const open = vi.fn();
    const pending = connectBoard(
      { id: 'test', discovery: { serviceUuids: [] }, open },
      { connect: () => connecting.promise },
      'selected-device',
      { signal: controller.signal },
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    connecting.resolve(transport);
    await rejected;
    expect(transport.disconnect).toHaveBeenCalledOnce();
    expect(open).not.toHaveBeenCalled();
  });
});

describe('wire submission', () => {
  const capabilities = { rgb: true, roles: ['start' as const], readback: false };

  it('snapshots RGB input before joining the queue', async () => {
    const { transport, characteristic } = fixture();
    const gate = deferred<void>();
    vi.mocked(characteristic.write).mockImplementationOnce(() => gate.promise);
    const session = createWriteSession(transport, {
      capabilities,
      characteristic,
      encode: (lights) => Uint8Array.of(lights[0].color![0]),
      clear: () => Uint8Array.of(0),
      writeOptions: { chunkSize: 20, mode: 'with-response' },
    });
    const first = session.clear();
    const color: [number, number, number] = [12, 0, 0];
    const lights: BoardLight[] = [{ index: 0, color }];
    const second = session.show(lights);
    color[0] = 99;
    lights.length = 0;
    gate.resolve();
    await Promise.all([first, second]);
    expect(vi.mocked(characteristic.write).mock.calls.map(([bytes]) => [...bytes])).toEqual([[0], [12]]);
  });

  it('refuses an accidental empty show and permits explicit clear', async () => {
    const { transport, characteristic } = fixture();
    const session = createWriteSession(transport, {
      capabilities,
      characteristic,
      encode: () => Uint8Array.of(1),
      clear: () => Uint8Array.of(0),
      writeOptions: { chunkSize: 20, mode: 'with-response' },
    });
    await expect(session.show([])).rejects.toMatchObject({ code: 'invalid-input' });
    expect(characteristic.write).not.toHaveBeenCalled();
    await session.clear();
    expect(characteristic.write).toHaveBeenCalledOnce();
  });

  it('rejects unsupported roles, RGB channels, and addresses before writing', () => {
    expect(() => snapshotLights([{ index: 0, role: 'foot' }], capabilities)).toThrow('Unsupported');
    expect(() => snapshotLights([{ index: 0, color: [256, 0, 0] }], capabilities)).toThrow('RGB');
    expect(() => snapshotLights([{ index: -1, color: [0, 0, 0] }], capabilities)).toThrow('index');
    expect(() => snapshotLights(new Array<BoardLight>(1), capabilities)).toThrow('index');
    const sparseColor: [number, number, number] = [255, 0, 0];
    Reflect.deleteProperty(sparseColor, 1);
    expect(() => snapshotLights([{ index: 0, color: sparseColor }], capabilities)).toThrow('RGB');
  });

  it('preserves a rejected write even when the rejection has no reason', async () => {
    const { characteristic } = fixture();
    vi.mocked(characteristic.write).mockRejectedValueOnce(undefined);
    await expect(
      writeChunks(characteristic, new Uint8Array(25), { chunkSize: 20, mode: 'with-response', writeTimeoutMs: 10 }),
    ).rejects.toBeUndefined();
    expect(characteristic.write).toHaveBeenCalledOnce();
  });

  it('unsubscribes when a transport synchronously replays a disconnect during registration', async () => {
    const { transport } = fixture();
    const cleanup = vi.fn();
    transport.onDisconnect = (listener) => {
      listener();
      return cleanup;
    };
    const runtime = new BleSessionRuntime(transport);
    await runtime.disconnect();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it('chunks and paces raw ATT writes with an injected clock', async () => {
    vi.useFakeTimers();
    const { characteristic } = fixture();
    const pending = writeChunks(
      characteristic,
      Uint8Array.from({ length: 45 }, (_, index) => index),
      { chunkSize: 20, mode: 'with-response', delayMs: 5 },
    );
    expect(characteristic.write).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5);
    expect(characteristic.write).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5);
    await pending;
    expect(vi.mocked(characteristic.write).mock.calls.map(([bytes]) => bytes.length)).toEqual([20, 20, 5]);
  });

  it('cancels a pacing timer without sending the next chunk', async () => {
    vi.useFakeTimers();
    const { characteristic } = fixture();
    const controller = new AbortController();
    const pending = writeChunks(
      characteristic,
      new Uint8Array(25),
      { chunkSize: 20, mode: 'with-response', delayMs: 5 },
      controller.signal,
    );
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    await vi.runAllTimersAsync();
    expect(characteristic.write).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the session after a timed-out partial frame and preserves the timeout', async () => {
    vi.useFakeTimers();
    const { transport, characteristic } = fixture();
    vi.mocked(characteristic.write).mockReturnValue(new Promise<void>(() => {}));
    const session = createWriteSession(transport, {
      capabilities,
      characteristic,
      encode: () => Uint8Array.of(1),
      clear: () => Uint8Array.of(0),
      writeOptions: { chunkSize: 20, mode: 'with-response', writeTimeoutMs: 10 },
    });
    const pending = expect(session.clear()).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    expect(transport.disconnect).toHaveBeenCalledOnce();
    await expect(session.clear()).rejects.toMatchObject({ code: 'disconnected' });
  });

  it('consumes late native failures after a deadline and removes its timer', async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const pending = expect(bounded(gate.promise, new AbortController().signal, 10)).rejects.toMatchObject({
      code: 'timeout',
    });
    await vi.advanceTimersByTimeAsync(10);
    await pending;
    gate.reject(new Error('late native failure'));
    await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
  });
});
