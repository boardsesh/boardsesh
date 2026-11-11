import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuroraBluetoothPacket, getAuroraV3LedPacket } from '@boardsesh/ble-protocol/aurora';
import { createLedPreviewSession } from '../preview';
import { LedControllerError } from '../types';
import { bleControllerTarget, createWledBleDriver, normalizeBleControllerTarget, type BleLedLink } from '../wled-ble';

const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(' ');

type FakeOptions = { mtu?: number; name?: string; silent?: boolean };

/** A controller that records what reached its UART write characteristic. */
function fakeController(options: FakeOptions = {}) {
  const chunks: Uint8Array[] = [];
  const link: BleLedLink = {
    mtu: options.mtu ?? 247,
    name: options.name ?? 'Boardsesh Spraywall 1A2B',
    write: (chunk) => {
      chunks.push(chunk);
      return options.silent ? new Promise<void>(() => undefined) : Promise.resolve();
    },
  };
  const connect = vi.fn(async () => link);
  /** Everything written, joined back into the packet the firmware reassembles. */
  const written = () => Uint8Array.from(chunks.flatMap((chunk) => [...chunk]));
  return { link, chunks, written, connect, transport: { connect } };
}

afterEach(() => vi.useRealTimers());

describe('Bluetooth WLED driver', () => {
  const target = bleControllerTarget('AA:BB:CC:DD:EE:FF');

  it('names targets and refuses anything else', () => {
    expect(target).toBe('ble:AA:BB:CC:DD:EE:FF');
    expect(normalizeBleControllerTarget(' ble:5E2C1A40-1234 ')).toBe('ble:5E2C1A40-1234');
    for (const bad of ['http://wled.local', 'ble:', 'ble:a b', 'ble:../x']) {
      expect(() => normalizeBleControllerTarget(bad)).toThrow(LedControllerError);
    }
  });

  it('probes by connecting, and writes nothing', async () => {
    const fake = fakeController();
    const driver = createWledBleDriver({ transport: () => fake.transport });
    await expect(driver.probe(target)).resolves.toEqual({
      name: 'Boardsesh Spraywall 1A2B',
      version: 'Aurora API v3',
      ledCount: 0,
    });
    expect(fake.connect).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', undefined);
    expect(fake.chunks).toEqual([]);
  });

  it('is unavailable until the app registers a transport, and waits for one that loads lazily', async () => {
    const driver = createWledBleDriver({ transport: () => null });
    await expect(driver.probe(target)).rejects.toMatchObject({ code: 'unavailable' });
    const failing = createWledBleDriver({ transport: () => Promise.reject(new Error('no native module')) });
    await expect(failing.probe(target)).rejects.toMatchObject({ code: 'unavailable' });
    const fake = fakeController();
    const lazy = createWledBleDriver({ transport: async () => fake.transport });
    await expect(lazy.probe(target)).resolves.toMatchObject({ name: 'Boardsesh Spraywall 1A2B' });
  });

  it('turns off with the empty Aurora packet a Kilter board clears with', async () => {
    const fake = fakeController();
    await createWledBleDriver({ transport: () => fake.transport }).turnOff(target);
    expect(hex(fake.written())).toBe('01 01 ab 02 54 03');
    expect(fake.written()).toEqual(getAuroraBluetoothPacket('', {}, 'kilter', 3).packet);
  });

  it('lights all as white Aurora v3 LEDs over the whole configured length', async () => {
    const fake = fakeController();
    await createWledBleDriver({ transport: () => fake.transport, lightAllLeds: 3 }).lightAll(target, undefined, {
      brightness: 10,
      autoOffMinutes: 30,
    });
    // Brightness and auto-off are the controller's own settings: not in the packet.
    expect(hex(fake.written())).toBe('01 0a ab 02 54 00 00 ff 01 00 ff 02 00 ff 03');
  });

  it('sends a preview as one Aurora v3 packet that replaces what was lit', async () => {
    const fake = fakeController();
    const preview = createWledBleDriver({ transport: () => fake.transport }).createPreview(target);
    await preview.show(
      [10, 11, 20, 30],
      [
        { index: 10, color: [255, 0, 0] },
        { index: 11, color: [255, 0, 0] },
        { index: 20, color: [0, 255, 0] },
      ],
    );
    expect(fake.written()).toEqual(
      getAuroraV3LedPacket([
        { position: 10, color: [255, 0, 0] },
        { position: 11, color: [255, 0, 0] },
        { position: 20, color: [0, 255, 0] },
        { position: 30, color: [255, 255, 255] },
      ]),
    );
    fake.chunks.length = 0;
    await preview.show([11], [{ index: 11, color: [0, 0, 255] }]);
    expect(hex(fake.written())).toBe('01 04 9d 02 54 0b 00 03 03');
  });

  it('splits a long packet into MTU-sized chunks without changing its bytes', async () => {
    const leds = Array.from({ length: 100 }, (_, index) => index);
    const small = fakeController({ mtu: 23 });
    await createWledBleDriver({ transport: () => small.transport }).createPreview(target).show(leds);
    const large = fakeController({ mtu: 247 });
    await createWledBleDriver({ transport: () => large.transport }).createPreview(target).show(leds);
    expect(small.chunks.every((chunk) => chunk.length <= 20)).toBe(true);
    expect(large.chunks.every((chunk) => chunk.length <= 244)).toBe(true);
    expect(large.chunks.length).toBeLessThan(small.chunks.length);
    expect(small.written()).toEqual(large.written());
  });

  it('times out a write the controller never acknowledges', async () => {
    vi.useFakeTimers();
    const fake = fakeController({ silent: true });
    const driver = createWledBleDriver({ transport: () => fake.transport, timeoutMs: 500 });
    const result = expect(driver.turnOff(target)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(500);
    await result;
  });

  it('cancels with the caller signal', async () => {
    const fake = fakeController({ silent: true });
    const controller = new AbortController();
    const result = createWledBleDriver({ transport: () => fake.transport }).turnOff(target, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports a failed write', async () => {
    const fake = fakeController();
    const failing: BleLedLink = { ...fake.link, write: () => Promise.reject(new Error('GATT error')) };
    const driver = createWledBleDriver({ transport: () => ({ connect: async () => failing }) });
    await expect(driver.turnOff(target)).rejects.toMatchObject({ code: 'command-failed' });
  });

  it('refuses LEDs past a 16-bit position before writing', async () => {
    const fake = fakeController();
    const preview = createWledBleDriver({ transport: () => fake.transport }).createPreview(target);
    await expect(preview.show([70000])).rejects.toMatchObject({ code: 'invalid-indices' });
    expect(fake.chunks).toEqual([]);
  });

  it('runs through the shared preview lanes keyed on the Bluetooth target', async () => {
    const fake = fakeController();
    const driver = createWledBleDriver({ transport: () => fake.transport });
    const session = createLedPreviewSession(driver, target, { brightness: 64 });
    await expect(session.show([5])).resolves.toBe(true);
    await expect(session.close()).resolves.toBeUndefined();
    expect(hex(fake.written())).toBe('01 04 a7 02 54 05 00 ff 03 01 01 ab 02 54 03');
    expect(() => createLedPreviewSession(driver, 'http://wled.local')).toThrow(LedControllerError);
  });
});
