import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BleError,
  BleSessionRuntime,
  type BleCharacteristic,
  type BleScheduler,
  type BleTransport,
  type BleWriteMode,
} from '@boardsesh/ble-core';
import {
  QUANTUM_BOARD_MODELS,
  QUANTUM_GATT_OPERATION_TIMEOUT_MS,
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_MIN_WRITE_BYTES,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  QuantumControllerModelMismatchError,
  QuantumNotificationInbox,
  createQuantumBleProtocol,
  createQuantumRosterTransport,
  decodeQuantumUuid,
  encodeQuantumActivation,
  encodeQuantumRosterRequest,
  encodeQuantumTurnOffAll,
  encodeQuantumTurnOffRoute,
  encodeQuantumTurnOnAll,
  encodeQuantumUuid,
  quantumFrameHasValidCrc,
  quantumUuidsEqual,
  type QuantumActivePlayer,
  type QuantumBleProtocolOptions,
  type QuantumBoardModel,
  type QuantumBoardModelId,
  type QuantumTime,
} from '../index';

const { ACTIVATE_WALL, BOARD_SWIPE, REQUEST_USER_ROUTE_LIST, TURN_OFF_ALL, TURN_OFF_BY_USER } = QuantumCommand;
const ROUTE_ONE = '00112233-4455-6677-8899-aabbccddeeff';
const ROUTE_TWO = '10213243-5465-7687-98a9-bacbdcedfe0f';
const ROUTE_THREE = '20314253-6475-8697-a8b9-cadbecfd0e1f';
const USER_ONE = '11111111-2222-4333-8444-555555555555';
const USER_TWO = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const FOREIGN_LAYER: QuantumActivePlayer = {
  routeId: ROUTE_TWO,
  userId: USER_TWO,
  color: 0xff00ff,
  remainingSeconds: 600,
};
/** USER_ONE's current layer, replaced by ROUTE_ONE in the replace-flow tests. */
const OWN_LAYER: QuantumActivePlayer = {
  routeId: ROUTE_THREE,
  userId: USER_ONE,
  color: 0x00ff00,
  remainingSeconds: 600,
};
const NEW_LAYER: QuantumActivePlayer = {
  routeId: ROUTE_ONE,
  userId: USER_ONE,
  color: 0x00ff00,
  remainingSeconds: 0xffff,
};

