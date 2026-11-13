import { describe, expect, it, vi } from 'vitest';
import type { WledBleConnection, WledBleOperation } from '@boardsesh/wled-ble-protocol';
import { createWledBleDriver } from '../wled-ble';
import { normalizeLedControllerTarget } from '../url';

const controllerId = 'wled-aabbccddeeff';
const target = `wled-ble:${controllerId}`;
const capabilities = {
  controllerId,
  protocolVersion: 1 as const,
  name: 'Garage',
  wledVersion: '16.0.1',
  ledCount: 1000,
  audio: true,
  maxMessageBytes: 8192,
};
function connection() {
  const request = vi.fn(async (op: WledBleOperation, _state?: Record<string, unknown>): Promise<unknown> => {
    if (op === 'getInfo') return { name: 'Garage', ver: '16.0.1', leds: { count: 1000 } };
    if (op === 'getState') return { on: true, bri: 64, seg: [{ id: 0 }, { id: 2 }] };
    return { success: true };
  });
  return { capabilities, request, disconnect: vi.fn(async () => {}) } satisfies WledBleConnection;
}

describe('WLED BLE driver', () => {
  it('probes without lighting writes, verifies identity, then releases its connection', async () => {
    const device = connection();
    const connect = vi.fn(async () => device);
    const result = await createWledBleDriver({ connect }).probe(target);
    expect(result).toEqual({ name: 'Garage', version: '16.0.1', ledCount: 1000 });
    expect(connect).toHaveBeenCalledWith(controllerId, undefined);
    expect(device.request.mock.calls.map(([op]) => op)).toEqual(['getInfo']);
    expect(device.disconnect).toHaveBeenCalledOnce();
  });
  it('refuses another controller before any requests and closes it', async () => {
    const device = { ...connection(), capabilities: { ...capabilities, controllerId: 'wled-000000000000' } };
    await expect(createWledBleDriver({ connect: async () => device }).lightAll(target)).rejects.toMatchObject({
      code: 'not-wled',
    });
    expect(device.request).not.toHaveBeenCalled();
    expect(device.disconnect).toHaveBeenCalledOnce();
  });
  it('serializes complete operations across separate driver instances', async () => {
    const order: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let connections = 0;
    const connect = vi.fn(async () => {
      const ordinal = ++connections;
      order.push(`connect${ordinal}`);
      const device = connection();
      return {
        ...device,
        request: async (op: WledBleOperation, state?: Record<string, unknown>) => {
          if (ordinal === 1 && op === 'getInfo') await blocked;
          return device.request(op, state);
        },
        disconnect: async () => {
          order.push(`disconnect${ordinal}`);
        },
      };
    });
    const first = createWledBleDriver({ connect }).lightAll(target);
    const second = createWledBleDriver({ connect }).turnOff(target);
    await vi.waitFor(() => expect(connect).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['connect1', 'disconnect1', 'connect2', 'disconnect2']);
  });
  it('cancels a queued operation before connecting or applying', async () => {
    const device = connection();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const connect = vi.fn(async () => {
      await blocked;
      return device;
    });
    const driver = createWledBleDriver({ connect });
    const first = driver.probe(target);
    const abort = new AbortController();
    const second = driver.lightAll(target, abort.signal);
    const rejected = expect(second).rejects.toMatchObject({ code: 'cancelled' });
    abort.abort();
    release();
    await first;
    await rejected;
    expect(connect).toHaveBeenCalledTimes(1);
    expect(device.request.mock.calls.map(([op]) => op)).toEqual(['getInfo']);
  });
  it('does not replay failed writes on reconnect', async () => {
    const failed = connection();
    failed.request.mockRejectedValueOnce(new Error('disconnected'));
    const fresh = connection();
    const connect = vi.fn().mockResolvedValueOnce(failed).mockResolvedValueOnce(fresh);
    const driver = createWledBleDriver({ connect });
    await expect(driver.turnOff(target)).rejects.toThrow('disconnected');
    await driver.probe(target);
    expect(failed.request).toHaveBeenCalledTimes(1);
    expect(fresh.request.mock.calls.map(([op]) => op)).toEqual(['getInfo']);
    expect(failed.disconnect).toHaveBeenCalledOnce();
    expect(fresh.disconnect).toHaveBeenCalledOnce();
  });
  it('re-arms nightlight and clears old climbs on every short connection', async () => {
    const first = connection();
    const second = connection();
    const connect = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const preview = createWledBleDriver({ connect }).createPreview(target);
    await preview.show([999]);
    await preview.show([500]);
    for (const device of [first, second]) {
      const writes = device.request.mock.calls.filter(([op]) => op === 'setState').map(([, state]) => state);
      expect(writes[0]).toMatchObject({
        on: true,
        bri: 64,
        nl: { on: false },
        seg: [
          { id: 0, stop: 1000 },
          { id: 2, on: false },
        ],
      });
      expect(writes[1]).toMatchObject({ seg: [{ i: [0, 1000, '00000000', expect.any(Number), 'FFFFFFFF'] }] });
      expect(device.disconnect).toHaveBeenCalledOnce();
    }
  });
  it('rejects pixels outside configured count before lighting writes', async () => {
    const device = connection();
    const driver = createWledBleDriver({ connect: async () => device });
    await expect(driver.createPreview(target).show([1000])).rejects.toMatchObject({ code: 'invalid-indices' });
    expect(device.request.mock.calls.map(([op]) => op)).toEqual(['getInfo']);
  });
  it('normalizes stable BLE targets and rejects phone IDs and malformed targets', () => {
    expect(normalizeLedControllerTarget(target)).toBe(target);
    for (const invalid of ['wled-ble:phone-id', 'wled-ble:wled-AABBCCDDEEFF', `${target}/`, `${target}?token=x`]) {
      expect(() => normalizeLedControllerTarget(invalid)).toThrow('invalid-url');
    }
  });
});
