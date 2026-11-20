import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BleCharacteristic, BleTransport, BoardLight } from '@boardsesh/ble-core';
import { createAuroraProtocol, encodeAuroraClear, encodeAuroraEntries, encodeAuroraLights } from '../index';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function fakeTransport(name = 'Tension Board#123@3', maxWriteBytes = 244) {
  const writes: { bytes: Uint8Array; mode: string; at: number }[] = [];
  const characteristic: BleCharacteristic = {
    writeWithResponse: true,
    writeWithoutResponse: true,
    write: vi.fn(async (bytes, mode) => {
      writes.push({ bytes: new Uint8Array(bytes), mode, at: Date.now() });
    }),
  };
  const transport: BleTransport = {
    deviceId: 'platform-device',
    deviceName: name,
    maxWriteBytes,
    getCharacteristic: vi.fn(async () => characteristic),
    onDisconnect: vi.fn(() => () => {}),
    disconnect: vi.fn(async () => {}),
  };
  return { transport, characteristic, writes };
}

afterEach(() => vi.useRealTimers());

describe('portable Aurora codecs', () => {
  it('matches the specification v3 single-green-LED bytes', () => {
    const encoded = encodeAuroraLights([{ index: 42, color: [0, 255, 0] }]);
    expect(toHex(encoded.packet)).toBe('01046502542a001c03');
  });

  it('matches the corrected specification v2 three-LED bytes', () => {
    const encoded = encodeAuroraLights(
      [
        { index: 10, color: [0, 255, 0] },
        { index: 256, color: [0, 0, 255] },
        { index: 500, color: [255, 0, 0] },
      ],
      { apiLevel: 2 },
    );
    expect(toHex(encoded.packet)).toBe('0107b302500a30000df4c103');
  });

  it('matches the independently validated Kilter 12x12 physical addresses/colors', () => {
    const encoded = encodeAuroraLights([
      { index: 68, color: [255, 0, 255] },
      { index: 476, color: [255, 0, 255] },
      { index: 0, color: [255, 170, 0] },
      { index: 33, color: [255, 170, 0] },
    ]);
    expect(toHex(encoded.packet)).toBe('010dbb02544400e3dc01e30000f42100f403');
  });

  it('splits 85 v3 LEDs at complete record boundaries', () => {
    const encoded = encodeAuroraLights(
      Array.from({ length: 85 }, (_, index) => ({ index, color: [0, 255, 0] as const })),
    );
    expect(encoded.packet[1]).toBe(253);
    expect(encoded.packet[4]).toBe(82);
    expect(encoded.packet[258 + 1]).toBe(4);
    expect(encoded.packet[258 + 4]).toBe(83);
    expect(encoded.ledsWritten).toBe(85);
  });

  it('keeps a deliberate clear distinct from an empty or skipped compatibility payload', () => {
    expect(toHex(encodeAuroraClear(3))).toBe('0101ab025403');
    expect(toHex(encodeAuroraClear(2))).toBe('0101af025003');
    expect(encodeAuroraEntries([]).packet).toHaveLength(0);
    expect(encodeAuroraEntries([{ position: 1024, color: '00ff00' }], { apiLevel: 2 })).toMatchObject({
      skippedPositionCount: 1,
      ledsWritten: 0,
      allLedsDark: false,
    });
    expect(() => encodeAuroraLights([])).toThrow();
    expect(() => encodeAuroraLights([{ index: 1024, color: [0, 255, 0] }], { apiLevel: 2 })).toThrow();
    expect(() => encodeAuroraLights([{ index: 0, color: [256, 0, 0] }])).toThrow();
  });
});