function rosterFrame(players: readonly QuantumActivePlayer[], command: number = REQUEST_USER_ROUTE_LIST): Uint8Array {
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

function diodes(count: number): number[] {
  return Array.from({ length: count }, (_, diodeIndex) => diodeIndex + 1);
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

/** A BleScheduler whose timers fire only when the test advances it. */
class ManualScheduler implements BleScheduler {
  private current = 0;
  private readonly timers = new Set<{ dueAt: number; delay: number; callback: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(callback: () => void, milliseconds: number): () => void {
    const timer = { dueAt: this.current + milliseconds, delay: milliseconds, callback };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }

  pendingDelays(): number[] {
    return [...this.timers].map((timer) => timer.delay);
  }

  advance(milliseconds: number): void {
    this.current += milliseconds;
    for (const timer of [...this.timers]) {
      if (timer.dueAt > this.current) continue;
      this.timers.delete(timer);
      timer.callback();
    }
  }
}

type WriteHandler = (frame: Uint8Array, apply: () => void) => Promise<void> | void;
type ReadHandler = (value: Uint8Array) => Promise<Uint8Array> | Uint8Array;

type FixtureOptions = {
  deviceName?: string;
  maxWriteBytes?: number;
  model?: QuantumBoardModel;
  metadata?: Uint8Array;
  metadataRead?: () => Promise<Uint8Array>;
  players?: readonly QuantumActivePlayer[];
  missingServices?: readonly string[];
  lookupError?: Error;
  writeWithResponse?: boolean;
  writeWithoutResponse?: boolean;
};

/** A scripted controller: 0x47 publishes the roster on FFF4, 0x41/0x44 add or move a layer, 0x43 removes one. */
function fixture(options: FixtureOptions = {}) {
  const roster: QuantumActivePlayer[] = (options.players ?? []).map((layer) => ({ ...layer }));
  const writes: { frame: Uint8Array; mode: BleWriteMode }[] = [];
  const lookups: string[] = [];
  let stateReads = 0;
  let metadataReads = 0;
  let stateValue: Uint8Array = new Uint8Array(0);
  let notifyListener: ((bytes: Uint8Array) => void) | undefined;
  let notifyError: ((error: unknown) => void) | undefined;
  let dropListener: ((error?: unknown) => void) | undefined;
  let writeHandler: WriteHandler = (_frame, apply) => apply();
  let readHandler: ReadHandler = (value) => value;
  const unsubscribe = vi.fn();
  const disconnect = vi.fn(async () => {});

  const apply = (frame: Uint8Array) => {
    if (frame[1] === REQUEST_USER_ROUTE_LIST) {
      stateValue = rosterFrame(roster);
    } else if (frame[1] === ACTIVATE_WALL || frame[1] === BOARD_SWIPE) {
      const layer: QuantumActivePlayer = {
        routeId: decodeQuantumUuid(frame, 2),
        userId: decodeQuantumUuid(frame, 18),
        color: (frame[34] << 16) | (frame[35] << 8) | frame[36],
        remainingSeconds: (frame[37] << 8) | frame[38],
      };
      const ownedIndex = roster.findIndex((existing) => quantumUuidsEqual(existing.userId, layer.userId));
      if (ownedIndex >= 0) roster[ownedIndex] = layer;
      else roster.push(layer);
    } else if (frame[1] === TURN_OFF_BY_USER) {
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
  const stateCharacteristic: BleCharacteristic & Required<Pick<BleCharacteristic, 'read'>> = {
    ...readOnly,
    async read() {
      stateReads += 1;
      return readHandler(stateValue.slice());
    },
  };
  const metadataCharacteristic: BleCharacteristic = {
    ...readOnly,
    async read() {
      metadataReads += 1;
      if (options.metadataRead) return options.metadataRead();
      return options.metadata ?? metadataFor(options.model ?? QUANTUM_BOARD_MODELS.xl);
    },
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
    writeCharacteristic,
    stateCharacteristic,
    get stateReads() {
      return stateReads;
    },
    get metadataReads() {
      return metadataReads;
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

type Radio = ReturnType<typeof fixture>;

function open(radio: Radio, options: Partial<QuantumBleProtocolOptions> = {}) {
  return createQuantumBleProtocol({ expectedModelId: 'xl', time: new ManualQuantumTime(), ...options }).open(
    radio.transport,
  );
}

/** Abort the caller's signal from inside the controller, right after it applies `command`. */
function abortAfter(radio: Radio, command: number, controller: AbortController) {
  radio.setWriteHandler((frame, apply) => {
    apply();
    if (frame[1] === command) controller.abort();
  });
}

afterEach(() => vi.useRealTimers());

describe('Quantum BLE discovery and open', () => {
  it('declares name-based discovery with both services available to the transport', () => {
    expect(createQuantumBleProtocol({ expectedModelId: 'xl' }).discovery).toEqual({
      serviceUuids: [],
      optionalServiceUuids: [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID],
      namePrefixes: ['QB_', 'QBB_'],
    });
  });

  it('requires a known controller model before a protocol can be created', () => {
    // @ts-expect-error The model check cannot be skipped: expectedModelId is required.
    expect(() => createQuantumBleProtocol({})).toThrow(RangeError);
    expect(() => createQuantumBleProtocol({ expectedModelId: 'home' as string as QuantumBoardModelId })).toThrow(
      RangeError,
    );
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

  it('treats missing or invalid FFF5 metadata as a model mismatch', async () => {
    const radio = fixture({ metadata: new Uint8Array(40) });
    const opening = open(radio, { expectedModelId: 'm' });
    await expect(opening).rejects.toBeInstanceOf(QuantumControllerModelMismatchError);
    await expect(opening).rejects.toMatchObject({ selectedModelId: 'm', controllerModelId: undefined });
    expect(radio.subscribe).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalledOnce();
  });

  it('refuses unknown names and payload limits below one single-diode activation', async () => {
    expect(encodeQuantumActivation({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1] })).toHaveLength(
      QUANTUM_MIN_WRITE_BYTES,
    );

    const foreignName = fixture({ deviceName: 'eWalls_gym_a1b2c3d4e5f6' });
    await expect(open(foreignName)).rejects.toMatchObject({ code: 'unsupported' });
    expect(foreignName.lookups).toEqual([]);
    expect(foreignName.disconnect).toHaveBeenCalledOnce();

    const invalidLimit = fixture({ maxWriteBytes: 0 });
    await expect(open(invalidLimit)).rejects.toMatchObject({ code: 'invalid-input' });
    expect(invalidLimit.lookups).toEqual([]);

    const defaultMtu = fixture({ maxWriteBytes: 20 });
    await expect(open(defaultMtu)).rejects.toMatchObject({ code: 'unsupported' });
    expect(defaultMtu.lookups).toEqual([]);
    expect(defaultMtu.disconnect).toHaveBeenCalledOnce();

    const smallest = fixture({ maxWriteBytes: QUANTUM_MIN_WRITE_BYTES });
    await (await open(smallest)).disconnect();
  });

  it('reports a caller cancelling the connect as cancelled, not as a lost connection', async () => {
    const metadataGate = deferred<Uint8Array>();
    const radio = fixture({ metadataRead: () => metadataGate.promise });
    const controller = new AbortController();

    const opening = createQuantumBleProtocol({ expectedModelId: 'xl' }).open(radio.transport, {
      signal: controller.signal,
    });
    const cancelled = expect(opening).rejects.toMatchObject({ code: 'cancelled', name: 'AbortError' });
    await vi.waitFor(() => expect(radio.metadataReads).toBe(1));
    controller.abort();
    await cancelled;
    metadataGate.resolve(metadataFor(QUANTUM_BOARD_MODELS.xl));

    expect(radio.subscribe).not.toHaveBeenCalled();
    expect(radio.disconnect).toHaveBeenCalledOnce();

    const alreadyCancelled = fixture();
    const abortedFirst = new AbortController();
    abortedFirst.abort();
    await expect(
      createQuantumBleProtocol({ expectedModelId: 'xl' }).open(alreadyCancelled.transport, {
        signal: abortedFirst.signal,
      }),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(alreadyCancelled.lookups).toEqual([]);
    expect(alreadyCancelled.disconnect).toHaveBeenCalledOnce();
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

    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL, REQUEST_USER_ROUTE_LIST]);
    expect(radio.writes[1].frame).toEqual(encodeQuantumActivation(activation));
    expect(radio.writes.every(({ frame, mode }) => mode === 'with-response' && quantumFrameHasValidCrc(frame))).toBe(
      true,
    );
    expect(activated.players).toEqual([FOREIGN_LAYER, { ...NEW_LAYER, remainingSeconds: 60 }]);
    expect(time.sleeps).toEqual([50, 250, 50]);

    const removed = await session.removeLayer({ userId: USER_ONE, routeId: ROUTE_ONE });

    expect(radio.commands().slice(3)).toEqual([REQUEST_USER_ROUTE_LIST, TURN_OFF_BY_USER, REQUEST_USER_ROUTE_LIST]);
    expect(removed.players).toEqual([FOREIGN_LAYER]);
    expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { revision: 4 } });
    expect(radio.commands()).not.toContain(TURN_OFF_ALL);
    await session.disconnect();
  });

  it('sends a QBB_ replacement, its release and every read-back without response', async () => {
    const radio = fixture({ deviceName: 'QBB_AABBCCDDEEFF', players: [OWN_LAYER] });
    const session = await open(radio);

    const replaced = await session.activateLayer({
      routeId: ROUTE_ONE,
      userId: USER_ONE,
      diodeIds: [1],
      color: 0x00ff00,
      expectedOwnedRouteId: ROUTE_THREE,
    });

    expect(radio.commands()).toEqual([
      REQUEST_USER_ROUTE_LIST,
      TURN_OFF_BY_USER,
      REQUEST_USER_ROUTE_LIST,
      ACTIVATE_WALL,
      REQUEST_USER_ROUTE_LIST,
    ]);
    expect(radio.writes.every(({ mode }) => mode === 'without-response')).toBe(true);
    expect(replaced.players).toEqual([NEW_LAYER]);
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

  it('refuses a mutation when the wall changed since the caller looked', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);

    await expect(
      session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], expectedPlayers: [] }),
    ).rejects.toMatchObject({ code: 'roster-changed' });

    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST]);
    expect(session.rosterState).toMatchObject({ phase: 'failed', lastError: 'roster-changed' });
    await session.disconnect();
  });

  it('refuses a frame longer than one write and never splits it', async () => {
    const radio = fixture({ maxWriteBytes: 100 });
    const session = await open(radio);

    // 43 + 2 × 29 = 101 bytes.
    await expect(
      session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: diodes(29) }),
    ).rejects.toMatchObject({ code: 'frame-too-large' });
    expect(radio.writes).toEqual([]);

    // 43 + 2 × 28 = 99 bytes: one write, never chunked.
    await session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: diodes(28) });
    expect(radio.writes.map(({ frame }) => frame.length)).toEqual([5, 99, 5]);
    await session.disconnect();
  });

  it('surfaces a buffered FFF1 refusal of the activation instead of confirming it', async () => {
    const radio = fixture();
    const session = await open(radio);
    radio.setWriteHandler((frame, apply) => {
      if (frame[1] === ACTIVATE_WALL) radio.notify(Uint8Array.of(1, 0xc1, 7));
      else apply();
    });

    await expect(
      session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 }),
    ).rejects.toMatchObject({ code: 'controller-refused', controllerFailure: 'color-taken' });
    // The refusal arrived before any read-back, so the session re-reads the wall.
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL, REQUEST_USER_ROUTE_LIST]);
    expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { revision: 2, players: [] } });
    await session.disconnect();
  });

  it('runs a queued transaction after a failure that kept the link', async () => {
    const radio = fixture();
    const session = await open(radio);
    radio.setWriteHandler((frame, apply) => {
      if (frame[1] === ACTIVATE_WALL) radio.notify(Uint8Array.of(1, 0xc1, 7));
      else apply();
    });

    const refused = session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 });
    const queued = session.refreshRoster();

    await expect(refused).rejects.toMatchObject({ code: 'controller-refused' });
    await expect(queued).resolves.toMatchObject({ revision: 3, players: [] });
    // Activation, its re-read, then the queued refresh.
    expect(radio.commands()).toEqual([
      REQUEST_USER_ROUTE_LIST,
      ACTIVATE_WALL,
      REQUEST_USER_ROUTE_LIST,
      REQUEST_USER_ROUTE_LIST,
    ]);
    expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { players: [] } });
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('falls back to a fresh FFF1 roster when FFF4 still holds another command', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    radio.setReadHandler(() => rosterFrame([FOREIGN_LAYER], ACTIVATE_WALL));
    radio.setWriteHandler((frame, apply) => {
      apply();
      if (frame[1] === REQUEST_USER_ROUTE_LIST) radio.notify(rosterFrame(radio.roster));
    });

    await expect(session.refreshRoster()).resolves.toMatchObject({ players: [FOREIGN_LAYER] });
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('ignores an FFF1 roster that arrived before the 0x47 request', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    radio.notify(rosterFrame([{ ...FOREIGN_LAYER, routeId: ROUTE_ONE }]));
    radio.setReadHandler(() => rosterFrame([], ACTIVATE_WALL));
    radio.setWriteHandler((frame, apply) => {
      apply();
      if (frame[1] === REQUEST_USER_ROUTE_LIST) radio.notify(rosterFrame(radio.roster));
    });

    await expect(session.refreshRoster()).resolves.toMatchObject({ players: [FOREIGN_LAYER] });
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

    radio.notify(rosterFrame([FOREIGN_LAYER], ACTIVATE_WALL));

    expect(seen).toEqual(['roster']);
    await session.disconnect();
  });

  it('refuses every command layer transactions never send, with no write', async () => {
    const radio = fixture();
    const runtime = new BleSessionRuntime(radio.transport);
    const rosterTransport = createQuantumRosterTransport({
      write: radio.writeCharacteristic,
      state: radio.stateCharacteristic,
      writeMode: 'with-response',
      maximumWriteBytes: 244,
      inbox: new QuantumNotificationInbox(),
      runtime,
    });

    const wallWideFrames = [
      encodeQuantumTurnOffAll(),
      encodeQuantumTurnOffRoute(ROUTE_ONE),
      encodeQuantumTurnOnAll(0xffffff),
    ];
    for (const frame of wallWideFrames) {
      await expect(rosterTransport.writeFrame(frame)).rejects.toMatchObject({ code: 'unsupported' });
    }
    expect(radio.writes).toEqual([]);

    await rosterTransport.writeFrame(encodeQuantumRosterRequest());
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST]);
    await runtime.disconnect();
  });
});

