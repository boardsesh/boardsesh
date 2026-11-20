import {
  BleError,
  BleSessionRuntime,
  UART_SERVICE_UUID,
  UART_WRITE_CHARACTERISTIC_UUID,
  createWriteSession,
  findCharacteristic,
  snapshotLights,
  type BoardBleCapabilities,
  type BoardBleProtocol,
  type BoardLight,
  type BoardRole,
} from '@boardsesh/ble-core';
import { WOODS_LED_MAPS, type WoodsBoardSize } from './generated/woods-led-maps-data';

export { WOODS_LED_MAPS, type WoodsBoardSize };
export const WOODS_DEVICE_NAME_PREFIXES = ['Woods Board'] as const;
export const WOODS_BOARD_SIZES = ['8x10', '12x12'] as const;
export const WOODS_WIRE_ROLE = { FOOT: 1, HAND: 2, FINISH: 3, START: 4 } as const;
export type WoodsWireRole = (typeof WOODS_WIRE_ROLE)[keyof typeof WOODS_WIRE_ROLE];
export const WOODS_UART_SERVICE_UUID = UART_SERVICE_UUID;
export const WOODS_UART_WRITE_CHARACTERISTIC_UUID = UART_WRITE_CHARACTERISTIC_UUID;

export const WOODS_CAPABILITIES: BoardBleCapabilities = {
  rgb: false,
  roles: ['start', 'hand', 'foot', 'finish'],
  readback: false,
};

const WIRE_ROLES: Record<BoardRole, WoodsWireRole> = {
  start: WOODS_WIRE_ROLE.START,
  hand: WOODS_WIRE_ROLE.HAND,
  foot: WOODS_WIRE_ROLE.FOOT,
  finish: WOODS_WIRE_ROLE.FINISH,
};
const MAX_LED_INDEX: Record<WoodsBoardSize, number> = { '8x10': 484, '12x12': 897 };

export function isWoodsDeviceName(name?: string): boolean {
  return !!name && WOODS_DEVICE_NAME_PREFIXES.some((prefix) => name.toLowerCase().startsWith(prefix.toLowerCase()));
}

/** Resolve the API's baseHoldLocation to the physical zero-based LED address. */
export function getWoodsSerialPosition(holdId: number, size: WoodsBoardSize): number {
  const index = WOODS_LED_MAPS[size]?.[holdId];
  if (!Number.isInteger(holdId) || index === undefined) {
    throw new RangeError(`Woods hold id out of range: ${holdId}`);
  }
  return index;
}

/** Encode physical LED addresses; RGB is unsupported because firmware chooses role colors. */
export function encodeWoodsPacket(lights: readonly BoardLight[], size: WoodsBoardSize): Uint8Array {
  if (!WOODS_BOARD_SIZES.includes(size)) throw new RangeError('Unsupported Woods board size');
  const snapshot = snapshotLights(lights, WOODS_CAPABILITIES, MAX_LED_INDEX[size]);
  const pairs = snapshot.map((light) => `${light.index},${WIRE_ROLES[light.role!]}`).join(',');
  return Uint8Array.from(`${pairs},!`, (character) => character.charCodeAt(0));
}

export function encodeWoodsClear(): Uint8Array {
  return Uint8Array.of(44, 33);
}

/** Woods requires acknowledged writes even when the characteristic advertises both modes. */
export function createWoodsProtocol(options: { size: WoodsBoardSize }): BoardBleProtocol {
  const size = options.size;
  if (!WOODS_BOARD_SIZES.includes(size)) throw new RangeError('Unsupported Woods board size');
  return {
    id: 'woods',
    discovery: { serviceUuids: [WOODS_UART_SERVICE_UUID], namePrefixes: WOODS_DEVICE_NAME_PREFIXES },
    async open(transport, openOptions) {
      const runtime = new BleSessionRuntime(transport, openOptions?.scheduler);
      try {
        const characteristic = await runtime.run(
          (signal) =>
            findCharacteristic(
              transport,
              [{ serviceUuid: WOODS_UART_SERVICE_UUID, characteristicUuid: WOODS_UART_WRITE_CHARACTERISTIC_UUID }],
              signal,
            ),
          openOptions?.signal,
        );
        if (!characteristic.writeWithResponse) throw new BleError('unsupported', 'Woods requires acknowledged writes');
        return createWriteSession(
          transport,
          {
            runtime,
            capabilities: WOODS_CAPABILITIES,
            maxIndex: MAX_LED_INDEX[size],
            encode: (lights) => encodeWoodsPacket(lights, size),
            clear: encodeWoodsClear,
            characteristic,
            writeOptions: { chunkSize: 20, mode: 'with-response', delayMs: 5, scheduler: openOptions?.scheduler },
          },
          openOptions,
        );
      } catch (error) {
        await runtime.disconnect(error).catch(() => undefined);
        throw error;
      }
    },
  };
}
