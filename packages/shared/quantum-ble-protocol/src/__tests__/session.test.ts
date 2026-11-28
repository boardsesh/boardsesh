import { afterEach, describe, expect, it, vi } from 'vitest';
import { BleError, type BleCharacteristic, type BleTransport, type BleWriteMode } from '@boardsesh/ble-core';
import {
  QUANTUM_BOARD_MODELS,
  QUANTUM_GATT_OPERATION_TIMEOUT_MS,
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  QuantumControllerModelMismatchError,
  createQuantumBleProtocol,
  decodeQuantumUuid,
  encodeQuantumActivation,
  encodeQuantumUuid,
  quantumFrameHasValidCrc,
  quantumUuidsEqual,
  type QuantumActivePlayer,
  type QuantumBleSessionOptions,
  type QuantumBoardModel,
  type QuantumTime,
} from '../index';

const ROUTE_ONE = '00112233-4455-6677-8899-aabbccddeeff';
const ROUTE_TWO = '10213243-5465-7687-98a9-bacbdcedfe0f';
const USER_ONE = '11111111-2222-4333-8444-555555555555';
const USER_TWO = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const FOREIGN_LAYER: QuantumActivePlayer = {
  routeId: ROUTE_TWO,
  userId: USER_TWO,
  color: 0xff00ff,
  remainingSeconds: 600,
};

function rosterFrame(
  players: readonly QuantumActivePlayer[],
  command: number = QuantumCommand.REQUEST_USER_ROUTE_LIST,
): Uint8Array {
  const frame = new Uint8Array(4 + players.length * 37);
  frame.set([1, command, players.length, 0]);
  players.forEach((activePlayer, playerIndex) => {
    const offset = 4 + playerIndex * 37;
    frame.set(encodeQuantumUuid(activePlayer.routeId), offset);
    frame.set(encodeQuantumUuid(activePlayer.userId), offset + 16);
    frame[offset + 32] = (activePlayer.remainingSeconds >>> 8) & 0xff;
    frame[offset + 33] = activePlayer.remainingSeconds & 0xff;
    frame[offset + 34] = (activePlayer.color >>> 16) & 0xff;
    frame[offset + 35] = (activePlayer.color >>> 8) & 0xff;
    frame[offset + 36] = activePlayer.color & 0xff;
  });
  return frame;
}