describe('Quantum BLE cancellation', () => {
  it('sends no mutation when the caller aborts before it is written', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    const readGate = deferred<void>();
    radio.setReadHandler(async (value) => {
      await readGate.promise;
      return value;
    });
    const controller = new AbortController();

    const activating = session.activateLayer(
      { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 },
      controller.signal,
    );
    const cancelled = expect(activating).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(radio.stateReads).toBe(1));
    controller.abort();
    await cancelled;
    readGate.resolve();

    await vi.waitFor(() =>
      expect(session.rosterState).toMatchObject({ phase: 'failed', lastError: 'operation-cancelled' }),
    );
    // Wire: 0x47 only. The confirmed preflight roster is kept.
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST]);
    expect(session.rosterState.snapshot?.players).toEqual([FOREIGN_LAYER]);
    expect(radio.roster).toEqual([FOREIGN_LAYER]);

    radio.setReadHandler((value) => value);
    await expect(session.refreshRoster()).resolves.toMatchObject({ players: [FOREIGN_LAYER] });
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('still reads back an activation the caller aborted after it was written', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    const controller = new AbortController();
    abortAfter(radio, ACTIVATE_WALL, controller);

    const activating = session.activateLayer(
      { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 },
      controller.signal,
    );
    await expect(activating).rejects.toMatchObject({ code: 'cancelled' });

    // Wire: 0x47, 0x41, then the read-back 0x47. The state shows the lit layer.
    await vi.waitFor(() => expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { revision: 2 } }));
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL, REQUEST_USER_ROUTE_LIST]);
    expect(session.rosterState.snapshot?.players).toEqual([FOREIGN_LAYER, NEW_LAYER]);
    await session.disconnect();
  });

  it('confirms the release and skips the activation when a replacement is aborted between 0x43 and 0x41', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER, OWN_LAYER] });
    const session = await open(radio);
    const controller = new AbortController();
    abortAfter(radio, TURN_OFF_BY_USER, controller);

    const replacing = session.activateLayer(
      { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00, expectedOwnedRouteId: ROUTE_THREE },
      controller.signal,
    );
    await expect(replacing).rejects.toMatchObject({ code: 'cancelled' });

    await vi.waitFor(() =>
      expect(session.rosterState).toMatchObject({ phase: 'failed', lastError: 'operation-cancelled' }),
    );
    // Wire: 0x47, 0x43, the release read-back 0x47, and no 0x41. The state shows the layer gone.
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, TURN_OFF_BY_USER, REQUEST_USER_ROUTE_LIST]);
    expect(session.rosterState.snapshot?.players).toEqual([FOREIGN_LAYER]);
    expect(radio.roster).toEqual([FOREIGN_LAYER]);
    await session.disconnect();
  });

  it('starts the next queued transaction from the roster confirmed after an aborted one', async () => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    const controller = new AbortController();
    abortAfter(radio, ACTIVATE_WALL, controller);

    const activating = session.activateLayer(
      { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 },
      controller.signal,
    );
    await expect(activating).rejects.toMatchObject({ code: 'cancelled' });
    const removed = await session.removeLayer({ userId: USER_ONE, routeId: ROUTE_ONE });

    // The removal saw the aborted call's layer on its own fresh roster, so it sent 0x43.
    expect(radio.commands()).toEqual([
      REQUEST_USER_ROUTE_LIST,
      ACTIVATE_WALL,
      REQUEST_USER_ROUTE_LIST,
      REQUEST_USER_ROUTE_LIST,
      TURN_OFF_BY_USER,
      REQUEST_USER_ROUTE_LIST,
    ]);
    expect(removed.players).toEqual([FOREIGN_LAYER]);
    expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { revision: 4, players: [FOREIGN_LAYER] } });
    await session.disconnect();
  });

  it.each([
    {
      wait: 'the preflight',
      heldRosterRequest: 1,
      frames: [REQUEST_USER_ROUTE_LIST],
      state: { phase: 'failed', lastError: 'operation-cancelled', snapshot: { revision: 1 } },
      players: [],
    },
    {
      wait: 'the read-back',
      heldRosterRequest: 2,
      frames: [REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL, REQUEST_USER_ROUTE_LIST],
      state: { phase: 'live', snapshot: { revision: 2 } },
      players: [NEW_LAYER],
    },
  ])(
    'keeps waiting for FFF1 when the caller aborts during $wait notification wait',
    async ({ heldRosterRequest, frames, state, players }) => {
      const radio = fixture();
      const session = await open(radio);
      const controller = new AbortController();
      let rosterRequests = 0;
      // FFF4 never holds a fresh 0x47 roster, so every roster comes from FFF1.
      radio.setReadHandler(() => rosterFrame(radio.roster, ACTIVATE_WALL));
      radio.setWriteHandler((frame, apply) => {
        apply();
        if (frame[1] !== REQUEST_USER_ROUTE_LIST) return;
        rosterRequests += 1;
        if (rosterRequests !== heldRosterRequest) radio.notify(rosterFrame(radio.roster));
      });

      const activating = session.activateLayer(
        { routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 },
        controller.signal,
      );
      const cancelled = expect(activating).rejects.toMatchObject({ code: 'cancelled' });
      await vi.waitFor(() => expect(radio.stateReads).toBe(heldRosterRequest));
      controller.abort();
      await cancelled;
      radio.notify(rosterFrame(radio.roster));

      await vi.waitFor(() => expect(session.rosterState).toMatchObject(state));
      expect(radio.commands()).toEqual(frames);
      expect(session.rosterState.snapshot?.players).toEqual(players);
      expect(radio.disconnect).not.toHaveBeenCalled();
      await session.disconnect();
    },
  );
});

