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

export const MOONBOARD_GRID = { numColumns: 11, numRows: 18 } as const;
export const MOONBOARD_DEVICE_NAME_PREFIXES = ['MoonBoard', 'Moonboard'] as const;
export const MOONBOARD_UART_SERVICE_UUID = UART_SERVICE_UUID;
export const MOONBOARD_UART_WRITE_CHARACTERISTIC_UUID = UART_WRITE_CHARACTERISTIC_UUID;
export const MOONBOARD_REDBEARLAB_SERVICE_UUID = '713d0000-503e-4c75-ba94-3148f18d941e';
export const MOONBOARD_REDBEARLAB_WRITE_CHARACTERISTIC_UUID = '713d0003-503e-4c75-ba94-3148f18d941e';

export const MOONBOARD_CAPABILITIES: BoardBleCapabilities = {
  rgb: false,
  roles: ['start', 'hand', 'finish'],
  readback: false,
};

const WIRE_ROLES: Partial<Record<BoardRole, string>> = { start: 'S', hand: 'P', finish: 'E' };

export interface MoonboardPacketOptions {
  /** Community-firmware extension. Handling on official controllers is unverified. */
  lightAdjacentHolds?: boolean;
}

export interface MoonboardEncodingOptions extends MoonboardPacketOptions {
  numRows?: number;
}

export interface MoonboardProtocolOptions extends MoonboardPacketOptions {
  /** Standard boards have 18 rows; Mini boards have 12. */
  numRows?: 12 | 18;
}

export function isMoonboardDeviceName(name?: string): boolean {
  return !!name && MOONBOARD_DEVICE_NAME_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/** Map a row-major hold ID (one-based) to the zero-based serpentine LED address. */
export function getMoonboardSerialPosition(holdId: number, numRows: number = MOONBOARD_GRID.numRows): number {
  const maxHoldId = MOONBOARD_GRID.numColumns * numRows;
  if (!Number.isInteger(numRows) || numRows <= 0 || !Number.isInteger(holdId) || holdId < 1 || holdId > maxHoldId) {
    throw new RangeError(`MoonBoard hold id out of range: ${holdId}`);
  }
  const zeroBasedHoldId = holdId - 1;
  const column = zeroBasedHoldId % MOONBOARD_GRID.numColumns;
  const row = Math.floor(zeroBasedHoldId / MOONBOARD_GRID.numColumns);
  return column * numRows + (column % 2 === 0 ? row : numRows - 1 - row);
}

/** Encode already resolved physical LED addresses. Use encodeMoonboardClear to clear. */
export function encodeMoonboardPacket(
  lights: readonly BoardLight[],
  options: MoonboardEncodingOptions = {},
): Uint8Array {
  const numRows = options.numRows ?? MOONBOARD_GRID.numRows;
  if (!Number.isInteger(numRows) || numRows <= 0) throw new BleError('invalid-input', 'Invalid MoonBoard row count');
  const snapshot = snapshotLights(lights, MOONBOARD_CAPABILITIES, MOONBOARD_GRID.numColumns * numRows - 1);
  const holds = snapshot.map((light) => `${WIRE_ROLES[light.role!]}${light.index}`).join(',');
  const packet = `${options.lightAdjacentHolds ? '~D' : ''}l#${holds}#`;
  return Uint8Array.from(packet, (character) => character.charCodeAt(0));
}

/** Community firmware clears on this frame; official-controller behavior is unverified. */
export function encodeMoonboardClear(): Uint8Array {
  return Uint8Array.of(108, 35, 35);
}

/** Nordic UART first, original RedBearLab controller second. Pro/PIN flows are not implemented. */
export function createMoonboardProtocol(options: MoonboardProtocolOptions = {}): BoardBleProtocol {
  const encoding = { ...options };
  if (encoding.numRows !== undefined && encoding.numRows !== 12 && encoding.numRows !== 18) {
    throw new RangeError('Unsupported MoonBoard row count');
  }
  return {
    id: 'moonboard',
    discovery: {
      serviceUuids: [MOONBOARD_UART_SERVICE_UUID, MOONBOARD_REDBEARLAB_SERVICE_UUID],
      namePrefixes: MOONBOARD_DEVICE_NAME_PREFIXES,
    },
    async open(transport, openOptions) {
      const runtime = new BleSessionRuntime(transport, openOptions?.scheduler);
      try {
        const characteristic = await runtime.run(
          (signal) =>
            findCharacteristic(
              transport,
              [
                {
                  serviceUuid: MOONBOARD_UART_SERVICE_UUID,
                  characteristicUuid: MOONBOARD_UART_WRITE_CHARACTERISTIC_UUID,
                },
                {
                  serviceUuid: MOONBOARD_REDBEARLAB_SERVICE_UUID,
                  characteristicUuid: MOONBOARD_REDBEARLAB_WRITE_CHARACTERISTIC_UUID,
                },
              ],
              signal,
            ),
          openOptions?.signal,
        );
        if (!characteristic.writeWithoutResponse && !characteristic.writeWithResponse) {
          throw new BleError('unsupported', 'MoonBoard characteristic is not writable');
        }
        return createWriteSession(
          transport,
          {
            runtime,
            capabilities: MOONBOARD_CAPABILITIES,
            maxIndex: MOONBOARD_GRID.numColumns * (encoding.numRows ?? MOONBOARD_GRID.numRows) - 1,
            encode: (lights) => encodeMoonboardPacket(lights, encoding),
            clear: encodeMoonboardClear,
            characteristic,
            writeOptions: {
              chunkSize: 20,
              mode: characteristic.writeWithoutResponse ? 'without-response' : 'with-response',
              delayMs: 5,
              scheduler: openOptions?.scheduler,
            },
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
