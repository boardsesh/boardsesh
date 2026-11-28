/**
 * Platform-neutral Quantum Board wire protocol.
 *
 * The functions in this module only encode, decode, and coordinate complete
 * protocol frames. Platform adapters remain responsible for BLE discovery,
 * MTU negotiation, characteristic subscription, and operation timeouts.
 */

import {
  QUANTUM_ATT_HEADER_BYTES,
  QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS,
  QUANTUM_DEVICE_NAME_PREFIXES,
  QUANTUM_MAX_DIODE_IDS,
  QUANTUM_MODELS,
  QuantumCommand,
  type QuantumBoardModel,
} from './constants';

const QUANTUM_MODEL_BY_CONTROLLER_TYPE = new Map(QUANTUM_MODELS.map((model) => [model.controllerType, model] as const));

const UUID_PATTERN =
  /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

function assertIntegerInRange(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

function concatenateBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const byteLength = parts.reduce((total, part) => total + part.length, 0);
  const output = new Uint8Array(byteLength);
  let offset = 0;

  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }

  return output;
}

function encodeBigEndianUint16(value: number): Uint8Array {
  assertIntegerInRange('16-bit value', value, 0, 0xffff);
  return Uint8Array.of((value >>> 8) & 0xff, value & 0xff);
}

function encodeRgb(color: number): Uint8Array {
  assertIntegerInRange('Quantum color', color, 0, 0xffffff);
  return Uint8Array.of((color >>> 16) & 0xff, (color >>> 8) & 0xff, color & 0xff);
}

function isQuantumCommand(value: number): value is QuantumCommand {
  return Object.values(QuantumCommand).some((command) => command === value);
}

export function parseQuantumDeviceSerial(deviceName?: string): string | undefined {
  if (!deviceName || !QUANTUM_DEVICE_NAME_PREFIXES.some((prefix) => deviceName.startsWith(prefix))) {
    return undefined;
  }

  const serial = deviceName.slice(deviceName.lastIndexOf('_') + 1);
  return /^[0-9a-fA-F]{12}$/.test(serial) ? serial : undefined;
}

export function quantumAttPayloadBytes(mtu: number): number {
  return Number.isFinite(mtu) ? Math.max(0, Math.floor(mtu) - QUANTUM_ATT_HEADER_BYTES) : 0;
}

export function quantumFrameFitsMtu(frame: Uint8Array, mtu: number): boolean {
  return frame.length > 0 && frame.length <= quantumAttPayloadBytes(mtu);
}

export function encodeQuantumUuid(uuid: string): Uint8Array {
  if (!UUID_PATTERN.test(uuid)) {
    throw new TypeError('Quantum UUID must contain exactly 32 hexadecimal digits');
  }

  const hexadecimal = uuid.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, byteIndex) =>
    Number.parseInt(hexadecimal.slice(byteIndex * 2, byteIndex * 2 + 2), 16),
  );
}