describe('Quantum BLE mutations that fail before their read-back', () => {
  it.each([
    { outcome: 'applied it', applied: true, players: [FOREIGN_LAYER, NEW_LAYER] },
    { outcome: 'did not apply it', applied: false, players: [FOREIGN_LAYER] },
  ])('re-reads the wall when an 0x41 write fails and the controller $outcome', async ({ applied, players }) => {
    const radio = fixture({ players: [FOREIGN_LAYER] });
    const session = await open(radio);
    const platformError = new Error('GATT error 133');
    radio.setWriteHandler((frame, apply) => {
      if (frame[1] !== ACTIVATE_WALL) return apply();
      if (applied) apply();
      throw platformError;
    });

    // The call keeps its own error; the re-read finishes before it rejects.
    await expect(
      session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 }),
    ).rejects.toMatchObject({ code: 'transport-failed', cause: platformError });

    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL, REQUEST_USER_ROUTE_LIST]);
    expect(radio.stateReads).toBe(2);
    expect(session.rosterState).toMatchObject({ phase: 'live', snapshot: { revision: 2 } });
    expect(session.rosterState.snapshot?.players).toEqual(players);
    expect(radio.roster).toEqual(players);
    expect(radio.disconnect).not.toHaveBeenCalled();
    await session.disconnect();
  });

  it('re-reads before a queued call runs, so it starts from what the wall holds', async () => {
    const radio = fixture();
    const session = await open(radio);
    radio.setWriteHandler((frame, apply) => {
      apply();
      if (frame[1] === ACTIVATE_WALL) throw new Error('GATT error 133');
    });

    const failing = session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 });
    const queued = session.removeLayer({ userId: USER_ONE, routeId: ROUTE_ONE });

    await expect(failing).rejects.toMatchObject({ code: 'transport-failed' });
    await expect(queued).resolves.toMatchObject({ players: [] });
    expect(radio.commands()).toEqual([
      REQUEST_USER_ROUTE_LIST,
      ACTIVATE_WALL,
      REQUEST_USER_ROUTE_LIST,
      REQUEST_USER_ROUTE_LIST,
      TURN_OFF_BY_USER,
      REQUEST_USER_ROUTE_LIST,
    ]);
    await session.disconnect();
  });

  it('reads nothing more when the failed mutation retired the link', async () => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await open(radio);
    radio.setWriteHandler((frame, apply) => {
      if (frame[1] === ACTIVATE_WALL) return new Promise<void>(() => {});
      return apply();
    });

    const activating = session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1] });
    const timedOut = expect(activating).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(QUANTUM_GATT_OPERATION_TIMEOUT_MS);
    await timedOut;

    await vi.waitFor(() => expect(radio.disconnect).toHaveBeenCalledOnce());
    // No re-read on a retired link: rosterState keeps the last confirmed (now stale) roster.
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL]);
    expect(session.rosterState).toMatchObject({ phase: 'failed', snapshot: { revision: 1, players: [] } });
  });
});

