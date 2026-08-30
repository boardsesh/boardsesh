/**
 * Platform-neutral Quantum Board wire protocol.
 *
 * The functions in this module only encode, decode, and coordinate complete
 * protocol frames. Platform adapters remain responsible for BLE discovery,
 * MTU negotiation, characteristic subscription, and operation timeouts.
 */

export const QUANTUM_SERVICE_UUID = '0000ffe0-0000-1000-8000-00805f9b34fb';
export const QUANTUM_LEGACY_SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
export const QUANTUM_SERVICE_UUIDS = [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID] as const;
export const QUANTUM_NOTIFY_CHARACTERISTIC_UUID = '0000fff1-0000-1000-8000-00805f9b34fb';
export const QUANTUM_WRITE_CHARACTERISTIC_UUID = '0000fff2-0000-1000-8000-00805f9b34fb';
export const QUANTUM_STATE_CHARACTERISTIC_UUID = '0000fff4-0000-1000-8000-00805f9b34fb';
export const QUANTUM_METADATA_CHARACTERISTIC_UUID = '0000fff5-0000-1000-8000-00805f9b34fb';

export const QUANTUM_REQUESTED_MTU = 512;
export const QUANTUM_ATT_HEADER_BYTES = 3;
export const QUANTUM_MAX_PLAYERS = 4;
export const QUANTUM_MAX_DIODE_IDS = 92;
export const QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS = 0xffff;
export const QUANTUM_ZERO_UUID = '00000000-0000-0000-0000-000000000000';

export const QUANTUM_DEVICE_NAME_PREFIXES = ['eWalls_', 'QB_', 'QBB_'] as const;

export const QuantumCommand = {
  ACTIVATE_WALL: 0x41,
  TURN_OFF_BY_ROUTE: 0x42,
  TURN_OFF_BY_USER: 0x43,
  BOARD_SWIPE: 0x44,
  TURN_OFF_ALL: 0x45,
  REQUEST_USER_ROUTE_LIST: 0x47,
  TURN_ON_ALL: 0x64,
} as const;

export type QuantumCommand = (typeof QuantumCommand)[keyof typeof QuantumCommand];

export type QuantumBoardModelId = 'xl' | 'l' | 'm' | 's' | 'belay';

export type QuantumBoardModel = {
  id: QuantumBoardModelId;
  displayName: string;
  controllerType: number;
  columns: number;
  rows: number;
};

export const QUANTUM_BOARD_MODELS = {
  xl: { id: 'xl', displayName: 'XL', controllerType: 0, columns: 15, rows: 15 },
  l: { id: 'l', displayName: 'L', controllerType: 4, columns: 15, rows: 12 },
  m: { id: 'm', displayName: 'M', controllerType: 1, columns: 12, rows: 12 },
  s: { id: 's', displayName: 'S Fitness', controllerType: 2, columns: 8, rows: 12 },
  belay: { id: 'belay', displayName: 'Belay Board', controllerType: 3, columns: 8, rows: 12 },
} as const satisfies Record<QuantumBoardModelId, QuantumBoardModel>;

export const QUANTUM_MODELS: readonly QuantumBoardModel[] = Object.values(QUANTUM_BOARD_MODELS);

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

function canonicalQuantumUuid(uuid: string): string {
  return decodeQuantumUuid(encodeQuantumUuid(uuid));
}

function quantumUuidsEqual(first: string, second: string): boolean {
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

  assertIntegerInRange('Quantum duration', durationSeconds, 0, 0xffff);
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
    Uint8Array.of(animation, diodeBytes.length),
    diodeBytes,
  );

  return encodeQuantumCommand(swipe ? QuantumCommand.BOARD_SWIPE : QuantumCommand.ACTIVATE_WALL, payload);
}

export function encodeQuantumTurnOffRoute(routeId: string): Uint8Array {
  return encodeQuantumCommand(
    QuantumCommand.TURN_OFF_BY_ROUTE,
    concatenateBytes(encodeQuantumUuid(routeId), Uint8Array.of(0)),
  );
}

