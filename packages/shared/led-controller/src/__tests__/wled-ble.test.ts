import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLedPreviewSession } from '../preview';
import { LedControllerError } from '../types';
import { bleControllerTarget, createWledBleDriver, normalizeBleControllerTarget, type BleLedLink } from '../wled-ble';
import {
  bleLedRunsPerFrame,
  chunkBleLedRuns,
  decodeBleLedInfo,
  decodeBleLedStatus,
  encodeAutoOff,
  encodeBleLedInfo,
  encodeBleLedStatus,
  encodeLightAll,
  encodeOff,
  encodePreviewBegin,
  encodeSetPixels,
  encodeWake,
  toBleLedRuns,
} from '../wled-ble-protocol';

const hex = (bytes: Uint8Array) => [...bytes].map((value) => value.toString(16).padStart(2, '0')).join(' ');
const bytes = (text: string) => Uint8Array.from(text.split(' ').map((pair) => Number.parseInt(pair, 16)));

/** The test-vector table in docs/spray-wall-led-ble.md, byte for byte. */
describe('protocol test vectors', () => {
  it.each([
    ['LIGHT_ALL, brightness 64, auto-off 30', encodeLightAll(1, 64, 30), '01 10 01 40 1e'],
    ['OFF', encodeOff(2), '01 11 02'],
    ['PREVIEW_BEGIN, brightness 128', encodePreviewBegin(3, 128), '01 12 03 80'],
    [
      'SET_PIXELS, LEDs 10–11 red, LED 20 green',
      encodeSetPixels(4, [
        { start: 10, count: 2, color: [255, 0, 0] },
        { start: 20, count: 1, color: [0, 255, 0] },
      ]),
      '01 13 04 0a 00 02 ff 00 00 14 00 01 00 ff 00',
    ],
    ['SET_PIXELS, LED 300 blue', encodeSetPixels(5, [{ start: 300, count: 1, color: [0, 0, 255] }]), '01 13 05 2c 01 01 00 00 ff'],
    ['AUTO_OFF, 15 minutes', encodeAutoOff(6, 15), '01 14 06 0f'],
    ['WAKE, brightness 64', encodeWake(7, 64), '01 15 07 40'],
    ['status OK for sequence 4', encodeBleLedStatus({ sequence: 4, result: 0 }), '01 04 00 00'],
    ['status out of range for sequence 5', encodeBleLedStatus({ sequence: 5, result: 3 }), '01 05 03 00'],
  ])('%s', (_name, frame, expected) => {
    expect(hex(frame)).toBe(expected);
  });

  it('encodes and decodes the info characteristic', () => {
    const info = { lit: true, ledCount: 150, maxFrameBytes: 512, name: 'WLED', version: '0.15.3' };
    const encoded = encodeBleLedInfo(info);
    expect(hex(encoded)).toBe('01 01 96 00 00 02 04 57 4c 45 44 06 30 2e 31 35 2e 33');
    expect(decodeBleLedInfo(encoded)).toEqual({ protocolVersion: 1, ...info });
    expect(decodeBleLedInfo(encodeBleLedInfo({ ...info, name: 'Pared ñ' })).name).toBe('Pared ñ');
  });

  it('refuses truncated or non-UTF-8 info, and reads only the version of a newer one', () => {
    expect(() => decodeBleLedInfo(bytes('01 01 96 00'))).toThrow();
    expect(() => decodeBleLedInfo(bytes('01 01 96 00 00 02 05 57 4c'))).toThrow();
    expect(() => decodeBleLedInfo(bytes('01 01 96 00 00 02 01 ff 00'))).toThrow();
    expect(decodeBleLedInfo(bytes('02 00 00 00 00 00 ff')).protocolVersion).toBe(2);
    expect(decodeBleLedStatus(bytes('01 09 00 00'))).toEqual({ protocolVersion: 1, sequence: 9, result: 0 });
  });

  it('coalesces neighbouring LEDs of one colour into runs', () => {
    const runs = toBleLedRuns(
      new Map<number, [number, number, number]>([
        [11, [255, 0, 0]],
        [10, [255, 0, 0]],
        [12, [0, 0, 255]],
        [40, [255, 0, 0]],
      ]),
    );
    expect(runs).toEqual([
      { start: 10, count: 2, color: [255, 0, 0] },
      { start: 12, count: 1, color: [0, 0, 255] },
      { start: 40, count: 1, color: [255, 0, 0] },
    ]);
  });

  it('sizes frames to the MTU and the controller buffer', () => {
    // Default ATT MTU 23: 20 bytes per write, 3 of header, 2 runs.
    expect(bleLedRunsPerFrame(23, 512)).toBe(2);
    expect(bleLedRunsPerFrame(247, 512)).toBe(40);
    expect(bleLedRunsPerFrame(517, 512)).toBe(84);
    expect(bleLedRunsPerFrame(517, 128)).toBe(20);
    expect(chunkBleLedRuns([1, 2, 3, 4, 5].map((start) => ({ start, count: 1, color: [0, 0, 0] as const })), 2)).toHaveLength(3);
  });
});