export function decodeQuantumUuid(bytes: Uint8Array, offset: number = 0): string {
  assertIntegerInRange('Quantum UUID offset', offset, 0, bytes.length);
  if (offset + 16 > bytes.length) {
    throw new RangeError('Quantum UUID needs 16 bytes');
  }

  const hexadecimal = Array.from(bytes.slice(offset, offset + 16), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
  return `${hexadecimal.slice(0, 8)}-${hexadecimal.slice(8, 12)}-${hexadecimal.slice(12, 16)}-${hexadecimal.slice(
    16,
    20,
  )}-${hexadecimal.slice(20)}`;
}

export function canonicalQuantumUuid(uuid: string): string {
  return decodeQuantumUuid(encodeQuantumUuid(uuid));
}

export function quantumUuidsEqual(first: string, second: string): boolean {
  return canonicalQuantumUuid(first) === canonicalQuantumUuid(second);
}

export function quantumCrc16Modbus(bytes: Uint8Array): number {
  let crc = 0xffff;

  for (const byte of bytes) {
    crc ^= byte;
    for (let bitIndex = 0; bitIndex < 8; bitIndex++) {
      crc = (crc & 1) === 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
  }

  return crc & 0xffff;
}

export function quantumFrameHasValidCrc(frame: Uint8Array): boolean {
  if (frame.length < 4) return false;
  const body = frame.slice(0, -2);
  const expected = quantumCrc16Modbus(body);
  const received = (frame[frame.length - 2] << 8) | frame[frame.length - 1];
  return expected === received;
}

function encodeQuantumCommand(command: QuantumCommand, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const body = concatenateBytes(Uint8Array.of(1, command), payload);
  const crc = quantumCrc16Modbus(body);
  return concatenateBytes(body, Uint8Array.of((crc >>> 8) & 0xff, crc & 0xff));
}

export type QuantumActivation = {
  routeId: string;
  userId: string;
  diodeIds: readonly number[];
  color?: number;
  durationSeconds?: number;
  animation?: number;
  swipe?: boolean;
};

export function encodeQuantumActivation({
  routeId,
  userId,
  diodeIds,
  color = 0x00ffff,
  durationSeconds = QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS,
  animation = 0,
  swipe = false,
}: QuantumActivation): Uint8Array {
  if (diodeIds.length === 0) throw new RangeError('Quantum activation requires at least one diode');
  if (diodeIds.length > QUANTUM_MAX_DIODE_IDS) {
    throw new RangeError(`Quantum activation is limited to ${QUANTUM_MAX_DIODE_IDS} diodes`);
  }

  assertIntegerInRange('Quantum duration', durationSeconds, 1, 0xffff);
  assertIntegerInRange('Quantum animation', animation, 0, 0xff);
  diodeIds.forEach((diodeId) => assertIntegerInRange('Quantum diode id', diodeId, 0, 0xffff));

  const diodeBytes = new Uint8Array(diodeIds.length * 2);
  diodeIds.forEach((diodeId, diodeIndex) => {
    diodeBytes[diodeIndex * 2] = (diodeId >>> 8) & 0xff;
    diodeBytes[diodeIndex * 2 + 1] = diodeId & 0xff;
  });

  const payload = concatenateBytes(
    encodeQuantumUuid(routeId),
    encodeQuantumUuid(userId),
    encodeRgb(color),
    encodeBigEndianUint16(durationSeconds),
    Uint8Array.of(
      durationSeconds === QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS ? animation : animation | 0x80,
      diodeBytes.length,
    ),
    diodeBytes,
  );

  return encodeQuantumCommand(swipe ? QuantumCommand.BOARD_SWIPE : QuantumCommand.ACTIVATE_WALL, payload);
}

export function encodeQuantumTurnOffRoute(routeId: string): Uint8Array {
  return encodeQuantumCommand(QuantumCommand.TURN_OFF_BY_ROUTE, encodeQuantumUuid(routeId));
}

export function encodeQuantumTurnOffUser(userId: string): Uint8Array {
  return encodeQuantumCommand(QuantumCommand.TURN_OFF_BY_USER, encodeQuantumUuid(userId));
}

export function encodeQuantumTurnOffAll(): Uint8Array {
  return encodeQuantumCommand(QuantumCommand.TURN_OFF_ALL, Uint8Array.of(0, 1, 0, 0));
}

export function encodeQuantumRosterRequest(row: number = 0): Uint8Array {
  assertIntegerInRange('Quantum roster row', row, 0, 0xff);
  return encodeQuantumCommand(QuantumCommand.REQUEST_USER_ROUTE_LIST, Uint8Array.of(row));
}

export function encodeQuantumTurnOnAll(color: number, durationSeconds: number = 0): Uint8Array {
  return encodeQuantumCommand(
    QuantumCommand.TURN_ON_ALL,
    concatenateBytes(encodeRgb(color), encodeBigEndianUint16(durationSeconds)),
  );
}

export type QuantumActivePlayer = {
  routeId: string;
  userId: string;
  remainingSeconds: number;
  color: number;
};

export type QuantumControllerFailure =
  | 'route-in-use'
  | 'spot-unavailable'
  | 'color-taken'
  | 'user-id-in-use'
  | 'board-full'
  | 'routesetter-mode'
  | 'diode-missing'
  | 'ack-timeout'
  | 'refused';

export type QuantumBroadcast =
  | {
      type: 'roster';
      command:
        | typeof QuantumCommand.ACTIVATE_WALL
        | typeof QuantumCommand.BOARD_SWIPE
        | typeof QuantumCommand.REQUEST_USER_ROUTE_LIST;
      players: QuantumActivePlayer[];
    }
  | { type: 'user-removed'; command: typeof QuantumCommand.TURN_OFF_BY_USER; userId: string }
  | { type: 'wall-cleared'; command: typeof QuantumCommand.TURN_OFF_ALL }
  | { type: 'wall-lit'; command: typeof QuantumCommand.TURN_ON_ALL; color?: number }
  | {
      type: 'controller-error';
      failedCommand?: QuantumCommand;
      code: number;
      failure: QuantumControllerFailure;
    };

const QUANTUM_PLAYER_RECORD_BYTES = 37;

export function quantumControllerFailureFromCode(code: number): QuantumControllerFailure {
  switch (code) {
    case 5:
      return 'route-in-use';
    case 6:
      return 'spot-unavailable';
    case 7:
      return 'color-taken';
    case 8:
      return 'user-id-in-use';
    case 9:
      return 'board-full';
    case 10:
      return 'routesetter-mode';
    case 11:
      return 'diode-missing';
    case 254:
      return 'ack-timeout';
    default:
      return 'refused';
  }
}

/**
 * Returns the minimum length of a supported controller broadcast once its header
 * is complete. `undefined` means either an incomplete header or an unsupported
 * shape; callers must still use {@link parseQuantumBroadcast} before trusting it.
 */
export function quantumBroadcastLength(framePrefix: Uint8Array): number | undefined {
  if (framePrefix.length < 2 || framePrefix[0] !== 1) return undefined;
  const rawCommand = framePrefix[1];

  if ((rawCommand & 0x80) !== 0) return 3;

  switch (rawCommand) {
    case QuantumCommand.ACTIVATE_WALL:
    case QuantumCommand.BOARD_SWIPE:
    case QuantumCommand.REQUEST_USER_ROUTE_LIST: {
      if (framePrefix.length < 4) return undefined;
      const playerCount = framePrefix[2];
      return 4 + playerCount * QUANTUM_PLAYER_RECORD_BYTES;
    }
    case QuantumCommand.TURN_OFF_BY_USER:
      return 21;
    case QuantumCommand.TURN_OFF_ALL:
      return 6;
    case QuantumCommand.TURN_ON_ALL:
      return 3;
    default:
      return undefined;
  }
}

export function parseQuantumBroadcast(frame: Uint8Array): QuantumBroadcast | undefined {
  const expectedLength = quantumBroadcastLength(frame);
  if (expectedLength === undefined || frame.length < expectedLength) return undefined;

  const rawCommand = frame[1];
  if ((rawCommand & 0x80) !== 0) {
    const failedCommandValue = rawCommand & 0x7f;
    return {
      type: 'controller-error',
      failedCommand: isQuantumCommand(failedCommandValue) ? failedCommandValue : undefined,
      code: frame[2],
      failure: quantumControllerFailureFromCode(frame[2]),
    };
  }

  switch (rawCommand) {
    case QuantumCommand.ACTIVATE_WALL:
    case QuantumCommand.BOARD_SWIPE:
    case QuantumCommand.REQUEST_USER_ROUTE_LIST: {
      const playerCount = frame[2];
      // The reference decoder skips byte 3 and ignores trailing bytes.

      const players = Array.from({ length: playerCount }, (_, playerIndex): QuantumActivePlayer => {
        const offset = 4 + playerIndex * QUANTUM_PLAYER_RECORD_BYTES;
        return {
          routeId: decodeQuantumUuid(frame, offset),
          userId: decodeQuantumUuid(frame, offset + 16),
          remainingSeconds: (frame[offset + 32] << 8) | frame[offset + 33],
          color: (frame[offset + 34] << 16) | (frame[offset + 35] << 8) | frame[offset + 36],
        };
      });

      return { type: 'roster', command: rawCommand, players };
    }
    case QuantumCommand.TURN_OFF_BY_USER:
      return { type: 'user-removed', command: rawCommand, userId: decodeQuantumUuid(frame, 2) };
    case QuantumCommand.TURN_OFF_ALL:
      return { type: 'wall-cleared', command: rawCommand };
    case QuantumCommand.TURN_ON_ALL:
      return {
        type: 'wall-lit',
        command: rawCommand,
        color: frame[2] === 0xff ? 0xffffff : undefined,
      };
    default:
      return undefined;
  }
}

export type QuantumControllerMetadata = {
  model: QuantumBoardModel;
  controllerType: number;
  columns: number;
  rows: number;
};

export function parseQuantumControllerMetadata(bytes: Uint8Array): QuantumControllerMetadata | undefined {
  if (bytes.length !== 41) return undefined;

  const controllerType = bytes[34];
  const model = QUANTUM_MODEL_BY_CONTROLLER_TYPE.get(controllerType);
  if (!model) return undefined;

  const columns = (bytes[35] << 8) | bytes[36];
  const rows = (bytes[37] << 8) | bytes[38];
  if (columns !== model.columns || rows !== model.rows) return undefined;

  return { model, controllerType, columns, rows };
}