export function encodeQuantumTurnOffUser(userId: string): Uint8Array {
  return encodeQuantumCommand(
    QuantumCommand.TURN_OFF_BY_USER,
    concatenateBytes(encodeQuantumUuid(userId), Uint8Array.of(0)),
  );
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
 * Returns the exact length of a supported controller broadcast once its header
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
      return playerCount <= QUANTUM_MAX_PLAYERS ? 4 + playerCount * QUANTUM_PLAYER_RECORD_BYTES : undefined;
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
  if (expectedLength === undefined || frame.length !== expectedLength) return undefined;

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
      if (frame[3] !== 0) return undefined;

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

function playerIdentity(player: QuantumActivePlayer): string {
  return `${canonicalQuantumUuid(player.routeId)}|${canonicalQuantumUuid(player.userId)}|${player.color & 0xffffff}`;
}

/** Compare controller ownership while deliberately ignoring countdown drift. */
export function quantumRostersEqual(
  first: readonly QuantumActivePlayer[],
  second: readonly QuantumActivePlayer[],
): boolean {
  if (first.length !== second.length) return false;
  const firstIdentities = first.map(playerIdentity).sort();
  const secondIdentities = second.map(playerIdentity).sort();
  return firstIdentities.every((identity, index) => identity === secondIdentities[index]);
}

export interface QuantumRosterTransport {
  /** Largest complete value accepted by one write-with-response operation. */
  readonly maximumWriteBytes: number;
  /** Must issue exactly one acknowledged characteristic write for this frame. */
  writeWithResponse(frame: Uint8Array): Promise<void>;
  /** Read one complete value from the state characteristic. */
  readState(): Promise<Uint8Array | undefined>;
  /** Optional notification fallback; the adapter owns its timeout mechanism. */
  waitForNotification?(timeoutMs: number): Promise<Uint8Array | undefined>;
}

export interface QuantumTime {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

const SYSTEM_QUANTUM_TIME: QuantumTime = {
  now: () => Date.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

export type QuantumRosterSnapshot = {
  revision: number;
  observedAtMs: number;
  players: readonly QuantumActivePlayer[];
};

export type QuantumRosterOperation = 'refresh' | 'activate' | 'remove';
export type QuantumRosterPhase = 'idle' | 'refreshing' | 'mutating' | 'live' | 'failed';

export type QuantumRosterTransactionErrorCode =
  | 'frame-too-large'
  | 'transport-failed'
  | 'roster-unavailable'
  | 'controller-refused'
  | 'roster-changed'
  | 'board-full'
  | 'color-in-use'
  | 'target-route-changed'
  | 'confirmation-failed';

export type QuantumRosterMachineState = {
  phase: QuantumRosterPhase;
  operation?: QuantumRosterOperation;
  snapshot?: QuantumRosterSnapshot;
  lastError?: QuantumRosterTransactionErrorCode;
};

export class QuantumRosterTransactionError extends Error {
  readonly code: QuantumRosterTransactionErrorCode;
  readonly controllerFailure?: QuantumControllerFailure;

  constructor(
    code: QuantumRosterTransactionErrorCode,
    message: string,
    options: { cause?: unknown; controllerFailure?: QuantumControllerFailure } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'QuantumRosterTransactionError';
    this.code = code;
    this.controllerFailure = options.controllerFailure;
  }
}

export type QuantumRosterMachineOptions = {
  routeListReadDelayMs?: number;
  releaseBeforeActivationDelayMs?: number;
  activationSettleDelayMs?: number;
  notificationTimeoutMs?: number;
};

export type QuantumActivateTransaction = QuantumActivation & {
  expectedPlayers?: readonly QuantumActivePlayer[];
};

export type QuantumRemoveTransaction = {
  userId: string;
  routeId: string;
  expectedPlayers?: readonly QuantumActivePlayer[];
};

/**
 * Serializes roster-sensitive mutations and proves their result from a fresh
 * explicit route-list response. It never fragments a frame or updates roster
 * state optimistically from write success alone.
 */
export class QuantumRosterTransactionMachine {
  private readonly routeListReadDelayMs: number;
  private readonly releaseBeforeActivationDelayMs: number;
  private readonly activationSettleDelayMs: number;
  private readonly notificationTimeoutMs: number;
  private operationTail: Promise<void> = Promise.resolve();
  private currentState: QuantumRosterMachineState = { phase: 'idle' };

  constructor(
    private readonly transport: QuantumRosterTransport,
    private readonly time: QuantumTime = SYSTEM_QUANTUM_TIME,
    options: QuantumRosterMachineOptions = {},
  ) {
    this.routeListReadDelayMs = options.routeListReadDelayMs ?? 50;
    this.releaseBeforeActivationDelayMs = options.releaseBeforeActivationDelayMs ?? 50;
    this.activationSettleDelayMs = options.activationSettleDelayMs ?? 250;
    this.notificationTimeoutMs = options.notificationTimeoutMs ?? 3_000;
  }

  get state(): QuantumRosterMachineState {
    return this.currentState;
  }

  refresh(): Promise<QuantumRosterSnapshot> {
    return this.enqueue('refresh', () => this.requestFreshRoster('refresh'));
  }

  async activate(request: QuantumActivateTransaction): Promise<QuantumRosterSnapshot> {
    if (quantumUuidsEqual(request.userId, QUANTUM_ZERO_UUID)) {
      throw new TypeError('Quantum roster mutations require a non-zero user UUID');
    }

    const releaseFrame = encodeQuantumTurnOffUser(request.userId);
    const activationFrame = encodeQuantumActivation(request);
    this.assertFrameFits(releaseFrame);
    this.assertFrameFits(activationFrame);

    return this.enqueue('activate', async () => {
      const before = await this.requestFreshRoster('activate');
      this.assertExpectedRoster(before, request.expectedPlayers);

      const otherPlayers = before.players.filter((player) => !quantumUuidsEqual(player.userId, request.userId));
      const isReplacingExistingUser = otherPlayers.length !== before.players.length;
      if (!isReplacingExistingUser && before.players.length >= QUANTUM_MAX_PLAYERS) {
        throw new QuantumRosterTransactionError('board-full', 'Quantum controller already has four active players');
      }
      if (otherPlayers.some((player) => player.color === (request.color ?? 0x00ffff))) {
        throw new QuantumRosterTransactionError('color-in-use', 'Quantum controller color is already occupied');
      }

      this.transition('mutating', 'activate');
      await this.writeAtomic(releaseFrame);
      await this.time.sleep(this.releaseBeforeActivationDelayMs);
      await this.writeAtomic(activationFrame);
      await this.time.sleep(this.activationSettleDelayMs);

      const after = await this.requestFreshRoster('activate');
      const afterOtherPlayers = after.players.filter((player) => !quantumUuidsEqual(player.userId, request.userId));
      const targetPlayers = after.players.filter((player) => quantumUuidsEqual(player.userId, request.userId));
      const targetConfirmed =
        targetPlayers.length === 1 &&
        quantumUuidsEqual(targetPlayers[0].routeId, request.routeId) &&
        targetPlayers[0].color === (request.color ?? 0x00ffff);

      if (!targetConfirmed || !quantumRostersEqual(otherPlayers, afterOtherPlayers)) {
        throw new QuantumRosterTransactionError(
          'confirmation-failed',
          'Quantum activation did not preserve and confirm the expected roster',
        );
      }

      return after;
    });
  }

  async remove(request: QuantumRemoveTransaction): Promise<QuantumRosterSnapshot> {
    if (quantumUuidsEqual(request.userId, QUANTUM_ZERO_UUID)) {
      throw new TypeError('Quantum roster mutations require a non-zero user UUID');
    }

    const removalFrame = encodeQuantumTurnOffUser(request.userId);
    this.assertFrameFits(removalFrame);

    return this.enqueue('remove', async () => {
      const before = await this.requestFreshRoster('remove');
      this.assertExpectedRoster(before, request.expectedPlayers);

      const target = before.players.find((player) => quantumUuidsEqual(player.userId, request.userId));
      if (!target) return before;
      if (!quantumUuidsEqual(target.routeId, request.routeId)) {
        throw new QuantumRosterTransactionError(
          'target-route-changed',
          'Quantum user now owns a different route than the requested removal target',
        );
      }

      const otherPlayers = before.players.filter((player) => !quantumUuidsEqual(player.userId, request.userId));
      this.transition('mutating', 'remove');
      await this.writeAtomic(removalFrame);
      const after = await this.requestFreshRoster('remove');
      const targetStillPresent = after.players.some((player) => quantumUuidsEqual(player.userId, request.userId));

      if (targetStillPresent || !quantumRostersEqual(otherPlayers, after.players)) {
        throw new QuantumRosterTransactionError(
          'confirmation-failed',
          'Quantum removal did not preserve and confirm the expected roster',
        );
      }

      return after;
    });
  }

  private enqueue<T>(operation: QuantumRosterOperation, task: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(async () => {
      try {
        return await task();
      } catch (error) {
        const transactionError =
          error instanceof QuantumRosterTransactionError
            ? error
            : new QuantumRosterTransactionError('transport-failed', 'Quantum transport operation failed', {
                cause: error,
              });
        this.currentState = {
          phase: 'failed',
          operation,
          snapshot: this.currentState.snapshot,
          lastError: transactionError.code,
        };
        throw transactionError;
      }
    });

    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async requestFreshRoster(operation: QuantumRosterOperation): Promise<QuantumRosterSnapshot> {
    this.transition('refreshing', operation);
    await this.writeAtomic(encodeQuantumRosterRequest());
    await this.time.sleep(this.routeListReadDelayMs);

    let readFailure: unknown;
    try {
      const readFrame = await this.transport.readState();
      const roster = this.rosterFromFrame(readFrame);
      if (roster) return this.acceptRoster(roster);
    } catch (error) {
      if (error instanceof QuantumRosterTransactionError) throw error;
      readFailure = error;
    }

    if (this.transport.waitForNotification) {
      try {
        const notification = await this.transport.waitForNotification(this.notificationTimeoutMs);
        const roster = this.rosterFromFrame(notification);
        if (roster) return this.acceptRoster(roster);
      } catch (error) {
        if (error instanceof QuantumRosterTransactionError) throw error;
        readFailure = error;
      }
    }

    throw new QuantumRosterTransactionError('roster-unavailable', 'No fresh Quantum route-list response was received', {
      cause: readFailure,
    });
  }

  private rosterFromFrame(frame: Uint8Array | undefined): QuantumActivePlayer[] | undefined {
    if (!frame) return undefined;
    const broadcast = parseQuantumBroadcast(frame);
    if (broadcast?.type === 'controller-error') {
      throw new QuantumRosterTransactionError(
        'controller-refused',
        `Quantum controller refused the command: ${broadcast.failure}`,
        { controllerFailure: broadcast.failure },
      );
    }
    if (broadcast?.type !== 'roster' || broadcast.command !== QuantumCommand.REQUEST_USER_ROUTE_LIST) {
      return undefined;
    }
    return broadcast.players;
  }

  private acceptRoster(players: readonly QuantumActivePlayer[]): QuantumRosterSnapshot {
    const snapshot: QuantumRosterSnapshot = {
      revision: (this.currentState.snapshot?.revision ?? 0) + 1,
      observedAtMs: this.time.now(),
      players: players.map((player) => ({ ...player })),
    };
    this.currentState = { phase: 'live', snapshot };
    return snapshot;
  }

  private assertExpectedRoster(
    actual: QuantumRosterSnapshot,
    expectedPlayers: readonly QuantumActivePlayer[] | undefined,
  ): void {
    if (expectedPlayers && !quantumRostersEqual(actual.players, expectedPlayers)) {
      throw new QuantumRosterTransactionError('roster-changed', 'Quantum roster changed after caller preflight');
    }
  }

  private assertFrameFits(frame: Uint8Array): void {
    if (
      !Number.isInteger(this.transport.maximumWriteBytes) ||
      this.transport.maximumWriteBytes <= 0 ||
      frame.length > this.transport.maximumWriteBytes
    ) {
      throw new QuantumRosterTransactionError(
        'frame-too-large',
        `Quantum frame needs ${frame.length} atomic bytes; transport allows ${this.transport.maximumWriteBytes}`,
      );
    }
  }

  private async writeAtomic(frame: Uint8Array): Promise<void> {
    this.assertFrameFits(frame);
    await this.transport.writeWithResponse(frame.slice());
  }

  private transition(phase: QuantumRosterPhase, operation: QuantumRosterOperation): void {
    this.currentState = { phase, operation, snapshot: this.currentState.snapshot };
  }
}