describe('Quantum BLE link failures and timers', () => {
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
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST]);
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
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST]);
    expect(closed).toHaveBeenCalledOnce();
  });

  it('retires the link when neither FFF4 nor FFF1 yields a fresh roster within three seconds', async () => {
    vi.useFakeTimers();
    const radio = fixture();
    const session = await open(radio);
    radio.setReadHandler(() => rosterFrame([], ACTIVATE_WALL));

    const refreshing = session.refreshRoster();
    const timedOut = expect(refreshing).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(3_000);
    await timedOut;

    await vi.waitFor(() => expect(radio.disconnect).toHaveBeenCalledOnce());
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST]);
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

  it('runs the 50 ms and 250 ms transaction delays on the injected scheduler', async () => {
    const radio = fixture();
    const scheduler = new ManualScheduler();
    const session = await createQuantumBleProtocol({ expectedModelId: 'xl' }).open(radio.transport, { scheduler });

    const activating = session.activateLayer({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 });
    await vi.waitFor(() => expect(scheduler.pendingDelays()).toEqual([50]));
    // The FFF4 read waits for the injected scheduler, not a global timer.
    expect(radio.stateReads).toBe(0);
    scheduler.advance(50);
    await vi.waitFor(() => expect(scheduler.pendingDelays()).toEqual([250]));
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL]);
    scheduler.advance(250);
    await vi.waitFor(() => expect(scheduler.pendingDelays()).toEqual([50]));
    scheduler.advance(50);

    await expect(activating).resolves.toMatchObject({ observedAtMs: 350, players: [NEW_LAYER] });
    expect(radio.commands()).toEqual([REQUEST_USER_ROUTE_LIST, ACTIVATE_WALL, REQUEST_USER_ROUTE_LIST]);
    await session.disconnect();
  });
});