type FakeOptions = { mtu?: number; ledCount?: number; lit?: boolean; protocolVersion?: number; silent?: boolean };

/** A controller that answers each frame with the status the firmware would send. */
function fakeController(options: FakeOptions = {}) {
  const writes: string[] = [];
  const listeners = new Set<(frame: Uint8Array) => void>();
  const state = { lit: options.lit ?? false, ledCount: options.ledCount ?? 150 };
  const link: BleLedLink = {
    mtu: options.mtu ?? 247,
    readInfo: vi.fn(async () => {
      const info = encodeBleLedInfo({ ...state, maxFrameBytes: 512, name: 'Spraywall', version: '0.15.3' });
      if (options.protocolVersion !== undefined) info[0] = options.protocolVersion;
      return info;
    }),
    writeControl: vi.fn(async (frame: Uint8Array) => {
      writes.push(hex(frame));
      if (options.silent) return;
      const opcode = frame[1];
      if (opcode === 0x10 || opcode === 0x12 || opcode === 0x15) state.lit = true;
      if (opcode === 0x11) state.lit = false;
      let result = 0;
      if (opcode === 0x13) {
        for (let offset = 3; offset < frame.length; offset += 6) {
          if (frame[offset] + (frame[offset + 1] << 8) + frame[offset + 2] > state.ledCount) result = 3;
        }
      }
      const status = encodeBleLedStatus({ sequence: frame[2], result });
      queueMicrotask(() => listeners.forEach((listener) => listener(status)));
    }),
    onStatus(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const connect = vi.fn(async () => link);
  return { link, writes, state, connect, transport: { connect } };
}

/** Drop the sequence byte: it depends on how many frames the driver sent before. */
const withoutSequence = (frame: string) => frame.split(' ').filter((_byte, index) => index !== 2).join(' ');

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

  it('probes over the injected transport', async () => {
    const fake = fakeController();
    const driver = createWledBleDriver({ transport: () => fake.transport });
    await expect(driver.probe(target)).resolves.toEqual({ name: 'Spraywall', version: '0.15.3', ledCount: 150 });
    expect(fake.connect).toHaveBeenCalledWith('AA:BB:CC:DD:EE:FF', undefined);
    expect(fake.writes).toEqual([]);
  });

  it('is unavailable until the app registers a transport', async () => {
    const driver = createWledBleDriver({ transport: () => null });
    await expect(driver.probe(target)).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('refuses a controller on another protocol version before writing anything', async () => {
    const fake = fakeController({ protocolVersion: 2 });
    const driver = createWledBleDriver({ transport: () => fake.transport });
    await expect(driver.probe(target)).rejects.toMatchObject({ code: 'unsupported-version' });
    await expect(driver.lightAll(target, undefined, {})).rejects.toMatchObject({ code: 'unsupported-version' });
    expect(fake.writes).toEqual([]);
  });

  it('lights all and turns off with the wall brightness and auto-off', async () => {
    const fake = fakeController();
    const driver = createWledBleDriver({ transport: () => fake.transport });
    await driver.lightAll(target, undefined, { brightness: 64, autoOffMinutes: 30 });
    await driver.turnOff(target);
    expect(fake.writes.map(withoutSequence)).toEqual(['01 10 40 1e', '01 11']);
  });

  it('times out when the controller never answers a frame', async () => {
    vi.useFakeTimers();
    const fake = fakeController({ silent: true });
    const driver = createWledBleDriver({ transport: () => fake.transport, timeoutMs: 500 });
    const result = expect(driver.turnOff(target)).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(500);
    await result;
  });

  it('cancels with the caller signal', async () => {
    const fake = fakeController({ silent: true });
    const driver = createWledBleDriver({ transport: () => fake.transport });
    const controller = new AbortController();
    const result = driver.turnOff(target, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('reports a failed write', async () => {
    const fake = fakeController();
    vi.mocked(fake.link.writeControl).mockRejectedValueOnce(new Error('GATT error'));
    const driver = createWledBleDriver({ transport: () => fake.transport });
    await expect(driver.turnOff(target)).rejects.toMatchObject({ code: 'command-failed' });
  });

  it('starts a preview black, then sends coalesced colours in MTU-sized chunks', async () => {
    const fake = fakeController({ mtu: 23 });
    const driver = createWledBleDriver({ transport: () => fake.transport });
    const preview = driver.createPreview(target, { brightness: 128 });
    await preview.show(
      [10, 11, 20, 30],
      [
        { index: 10, color: [255, 0, 0] },
        { index: 11, color: [255, 0, 0] },
        { index: 20, color: [0, 255, 0] },
      ],
    );
    expect(fake.writes.map(withoutSequence)).toEqual([
      '01 12 80',
      // 20-byte writes hold two runs: the first chunk, then the rest.
      '01 13 0a 00 02 ff 00 00 14 00 01 00 ff 00',
      '01 13 1e 00 01 ff ff ff',
    ]);
    fake.writes.length = 0;
    await preview.show([11], [{ index: 11, color: [0, 0, 255] }]);
    expect(fake.writes.map(withoutSequence)).toEqual([
      '01 13 0a 00 01 00 00 00 0b 00 01 00 00 ff',
      '01 13 14 00 01 00 00 00 1e 00 01 00 00 00',
    ]);
  });

  it('wakes again when the strip was switched off, and restarts the auto-off after every write', async () => {
    const fake = fakeController();
    const driver = createWledBleDriver({ transport: () => fake.transport });
    const preview = driver.createPreview(target, { brightness: 64, autoOffMinutes: 15 });
    await preview.show([1]);
    await preview.show([2]);
    fake.state.lit = false;
    await preview.show([3]);
    expect(fake.writes.map(withoutSequence)).toEqual([
      '01 12 40',
      '01 13 01 00 01 ff ff ff',
      '01 14 0f',
      '01 15 40',
      '01 13 01 00 01 00 00 00 02 00 01 ff ff ff',
      '01 14 0f',
      '01 12 40',
      '01 13 03 00 01 ff ff ff',
      '01 14 0f',
    ]);
  });

  it('refuses LEDs past the cable before writing', async () => {
    const fake = fakeController({ ledCount: 10 });
    const driver = createWledBleDriver({ transport: () => fake.transport });
    await expect(driver.createPreview(target).show([10])).rejects.toMatchObject({ code: 'invalid-indices' });
    expect(fake.writes).toEqual([]);
  });

  it('runs through the shared preview lanes keyed on the Bluetooth target', async () => {
    const fake = fakeController();
    const driver = createWledBleDriver({ transport: () => fake.transport });
    const session = createLedPreviewSession(driver, target, { brightness: 64 });
    await expect(session.show([5])).resolves.toBe(true);
    await expect(session.close()).resolves.toBeUndefined();
    expect(fake.writes.map(withoutSequence)).toEqual(['01 12 40', '01 13 05 00 01 ff ff ff', '01 11']);
    expect(() => createLedPreviewSession(driver, 'http://wled.local')).toThrow(LedControllerError);
  });
});
