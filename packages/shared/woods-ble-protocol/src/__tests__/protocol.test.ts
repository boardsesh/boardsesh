import { describe, expect, it, vi } from 'vitest';
import type { BleCharacteristic, BleTransport, BoardLight } from '@boardsesh/ble-core';
import {
  createWoodsProtocol,
  encodeWoodsPacket,
  encodeWoodsClear,
  getWoodsSerialPosition,
  WOODS_LED_MAPS,
  isWoodsDeviceName,
} from '../index';

function recordingTransport() {
  const writes: { bytes: Uint8Array; mode: string }[] = [];
  const characteristic: BleCharacteristic = {
    writeWithoutResponse: true,
    writeWithResponse: true,
    async write(bytes, mode) {
      writes.push({ bytes: bytes.slice(), mode });
    },
  };
  const disconnect = vi.fn(async () => {});
  const transport: BleTransport = {
    deviceId: 'woods-fixture',
    maxWriteBytes: 244,
    getCharacteristic: async () => characteristic,
    onDisconnect: () => () => {},
    disconnect,
  };
  return { transport, characteristic, disconnect, writes };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('portable Woods codec', () => {
  it('preserves the specification worked example and all four role codes', () => {
    const roles = ['start', 'hand', 'finish'] as const;
    const lights = [0, 5, 7].map((hold, index) => ({
      index: getWoodsSerialPosition(hold, '12x12'),
      role: roles[index],
    }));
    expect(decode(encodeWoodsPacket(lights, '12x12'))).toBe('28,4,237,2,341,3,!');
    expect(decode(encodeWoodsPacket([{ index: 24, role: 'foot' }], '8x10'))).toBe('24,1,!');
  });

  it('owns the complete maps and rejects unmapped hold IDs', () => {
    expect(Object.keys(WOODS_LED_MAPS['8x10'])).toHaveLength(485);
    expect(Object.keys(WOODS_LED_MAPS['12x12'])).toHaveLength(894);
    expect(getWoodsSerialPosition(1, '8x10')).toBe(25);
    expect(getWoodsSerialPosition(1, '12x12')).toBe(29);
    expect(() => getWoodsSerialPosition(999, '8x10')).toThrow();
  });

  it('requires explicit clear and refuses RGB or invalid addresses', () => {
    expect(decode(encodeWoodsClear())).toBe(',!');
    expect(() => encodeWoodsPacket([], '8x10')).toThrow('clear()');
    expect(() => encodeWoodsPacket([{ index: 0, color: [255, 0, 0] }], '8x10')).toThrow();
    expect(() => encodeWoodsPacket([{ index: 485, role: 'hand' }], '8x10')).toThrow();
  });

  it('recognizes both supported controller names without a catalog dependency', () => {
    expect(isWoodsDeviceName('Woods Board')).toBe(true);
    expect(isWoodsDeviceName('woods board v2')).toBe(true);
    expect(isWoodsDeviceName('MoonBoard')).toBe(false);
  });
});

describe('portable Woods session', () => {
  it('forces acknowledged writes in 20-byte chunks even when both modes are advertised', async () => {
    const recording = recordingTransport();
    const session = await createWoodsProtocol({ size: '12x12' }).open(recording.transport);
    const lights: BoardLight[] = Array.from({ length: 16 }, (_, index) => ({ index, role: 'hand' }));
    await session.show(lights);
    expect(recording.writes.length).toBeGreaterThan(1);
    expect(recording.writes.every(({ bytes, mode }) => bytes.length <= 20 && mode === 'with-response')).toBe(true);
    expect(Uint8Array.from(recording.writes.flatMap(({ bytes }) => [...bytes]))).toEqual(
      encodeWoodsPacket(lights, '12x12'),
    );
    await session.clear();
    expect(decode(recording.writes.at(-1)!.bytes)).toBe(',!');
  });

  it('closes unsupported characteristics instead of silently choosing unacknowledged writes', async () => {
    const recording = recordingTransport();
    Object.assign(recording.characteristic, { writeWithResponse: false });
    await expect(createWoodsProtocol({ size: '8x10' }).open(recording.transport)).rejects.toThrow('acknowledged');
    expect(recording.disconnect).toHaveBeenCalledOnce();
    expect(recording.writes).toHaveLength(0);
  });

  it('rejects empty show without clearing or losing the connection', async () => {
    const recording = recordingTransport();
    const session = await createWoodsProtocol({ size: '8x10' }).open(recording.transport);
    await expect(session.show([])).rejects.toThrow();
    expect(recording.writes).toHaveLength(0);
    await session.show([{ index: 24, role: 'start' }]);
    expect(decode(recording.writes[0].bytes)).toBe('24,4,!');
  });
});

it('rejects a disconnect during pending discovery and cleans up late discovery', async () => {
  const recording = recordingTransport();
  let dropped: (error?: unknown) => void = () => {};
  let finishDiscovery!: (characteristic: BleCharacteristic) => void;
  recording.transport.onDisconnect = (listener) => {
    dropped = listener;
    return () => {};
  };
  recording.transport.getCharacteristic = () =>
    new Promise((resolve) => {
      finishDiscovery = resolve;
    });
  const opening = createWoodsProtocol({ size: '8x10' }).open(recording.transport);
  const rejected = expect(opening).rejects.toThrow('disconnected');
  await vi.waitFor(() => expect(finishDiscovery).toBeDefined());
  dropped();
  await rejected;
  finishDiscovery(recording.characteristic);
  await Promise.resolve();
  expect(recording.disconnect).toHaveBeenCalledOnce();
  expect(recording.writes).toHaveLength(0);
});