describe('Aurora connection sessions', () => {
  it('uses an explicit palette and snapshots it when the protocol is created', async () => {
    const palette = { start: [0, 255, 0] as [number, number, number] };
    const protocol = createAuroraProtocol({ rolePalette: palette });
    palette.start[1] = 0;
    const { transport, writes } = fakeTransport();
    const session = await protocol.open(transport);
    expect(session.capabilities.roles).toEqual(['start']);
    await session.show([{ index: 42, role: 'start' }]);
    expect(toHex(writes[0].bytes)).toBe('01046502542a001c03');
    await expect(session.show([{ index: 42, role: 'finish' }])).rejects.toThrow();
    expect(writes).toHaveLength(1);
    await session.disconnect();
  });

  it('serializes complete messages, snapshots queued input and caps chunks at 244', async () => {
    vi.useFakeTimers();
    const { transport, writes } = fakeTransport('Tension Board#123@3', 512);
    const session = await createAuroraProtocol().open(transport);
    const lights: BoardLight[] = Array.from({ length: 100 }, (_, index) => ({ index, color: [0, 255, 0] }));
    const showing = session.show(lights);
    const clearing = session.clear();
    lights[0] = { index: 1000, color: [255, 0, 0] };
    await vi.runAllTimersAsync();
    await Promise.all([showing, clearing]);
    expect(writes.map(({ bytes }) => bytes.length)).toEqual([244, 68, 6]);
    expect(writes[0].bytes.slice(5, 8)).toEqual(new Uint8Array([0, 0, 28]));
    expect(writes.map(({ mode }) => mode)).toEqual(['without-response', 'without-response', 'without-response']);
    expect(writes[1].at - writes[0].at).toBe(5);
    expect(writes[2].bytes).toEqual(encodeAuroraClear());
    await session.disconnect();
  });

  it('only retries an explicit unsupported no-response write with acknowledged chunks', async () => {
    vi.useFakeTimers();
    const { transport, characteristic, writes } = fakeTransport();
    vi.mocked(characteristic.write).mockRejectedValueOnce(
      Object.assign(new Error('unsupported'), { name: 'NotSupportedError' }),
    );
    const session = await createAuroraProtocol().open(transport);
    const showing = session.show(Array.from({ length: 10 }, (_, index) => ({ index, color: [0, 255, 0] as const })));
    await vi.runAllTimersAsync();
    await showing;
    expect(writes.map(({ bytes, mode }) => [bytes.length, mode])).toEqual([
      [20, 'with-response'],
      [16, 'with-response'],
    ]);
    await session.disconnect();
  });

  it('does not replay an ambiguous write failure and invalidates queued work', async () => {
    const { transport, characteristic } = fakeTransport();
    const failure = new Error('radio failed');
    vi.mocked(characteristic.write).mockRejectedValueOnce(failure);
    const session = await createAuroraProtocol().open(transport);
    const showing = session.show([{ index: 42, color: [0, 255, 0] }]);
    const clearing = session.clear();
    const settled = await Promise.allSettled([showing, clearing]);
    expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    expect(characteristic.write).toHaveBeenCalledTimes(1);
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not replay a frame when a later chunk reports an unsupported write', async () => {
    vi.useFakeTimers();
    const { transport, characteristic } = fakeTransport('Tension Board#123@3', 20);
    const unsupported = Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
    vi.mocked(characteristic.write).mockResolvedValueOnce().mockRejectedValueOnce(unsupported);
    const session = await createAuroraProtocol().open(transport);
    const pending = expect(
      session.show(Array.from({ length: 10 }, (_, index) => ({ index, color: [0, 255, 0] as const }))),
    ).rejects.toBe(unsupported);
    await vi.runAllTimersAsync();
    await pending;
    expect(characteristic.write).toHaveBeenCalledTimes(2);
    expect(vi.mocked(characteristic.write).mock.calls.every(([, mode]) => mode === 'without-response')).toBe(true);
    expect(transport.disconnect).toHaveBeenCalledOnce();
  });

  it('retains the proven Aurora profile when a serial-bearing box under-reports properties', async () => {
    const { transport, characteristic, writes } = fakeTransport();
    Object.defineProperty(characteristic, 'writeWithoutResponse', { value: false });
    const session = await createAuroraProtocol().open(transport);
    await session.clear();
    expect(writes[0].mode).toBe('without-response');
    await session.disconnect();
  });

  it('refuses all-dark v2 output before writing and still permits explicit clear', async () => {
    const { transport, writes } = fakeTransport('Kilter Board');
    const session = await createAuroraProtocol({ ledsPerHold: 2 }).open(transport);
    const lights = Array.from({ length: 400 }, (_, index) => ({ index, color: [255, 255, 255] as const }));
    await expect(session.show(lights)).rejects.toMatchObject({ code: 'all-leds-dark' });
    expect(writes).toHaveLength(0);
    await session.clear();
    expect(writes[0].bytes).toEqual(encodeAuroraClear(2));
    await session.disconnect();
  });

  it('closes a connection when initialization fails', async () => {
    const { transport } = fakeTransport();
    vi.mocked(transport.getCharacteristic).mockRejectedValue(new Error('missing'));
    await expect(createAuroraProtocol().open(transport)).rejects.toThrow();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });
});
