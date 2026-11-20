import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BleTransport } from '@boardsesh/ble-core';
import { encodeAuroraLights } from '@boardsesh/aurora-ble-protocol';
import { createKilterProtocol, encodeKilterLights, isKilterDeviceName } from '../index';

afterEach(() => vi.useRealTimers());

describe('Kilter Aurora profile', () => {
  it('shares Aurora bytes with two LEDs per hold for power scaling', () => {
    const lights = Array.from({ length: 40 }, (_, index) => ({ index, color: [255, 255, 255] as const }));
    const kilter = encodeKilterLights(lights, { apiLevel: 2 });
    expect(kilter).toEqual(encodeAuroraLights(lights, { apiLevel: 2, ledsPerHold: 2 }));
    expect(kilter.packet).not.toEqual(encodeAuroraLights(lights, { apiLevel: 2, ledsPerHold: 1 }).packet);
  });

  it('identifies Kilter without classifying every Aurora board as Kilter', () => {
    expect(isKilterDeviceName('Kilter Board#123@3')).toBe(true);
    expect(isKilterDeviceName('Kilter Board')).toBe(true);
    expect(isKilterDeviceName('Tension Board#123@3')).toBe(false);
    expect(isKilterDeviceName()).toBe(false);
  });

  it.each([
    { name: 'Kilter Board', mode: 'with-response', sizes: [20, 6], interval: 100 },
    { name: 'Kilter Board#123@3', mode: 'without-response', sizes: [36], interval: 0 },
  ])('preserves the controller profile for $name', async ({ name, mode, sizes, interval }) => {
    vi.useFakeTimers();
    const writes: { size: number; mode: string; at: number }[] = [];
    const transport: BleTransport = {
      deviceId: 'selected-device',
      deviceName: name,
      maxWriteBytes: 244,
      getCharacteristic: async () => ({
        writeWithResponse: true,
        writeWithoutResponse: true,
        async write(bytes, selectedMode) {
          writes.push({ size: bytes.length, mode: selectedMode, at: Date.now() });
        },
      }),
      onDisconnect: () => () => {},
      disconnect: async () => {},
    };
    const protocol = createKilterProtocol();
    expect(protocol.id).toBe('kilter');
    const session = await protocol.open(transport);
    const showing = session.show(Array.from({ length: 10 }, (_, index) => ({ index, color: [0, 255, 0] as const })));
    await vi.runAllTimersAsync();
    await showing;
    expect(writes.map(({ size }) => size)).toEqual(sizes);
    expect(writes.every((write) => write.mode === mode)).toBe(true);
    if (writes.length > 1) expect(writes[1].at - writes[0].at).toBe(interval);
    await session.disconnect();
  });
});
