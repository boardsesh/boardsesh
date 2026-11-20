import { describe, expect, it, vi } from 'vitest';
import { BleError } from '@boardsesh/ble-core';
import type { BleCharacteristic, BleCharacteristicRef, BleTransport, BoardLight } from '@boardsesh/ble-core';
import {
  createMoonboardProtocol,
  encodeMoonboardPacket,
  encodeMoonboardClear,
  getMoonboardSerialPosition,
  MOONBOARD_REDBEARLAB_SERVICE_UUID,
  MOONBOARD_UART_SERVICE_UUID,
} from '../index';

function recordingTransport(legacy = false) {
  const writes: { bytes: Uint8Array; mode: string }[] = [];
  const characteristic: BleCharacteristic = {
    writeWithoutResponse: !legacy,
    writeWithResponse: true,
    async write(bytes, mode) {
      writes.push({ bytes: bytes.slice(), mode });
    },
  };
  const disconnect = vi.fn(async () => {});
  const getCharacteristic = vi.fn(async (target: BleCharacteristicRef) => {
    if (legacy && target.serviceUuid === MOONBOARD_UART_SERVICE_UUID) throw new BleError('service-missing');
    return characteristic;
  });
  const transport: BleTransport = {
    deviceId: 'moon-fixture',
    maxWriteBytes: 244,
    getCharacteristic,
    onDisconnect: () => () => {},
    disconnect,
  };
  return { transport, characteristic, getCharacteristic, disconnect, writes };
}

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe('portable MoonBoard codec', () => {
  it('encodes the standard and Mini worked examples using resolved addresses', () => {
    const roles = ['start', 'hand', 'finish'] as const;
    const standard = [1, 2, 198].map((hold, index) => ({
      index: getMoonboardSerialPosition(hold),
      role: roles[index],
    }));
    const mini = [1, 2, 132].map((hold, index) => ({
      index: getMoonboardSerialPosition(hold, 12),
      role: roles[index],
    }));
    expect(decode(encodeMoonboardPacket(standard))).toBe('l#S0,P35,E197#');
    expect(decode(encodeMoonboardPacket(mini, { numRows: 12 }))).toBe('l#S0,P23,E131#');
  });

  it('maps every Standard and Mini hold exactly once', () => {
    for (const rows of [12, 18]) {
      const addresses = Array.from({ length: rows * 11 }, (_, index) => getMoonboardSerialPosition(index + 1, rows));
      expect(addresses.sort((left, right) => left - right)).toEqual(
        Array.from({ length: rows * 11 }, (_, index) => index),
      );
    }
  });

  it('makes clearing explicit and keeps the additional-LED extension opt-in', () => {
    expect(() => encodeMoonboardPacket([])).toThrow('clear()');
    expect(decode(encodeMoonboardClear())).toBe('l##');
    expect(decode(encodeMoonboardPacket([{ index: 0, role: 'start' }], { lightAdjacentHolds: true }))).toBe('~Dl#S0#');
  });

  it('rejects unsupported RGB, foot roles, and addresses outside the configured strip', () => {
    expect(() => encodeMoonboardPacket([{ index: 0, color: [0, 255, 0] }])).toThrow();
    expect(() => encodeMoonboardPacket([{ index: 0, role: 'foot' }])).toThrow();
    expect(() => encodeMoonboardPacket([{ index: 132, role: 'hand' }], { numRows: 12 })).toThrow();
  });
});

describe('portable MoonBoard session', () => {
  it('falls back to RedBearLab and uses acknowledged writes', async () => {
    const recording = recordingTransport(true);
    const session = await createMoonboardProtocol().open(recording.transport);
    await session.show([{ index: 0, role: 'start' }]);
    expect(recording.getCharacteristic.mock.calls.map(([target]) => target.serviceUuid)).toEqual([
      MOONBOARD_UART_SERVICE_UUID,
      MOONBOARD_REDBEARLAB_SERVICE_UUID,
    ]);
    expect(recording.writes.map(({ mode }) => mode)).toEqual(['with-response']);
    await session.clear();
    expect(decode(recording.writes[1].bytes)).toBe('l##');
    await session.disconnect();
    expect(recording.disconnect).toHaveBeenCalledOnce();
  });

  it('snapshots submitted inputs and sends exactly 20-byte chunks', async () => {
    const recording = recordingTransport();
    const session = await createMoonboardProtocol().open(recording.transport);
    const lights: BoardLight[] = Array.from({ length: 12 }, (_, index) => ({ index, role: 'hand' }));
    const expected = encodeMoonboardPacket(lights);
    const sending = session.show(lights);
    lights.splice(0, lights.length, { index: 197, role: 'finish' });
    await sending;
    expect(recording.writes.length).toBeGreaterThan(1);
    expect(recording.writes.every(({ bytes }) => bytes.length <= 20)).toBe(true);
    expect(Uint8Array.from(recording.writes.flatMap(({ bytes }) => [...bytes]))).toEqual(expected);
  });

  it('refuses invalid inputs without writing and leaves a usable session', async () => {
    const recording = recordingTransport();
    const session = await createMoonboardProtocol({ numRows: 12 }).open(recording.transport);
    await expect(session.show([])).rejects.toThrow();
    await expect(session.show([{ index: 132, role: 'hand' }])).rejects.toThrow();
    expect(recording.writes).toHaveLength(0);
    await session.show([{ index: 131, role: 'finish' }]);
    expect(decode(recording.writes[0].bytes)).toBe('l#E131#');
  });

  it('closes a connection cancelled during characteristic discovery', async () => {
    const recording = recordingTransport();
    const cancellation = new AbortController();
    recording.getCharacteristic.mockImplementation(async () => {
      cancellation.abort();
      return recording.characteristic;
    });
    await expect(
      createMoonboardProtocol().open(recording.transport, { signal: cancellation.signal }),
    ).rejects.toThrow();
    expect(recording.disconnect).toHaveBeenCalledOnce();
    expect(recording.writes).toHaveLength(0);
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
  const opening = createMoonboardProtocol().open(recording.transport);
  const rejected = expect(opening).rejects.toThrow('disconnected');
  await vi.waitFor(() => expect(finishDiscovery).toBeDefined());
  dropped();
  await rejected;
  finishDiscovery(recording.characteristic);
  await Promise.resolve();
  expect(recording.disconnect).toHaveBeenCalledOnce();
  expect(recording.writes).toHaveLength(0);
});