function metadataFor(model: QuantumBoardModel): Uint8Array {
  const metadata = new Uint8Array(41);
  metadata[34] = model.controllerType;
  metadata[35] = (model.columns >>> 8) & 0xff;
  metadata[36] = model.columns & 0xff;
  metadata[37] = (model.rows >>> 8) & 0xff;
  metadata[38] = model.rows & 0xff;
  return metadata;
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

class ManualQuantumTime implements QuantumTime {
  readonly sleeps: number[] = [];
  private timestamp = 10_000;

  monotonicNow(): number {
    return this.timestamp;
  }

  now(): number {
    return this.timestamp;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.timestamp += milliseconds;
  }
}

type WriteHandler = (frame: Uint8Array, apply: () => void) => Promise<void> | void;
type ReadHandler = (value: Uint8Array) => Promise<Uint8Array> | Uint8Array;

type FixtureOptions = {
  deviceName?: string;
  maxWriteBytes?: number;
  model?: QuantumBoardModel;
  metadata?: Uint8Array;
  players?: readonly QuantumActivePlayer[];
  missingServices?: readonly string[];
  lookupError?: Error;
  writeWithResponse?: boolean;
  writeWithoutResponse?: boolean;
};

/** A scripted controller: 0x47 publishes the roster on FFF4, 0x41 adds or moves a layer, 0x43 removes one. */
function fixture(options: FixtureOptions = {}) {
  const roster: QuantumActivePlayer[] = (options.players ?? []).map((layer) => ({ ...layer }));
  const writes: { frame: Uint8Array; mode: BleWriteMode }[] = [];
  const lookups: string[] = [];
  let stateReads = 0;
  let stateValue: Uint8Array = new Uint8Array(0);
  let notifyListener: ((bytes: Uint8Array) => void) | undefined;
  let notifyError: ((error: unknown) => void) | undefined;
  let dropListener: ((error?: unknown) => void) | undefined;
  let writeHandler: WriteHandler = (_frame, apply) => apply();
  let readHandler: ReadHandler = (value) => value;
  const unsubscribe = vi.fn();
  const disconnect = vi.fn(async () => {});

  const apply = (frame: Uint8Array) => {
    if (frame[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST) {
      stateValue = rosterFrame(roster);
    } else if (frame[1] === QuantumCommand.ACTIVATE_WALL) {
      const layer: QuantumActivePlayer = {
        routeId: decodeQuantumUuid(frame, 2),
        userId: decodeQuantumUuid(frame, 18),
        color: (frame[34] << 16) | (frame[35] << 8) | frame[36],
        remainingSeconds: (frame[37] << 8) | frame[38],
      };
      const ownedIndex = roster.findIndex((existing) => quantumUuidsEqual(existing.userId, layer.userId));
      if (ownedIndex >= 0) roster[ownedIndex] = layer;
      else roster.push(layer);
    } else if (frame[1] === QuantumCommand.TURN_OFF_BY_USER) {
      const userId = decodeQuantumUuid(frame, 2);
      const survivors = roster.filter((existing) => !quantumUuidsEqual(existing.userId, userId));
      roster.splice(0, roster.length, ...survivors);
    }
  };

  const writeCharacteristic: BleCharacteristic = {
    writeWithResponse: options.writeWithResponse ?? true,
    writeWithoutResponse: options.writeWithoutResponse ?? true,
    async write(bytes, mode) {
      writes.push({ frame: bytes.slice(), mode });
      await writeHandler(bytes, () => apply(bytes));
    },
  };
  const readOnly = {
    writeWithResponse: false,
    writeWithoutResponse: false,
    write: async () => {
      throw new Error('Read-only characteristic');
    },
  };
  const stateCharacteristic: BleCharacteristic = {
    ...readOnly,
    async read() {
      stateReads += 1;
      return readHandler(stateValue.slice());
    },
  };
  const metadataCharacteristic: BleCharacteristic = {
    ...readOnly,
    read: async () => options.metadata ?? metadataFor(options.model ?? QUANTUM_BOARD_MODELS.xl),
  };
  const subscribe = vi.fn<NonNullable<BleCharacteristic['subscribe']>>(async (listener, onError) => {
    notifyListener = listener;
    notifyError = onError;
    return unsubscribe;
  });
  const notifyCharacteristic: BleCharacteristic = { ...readOnly, subscribe };
  const characteristics = new Map<string, BleCharacteristic>([
    [QUANTUM_NOTIFY_CHARACTERISTIC_UUID, notifyCharacteristic],
    [QUANTUM_WRITE_CHARACTERISTIC_UUID, writeCharacteristic],
    [QUANTUM_STATE_CHARACTERISTIC_UUID, stateCharacteristic],
    [QUANTUM_METADATA_CHARACTERISTIC_UUID, metadataCharacteristic],
  ]);

  const transport: BleTransport = {
    deviceId: 'platform-device-id',
    deviceName: options.deviceName ?? 'QB_020000000001',
    maxWriteBytes: options.maxWriteBytes ?? 244,
    async getCharacteristic(target) {
      lookups.push(`${target.serviceUuid}/${target.characteristicUuid}`);
      if (options.lookupError) throw options.lookupError;
      const characteristic = characteristics.get(target.characteristicUuid);
      if (options.missingServices?.includes(target.serviceUuid) || !characteristic) {
        throw new BleError('service-missing');
      }
      return characteristic;
    },
    onDisconnect(listener) {
      dropListener = listener;
      return () => {
        dropListener = undefined;
      };
    },
    disconnect,
  };

  return {
    transport,
    roster,
    writes,
    lookups,
    subscribe,
    unsubscribe,
    disconnect,
    get stateReads() {
      return stateReads;
    },
    commands: () => writes.map(({ frame }) => frame[1]),
    notify: (bytes: Uint8Array) => notifyListener?.(bytes),
    failNotifications: (error: unknown) => notifyError?.(error),
    drop: () => dropListener?.(),
    setWriteHandler: (handler: WriteHandler) => {
      writeHandler = handler;
    },
    setReadHandler: (handler: ReadHandler) => {
      readHandler = handler;
    },
  };
}

function open(radio: ReturnType<typeof fixture>, options: Omit<QuantumBleSessionOptions, 'signal' | 'scheduler'> = {}) {
  return createQuantumBleProtocol({ time: new ManualQuantumTime(), ...options }).open(radio.transport);
}

afterEach(() => vi.useRealTimers());

describe('Quantum BLE discovery and open', () => {
  it('declares name-based discovery with both services available to the transport', () => {
    expect(createQuantumBleProtocol().discovery).toEqual({
      serviceUuids: [],
      optionalServiceUuids: [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID],
      namePrefixes: ['QB_', 'QBB_'],
    });
  });

  it('opens without writing: FFF1/FFF2/FFF4/FFF5 in order, FFF5 model check, FFF1 enabled', async () => {
    const radio = fixture();
    const session = await open(radio, { expectedModelId: 'xl' });

    expect(radio.lookups).toEqual(
      [
        QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
        QUANTUM_WRITE_CHARACTERISTIC_UUID,
        QUANTUM_STATE_CHARACTERISTIC_UUID,
        QUANTUM_METADATA_CHARACTERISTIC_UUID,
      ].map((characteristicUuid) => `${QUANTUM_SERVICE_UUID}/${characteristicUuid}`),
    );
    expect(radio.subscribe).toHaveBeenCalledOnce();
    expect(radio.writes).toEqual([]);
    expect(session.controller.model.id).toBe('xl');
    expect(session.serial).toBe('020000000001');
    expect(session.writeMode).toBe('with-response');
    expect(session.capabilities).toEqual({ rgb: false, roles: [], readback: true });
    expect(session.rosterState).toEqual({ phase: 'idle' });

    await session.disconnect();
    expect(radio.unsubscribe).toHaveBeenCalledOnce();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('falls back to the FFE0 service only when FFF0 reports service-missing', async () => {
    const radio = fixture({ missingServices: [QUANTUM_SERVICE_UUID] });
    const session = await open(radio);
    expect(radio.lookups.filter((lookup) => lookup.startsWith(QUANTUM_SERVICE_UUID))).toHaveLength(1);
    expect(radio.lookups.slice(1).every((lookup) => lookup.startsWith(QUANTUM_LEGACY_SERVICE_UUID))).toBe(true);
    expect(radio.lookups).toHaveLength(5);
    await session.disconnect();
  });

  it('propagates any other lookup failure without falling back, and closes the link', async () => {
    const radio = fixture({ lookupError: new Error('GATT busy') });
    await expect(open(radio)).rejects.toThrow('GATT busy');
    expect(radio.lookups).toHaveLength(1);
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it.each([
    ['QB_020000000001', 'with-response'],
    ['QBB_AABBCCDDEEFF', 'without-response'],
  ] as const)('%s controllers receive %s writes', async (deviceName, writeMode) => {
    const radio = fixture({ deviceName });
    const session = await open(radio);
    expect(session.writeMode).toBe(writeMode);
    await session.refreshRoster();
    expect(radio.writes.map(({ mode }) => mode)).toEqual([writeMode]);
    await session.disconnect();
  });

  it.each([
    { deviceName: 'QB_020000000001', writeWithResponse: false },
    { deviceName: 'QBB_AABBCCDDEEFF', writeWithoutResponse: false },
  ])('refuses an FFF2 without the write mode $deviceName requires', async (options) => {
    const radio = fixture(options);
    await expect(open(radio)).rejects.toMatchObject({ code: 'unsupported' });
    expect(radio.subscribe).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('refuses a different controller model before subscribing or writing', async () => {
    const radio = fixture({ model: QUANTUM_BOARD_MODELS.m });
    const opening = open(radio, { expectedModelId: 'xl' });
    await expect(opening).rejects.toBeInstanceOf(QuantumControllerModelMismatchError);
    await expect(opening).rejects.toMatchObject({ selectedModelId: 'xl', controllerModelId: 'm' });
    expect(radio.subscribe).not.toHaveBeenCalled();
    expect(radio.writes).toEqual([]);
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('refuses invalid metadata, unknown names and invalid payload limits', async () => {
    const invalidMetadata = fixture({ metadata: new Uint8Array(40) });
    await expect(open(invalidMetadata)).rejects.toMatchObject({ code: 'unsupported' });
    expect(invalidMetadata.subscribe).not.toHaveBeenCalled();

    const foreignName = fixture({ deviceName: 'eWalls_gym_a1b2c3d4e5f6' });
    await expect(open(foreignName)).rejects.toMatchObject({ code: 'unsupported' });
    expect(foreignName.lookups).toEqual([]);
    expect(foreignName.disconnect).toHaveBeenCalledOnce();

    const invalidLimit = fixture({ maxWriteBytes: 0 });
    await expect(open(invalidLimit)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(invalidLimit.lookups).toEqual([]);
  });
});

describe('Quantum BLE layer sessions', () => {
  it('activates, confirms and removes one layer through fresh roster reads, preserving the other layer', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const time = new ManualQuantumTime();
    const session = await open(radio, { time });
    const activation = {
      routeId: ROUTE_ONE,
      userId: USER_ONE,
      diodeIds: [1, 258],
      color: 0x00ff00,
      durationSeconds: 60,
    };

    const activated = await session.activateLayer(activation);

    expect(radio.commands()).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.ACTIVATE_WALL,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
    expect(radio.writes[1].frame).toEqual(encodeQuantumActivation(activation));
    expect(radio.writes.every(({ frame, mode }) => mode === 'with-response' && quantumFrameHasValidCrc(frame))).toBe(
      true,
    );
    expect(activated.players).toEqual([
      FOREIGN_LAYER,
      { routeId: ROUTE_ONE, userId: USER_ONE, color: 0x00ff00, remainingSeconds: 60 },
    ]);
    expect(time.sleeps).toEqual([50, 250, 50]);

    const removed = await session.removeLayer({ userId: USER_ONE, routeId: ROUTE_ONE });

    expect(radio.commands().slice(3)).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.TURN_OFF_BY_USER,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
    expect(removed.players).toEqual([FOREIGN_LAYER]);
    expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { revision: 4 } });
    expect(radio.commands()).not.toContain(QuantumCommand.TURN_OFF_ALL);
    await session.disconnect();
  });

  it('rejects show() and clear() as unsupported without touching the wall', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);

    await expect(session.show([{ index: 1, color: [0, 255, 0] }])).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.show([{ index: 1, role: 'start' }])).rejects.toMatchObject({ code: 'unsupported' });
    await expect(session.clear()).rejects.toMatchObject({ code: 'unsupported' });

    expect(radio.writes).toEqual([]);
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('snapshots a layer request at submission', async () => {
    const radio = fixture();
    const session = await open(radio);
    const diodeIds = [1, 2];
    const request = { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds, color: 0x00ff00 };

    const activating = session.activateLayer(request);
    diodeIds[0] = 99;
    request.routeId = ROUTE_TWO;
    request.color = 0xffffff;
    await activating;

    expect(radio.writes[1].frame).toEqual(
      encodeQuantumActivation({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1, 2], color: 0x00ff00 }),
    );
    await session.disconnect();
  });

  it('surfaces a buffered FFF1 refusal of the activation instead of confirming it', async () => {
    const radio = fixture();
    const session = await open(radio);
    radio.setWriteHandler((frame, apply) => {
      if (frame[1] === QuantumCommand.ACTIVATE_WALL) radio.notify(Uint8Array.of(1, 0xc1, 7));
      else apply();
    });

    await expect(
      session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 }),
    ).rejects.toMatchObject({ code: 'controller-refused', controllerFailure: 'color-taken' });
    expect(radio.commands()).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST, QuantumCommand.ACTIVATE_WALL]);
    await session.disconnect();
  });

  it('falls back to a fresh FFF1 roster when FFF4 still holds another command', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    radio.setReadHandler(() => rosterFrame([FOREIGN_LAYER], QuantumCommand.ACTIVATE_WALL));
    radio.setWriteHandler((frame, apply) => {
      apply();
      if (frame[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST) radio.notify(rosterFrame(radio.roster));
    });

    await expect(session.refreshRoster()).resolves.toMatchObject({ players: [FOREIGN_LAYER] });
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('isolates a throwing broadcast observer from the others', async () => {
    const radio = fixture();
    const session = await open(radio);
    const seen: string[] = [];
    session.onBroadcast(() => {
      throw new Error('observer failed');
    });
    session.onBroadcast((broadcast) => seen.push(broadcast.type));

    radio.notify(rosterFrame([FOREIGN_LAYER], QuantumCommand.ACTIVATE_WALL));

    expect(seen).toEqual(['roster']);
    await session.disconnect();
  });

  it('stops a cancelled transaction before its next physical mutation and stays usable', async () => {
    const radio = fixture();
    const session = await open(radio);
    const gate = deferred<void>();
    radio.setReadHandler(async (value) => {
      await gate.promise;
      return value;
    });
    const controller = new AbortController();

    const activating = session.activateLayer(
      { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1] },
      controller.signal,
    );
    const cancelled = expect(activating).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(radio.stateReads).toBe(1));
    controller.abort();
    await cancelled;
    gate.resolve();

    await vi.waitFor(() =>
      expect(session.rosterState).toMatchObject({ phase: 'failed', lastError: 'operation-cancelled' }),
    );
    expect(radio.commands()).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST]);
    radio.setReadHandler((value) => value);
    await expect(session.refreshRoster()).resolves.toMatchObject({ players: [] });
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('rejects active and queued work on disconnect mid-transaction and sends nothing more', async () => {
    const radio = fixture();
    const session = await open(radio);
    const closed = vi.fn();
    session.onDisconnect(closed);
    const gate = deferred<void>();
    radio.setReadHandler(async (value) => {
      await gate.promise;
      return value;
    });

    const activating = session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1] });
    const queued = session.refreshRoster();
    const failures = Promise.all([
      expect(activating).rejects.toMatchObject({ code: 'disconnected' }),
      expect(queued).rejects.toMatchObject({ code: 'disconnected' }),
    ]);
    await vi.waitFor(() => expect(radio.stateReads).toBe(1));
    radio.drop();
    await failures;
    gate.resolve();

    await vi.waitFor(() => expect(session.rosterState.phase).toBe('failed'));
    expect(radio.commands()).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST]);
    expect(closed).toHaveBeenCalledOnce();
    expect(radio.unsubscribe).toHaveBeenCalledOnce();
    expect(radio.disconnect).toHaveBeenCalledOnce();
    await expect(session.refreshRoster()).rejects.toMatchObject({ code: 'disconnected' });
  });

  it.each([
    ['a stalled FFF2 write', 'write'],
    ['a stalled FFF4 read', 'read'],
  ] as const)('retires the link after %s and never sends the next frame', async (_label, stalled) => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await open(radio);
    const closed = vi.fn();
    session.onDisconnect(closed);
    if (stalled === 'write') radio.setWriteHandler(() => new Promise<void>(() => {}));
    else radio.setReadHandler(() => new Promise<Uint8Array>(() => {}));

    const activating = session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1] });
    const timedOut = expect(activating).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(QUANTUM_GATT_OPERATION_TIMEOUT_MS);
    await timedOut;

    await vi.waitFor(() => expect(radio.disconnect).toHaveBeenCalledOnce());
    expect(radio.commands()).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('retires the link when neither FFF4 nor FFF1 yields a fresh roster within three seconds', async () => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await open(radio);
    radio.setReadHandler(() => rosterFrame([], QuantumCommand.ACTIVATE_WALL));

    const refreshing = session.refreshRoster();
    const timedOut = expect(refreshing).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(3_000);
    await timedOut;

    await vi.waitFor(() => expect(radio.disconnect).toHaveBeenCalledOnce());
    expect(radio.commands()).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST]);
  });

  it('closes the session when FFF1 notifications fail', async () => {
    const radio = fixture();
    const session = await open(radio);
    const closed = vi.fn();
    session.onDisconnect(closed);

    radio.failNotifications(new Error('notifications lost'));

    await vi.waitFor(() => expect(radio.disconnect).toHaveBeenCalledOnce());
    expect(closed).toHaveBeenCalledOnce();
    await expect(session.refreshRoster()).rejects.toMatchObject({ code: 'disconnected' });
  });
});
