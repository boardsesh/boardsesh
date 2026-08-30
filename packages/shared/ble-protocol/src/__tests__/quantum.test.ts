import { describe, expect, it } from 'vitest';
import {
  QUANTUM_BOARD_MODELS,
  QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS,
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_MAX_DIODE_IDS,
  QUANTUM_MAX_PLAYERS,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_MODELS,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  QuantumRosterTransactionError,
  QuantumRosterTransactionMachine,
  decodeQuantumUuid,
  encodeQuantumActivation,
  encodeQuantumRosterRequest,
  encodeQuantumTurnOffAll,
  encodeQuantumTurnOffRoute,
  encodeQuantumTurnOffUser,
  encodeQuantumTurnOnAll,
  encodeQuantumUuid,
  parseQuantumBroadcast,
  parseQuantumControllerMetadata,
  parseQuantumDeviceSerial,
  quantumBroadcastLength,
  quantumCrc16Modbus,
  quantumFrameFitsMtu,
  quantumFrameHasValidCrc,
  quantumRostersEqual,
  type QuantumActivePlayer,
  type QuantumRosterTransport,
  type QuantumTime,
} from '../quantum';

const ROUTE_ONE = '00112233-4455-6677-8899-aabbccddeeff';
const ROUTE_TWO = '10213243-5465-7687-98a9-bacbdcedfe0f';
const USER_ONE = '11111111-2222-4333-8444-555555555555';
const USER_TWO = '66666666-7777-4888-8999-aaaaaaaaaaaa';

function player(routeId: string, userId: string, color: number, remainingSeconds: number = 90): QuantumActivePlayer {
  return { routeId, userId, color, remainingSeconds };
}

function rosterFrame(
  players: readonly QuantumActivePlayer[],
  command:
    | typeof QuantumCommand.ACTIVATE_WALL
    | typeof QuantumCommand.BOARD_SWIPE
    | typeof QuantumCommand.REQUEST_USER_ROUTE_LIST = QuantumCommand.REQUEST_USER_ROUTE_LIST,
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

type ScriptedRead = Uint8Array | undefined | Error;

class ScriptedQuantumTransport implements QuantumRosterTransport {
  readonly writes: Uint8Array[] = [];
  readonly notificationTimeouts: number[] = [];

  constructor(
    readonly maximumWriteBytes: number,
    private readonly reads: ScriptedRead[],
    private readonly notifications: ScriptedRead[] = [],
  ) {}

  async writeWithResponse(frame: Uint8Array): Promise<void> {
    this.writes.push(frame.slice());
  }

  async readState(): Promise<Uint8Array | undefined> {
    const scriptedRead = this.reads.shift();
    if (scriptedRead instanceof Error) throw scriptedRead;
    return scriptedRead;
  }

  async waitForNotification(timeoutMs: number): Promise<Uint8Array | undefined> {
    this.notificationTimeouts.push(timeoutMs);
    const scriptedNotification = this.notifications.shift();
    if (scriptedNotification instanceof Error) throw scriptedNotification;
    return scriptedNotification;
  }
}

class ManualQuantumTime implements QuantumTime {
  readonly sleeps: number[] = [];

  constructor(private timestamp: number = 10_000) {}

  now(): number {
    return this.timestamp;
  }

  async sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    this.timestamp += milliseconds;
  }
}

describe('Quantum BLE identity constants', () => {
  it('pins both services and every protocol characteristic', () => {
    expect(QUANTUM_SERVICE_UUID).toBe('0000ffe0-0000-1000-8000-00805f9b34fb');
    expect(QUANTUM_LEGACY_SERVICE_UUID).toBe('0000fff0-0000-1000-8000-00805f9b34fb');
    expect(QUANTUM_NOTIFY_CHARACTERISTIC_UUID).toContain('fff1');
    expect(QUANTUM_WRITE_CHARACTERISTIC_UUID).toContain('fff2');
    expect(QUANTUM_STATE_CHARACTERISTIC_UUID).toContain('fff4');
    expect(QUANTUM_METADATA_CHARACTERISTIC_UUID).toContain('fff5');
  });

  it('recognizes only the observed case-sensitive name families with a 12-hex serial', () => {
    expect(parseQuantumDeviceSerial('QB_020000000001')).toBe('020000000001');
    expect(parseQuantumDeviceSerial('QBB_AABBCCDDEEFF')).toBe('AABBCCDDEEFF');
    expect(parseQuantumDeviceSerial('eWalls_gym_a1b2c3d4e5f6')).toBe('a1b2c3d4e5f6');
    expect(parseQuantumDeviceSerial('qb_020000000001')).toBeUndefined();
    expect(parseQuantumDeviceSerial('QB_not-a-controller')).toBeUndefined();
  });

  it('declares all five model/type/dimension tuples', () => {
    expect(QUANTUM_MODELS).toHaveLength(5);
    expect(QUANTUM_BOARD_MODELS).toEqual({
      xl: { id: 'xl', displayName: 'XL', controllerType: 0, columns: 15, rows: 15 },
      l: { id: 'l', displayName: 'L', controllerType: 4, columns: 15, rows: 12 },
      m: { id: 'm', displayName: 'M', controllerType: 1, columns: 12, rows: 12 },
      s: { id: 's', displayName: 'S Fitness', controllerType: 2, columns: 8, rows: 12 },
      belay: { id: 'belay', displayName: 'Belay Board', controllerType: 3, columns: 8, rows: 12 },
    });
  });
});

describe('Quantum command encoding', () => {
  it('matches the public MODBUS CRC check value', () => {
    expect(quantumCrc16Modbus(new TextEncoder().encode('123456789'))).toBe(0x4b37);
  });

  it('emits exact route-list and global-clear frames', () => {
    expect([...encodeQuantumRosterRequest()]).toEqual([0x01, 0x47, 0x00, 0xf0, 0x13]);
    expect([...encodeQuantumTurnOffAll()]).toEqual([0x01, 0x45, 0x00, 0x01, 0x00, 0x00, 0xc5, 0x9d]);
  });

  it('keeps UUID byte order stable in scoped removal commands', () => {
    const frame = encodeQuantumTurnOffUser(USER_ONE);
    expect(frame[0]).toBe(1);
    expect(frame[1]).toBe(QuantumCommand.TURN_OFF_BY_USER);
    expect(decodeQuantumUuid(frame, 2)).toBe(USER_ONE);
    expect(frame[18]).toBe(0);
    expect(quantumFrameHasValidCrc(frame)).toBe(true);

    const routeFrame = encodeQuantumTurnOffRoute(ROUTE_ONE);
    expect(routeFrame[1]).toBe(QuantumCommand.TURN_OFF_BY_ROUTE);
    expect(decodeQuantumUuid(routeFrame, 2)).toBe(ROUTE_ONE);
  });

  it('lays out one atomic activation with big-endian duration and diode ids', () => {
    const frame = encodeQuantumActivation({
      routeId: ROUTE_ONE,
      userId: USER_ONE,
      diodeIds: [1, 0x1234, 0xffff],
      color: 0x12abef,
      animation: 7,
    });

    expect(frame[1]).toBe(QuantumCommand.ACTIVATE_WALL);
    expect(decodeQuantumUuid(frame, 2)).toBe(ROUTE_ONE);
    expect(decodeQuantumUuid(frame, 18)).toBe(USER_ONE);
    expect(frame.slice(34, 37)).toEqual(Uint8Array.of(0x12, 0xab, 0xef));
    expect(frame.slice(37, 39)).toEqual(Uint8Array.of(0xff, 0xff));
    expect(frame[39]).toBe(7);
    expect(frame[40]).toBe(6);
    expect(frame.slice(41, 47)).toEqual(Uint8Array.of(0x00, 0x01, 0x12, 0x34, 0xff, 0xff));
    expect(quantumFrameHasValidCrc(frame)).toBe(true);
  });

  it('caps an activation at 92 diodes before transport', () => {
    const largestFrame = encodeQuantumActivation({
      routeId: ROUTE_ONE,
      userId: USER_ONE,
      diodeIds: Array.from({ length: QUANTUM_MAX_DIODE_IDS }, (_, diodeIndex) => diodeIndex),
    });
    expect(largestFrame).toHaveLength(227);
    expect(quantumFrameFitsMtu(largestFrame, 230)).toBe(true);
    expect(quantumFrameFitsMtu(largestFrame, 229)).toBe(false);

    expect(() =>
      encodeQuantumActivation({
        routeId: ROUTE_ONE,
        userId: USER_ONE,
        diodeIds: Array.from({ length: QUANTUM_MAX_DIODE_IDS + 1 }, (_, diodeIndex) => diodeIndex),
      }),
    ).toThrow('limited to 92 diodes');
  });

  it('rejects invalid UUIDs, diode addresses, colors, and empty plans', () => {
    expect(() => encodeQuantumUuid('not-a-uuid')).toThrow('32 hexadecimal digits');
    expect(() => encodeQuantumUuid('00112233-44556677-8899aabb-ccddeeff')).toThrow('32 hexadecimal digits');
    expect(() => encodeQuantumActivation({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [] })).toThrow(
      'at least one diode',
    );
    expect(() => encodeQuantumActivation({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [65_536] })).toThrow(
      'diode id',
    );
    expect(() => encodeQuantumActivation({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: -1 })).toThrow(
      'Quantum color',
    );
  });

  it('encodes the all-on payload without weakening its CRC', () => {
    const frame = encodeQuantumTurnOnAll(0xabcdef, 300);
    expect(frame[1]).toBe(QuantumCommand.TURN_ON_ALL);
    expect(frame.slice(2, 7)).toEqual(Uint8Array.of(0xab, 0xcd, 0xef, 0x01, 0x2c));
    expect(quantumFrameHasValidCrc(frame)).toBe(true);
  });
});

describe('Quantum controller parsing', () => {
  it('decodes an exact four-player route list without a command CRC', () => {
    const players = [
      player(ROUTE_ONE, USER_ONE, 0x00ff00, 1),
      player(ROUTE_TWO, USER_TWO, 0x00ffff, 2),
      player('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb', 0xff00ff, 3),
      player('bbbbbbbb-cccc-4ddd-8eee-ffffffffffff', 'cccccccc-2222-4333-8444-dddddddddddd', 0xffff00, 4),
    ];
    const frame = rosterFrame(players);

    expect(quantumBroadcastLength(frame)).toBe(4 + QUANTUM_MAX_PLAYERS * 37);
    expect(parseQuantumBroadcast(frame)).toEqual({
      type: 'roster',
      command: QuantumCommand.REQUEST_USER_ROUTE_LIST,
      players,
    });
  });

  it('rejects malformed, oversized, reserved-byte, and unknown frames', () => {
    const valid = rosterFrame([player(ROUTE_ONE, USER_ONE, 0x00ff00)]);
    expect(parseQuantumBroadcast(valid.slice(0, -1))).toBeUndefined();
    expect(parseQuantumBroadcast(Uint8Array.from([...valid, 0]))).toBeUndefined();

    const badReserved = valid.slice();
    badReserved[3] = 1;
    expect(parseQuantumBroadcast(badReserved)).toBeUndefined();
    expect(parseQuantumBroadcast(Uint8Array.of(1, QuantumCommand.REQUEST_USER_ROUTE_LIST, 5, 0))).toBeUndefined();
    expect(parseQuantumBroadcast(Uint8Array.of(0, QuantumCommand.TURN_ON_ALL, 0xff))).toBeUndefined();
    expect(parseQuantumBroadcast(Uint8Array.of(1, 0x55, 0))).toBeUndefined();
  });

  it('decodes scoped removal, clear, all-on, and controller failures', () => {
    const removal = new Uint8Array(21);
    removal.set([1, QuantumCommand.TURN_OFF_BY_USER]);
    removal.set(encodeQuantumUuid(USER_ONE), 2);
    expect(parseQuantumBroadcast(removal)).toEqual({
      type: 'user-removed',
      command: QuantumCommand.TURN_OFF_BY_USER,
      userId: USER_ONE,
    });
    expect(parseQuantumBroadcast(Uint8Array.of(1, QuantumCommand.TURN_OFF_ALL, 0, 0, 0, 0))).toEqual({
      type: 'wall-cleared',
      command: QuantumCommand.TURN_OFF_ALL,
    });
    expect(parseQuantumBroadcast(Uint8Array.of(1, QuantumCommand.TURN_ON_ALL, 0xff))).toEqual({
      type: 'wall-lit',
      command: QuantumCommand.TURN_ON_ALL,
      color: 0xffffff,
    });
    expect(parseQuantumBroadcast(Uint8Array.of(1, 0xc1, 7))).toEqual({
      type: 'controller-error',
      failedCommand: QuantumCommand.ACTIVATE_WALL,
      code: 7,
      failure: 'color-taken',
    });
  });

  it('accepts metadata only when type and dimensions agree exactly', () => {
    for (const model of QUANTUM_MODELS) {
      const metadata = new Uint8Array(41);
      metadata[34] = model.controllerType;
      metadata[35] = (model.columns >>> 8) & 0xff;
      metadata[36] = model.columns & 0xff;
      metadata[37] = (model.rows >>> 8) & 0xff;
      metadata[38] = model.rows & 0xff;
      expect(parseQuantumControllerMetadata(metadata)?.model.id).toBe(model.id);
    }

    expect(parseQuantumControllerMetadata(new Uint8Array(40))).toBeUndefined();
    const unknown = new Uint8Array(41);
    unknown[34] = 99;
    expect(parseQuantumControllerMetadata(unknown)).toBeUndefined();
    const mismatched = new Uint8Array(41);
    mismatched[34] = QUANTUM_BOARD_MODELS.xl.controllerType;
    mismatched[36] = 14;
    mismatched[38] = 15;
    expect(parseQuantumControllerMetadata(mismatched)).toBeUndefined();
  });
});

describe('Quantum roster transaction machine', () => {
  it('releases, activates, and confirms while preserving every foreign player', async () => {
    const foreign = player(ROUTE_TWO, USER_TWO, 0xff00ff, 20);
    const confirmed = player(ROUTE_ONE, USER_ONE, 0x00ff00, QUANTUM_DEFAULT_ROUTE_DURATION_SECONDS);
    const transport = new ScriptedQuantumTransport(244, [rosterFrame([foreign]), rosterFrame([confirmed, foreign])]);
    const time = new ManualQuantumTime();
    const machine = new QuantumRosterTransactionMachine(transport, time);

    const result = await machine.activate({
      routeId: ROUTE_ONE,
      userId: USER_ONE,
      diodeIds: [1, 200, 65_535],
      color: 0x00ff00,
      expectedPlayers: [{ ...foreign, remainingSeconds: 999 }],
    });

    expect(transport.writes.map((frame) => frame[1])).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.TURN_OFF_BY_USER,
      QuantumCommand.ACTIVATE_WALL,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
    expect(transport.writes.every((frame) => quantumFrameHasValidCrc(frame))).toBe(true);
    expect(time.sleeps).toEqual([50, 50, 250, 50]);
    expect(result.revision).toBe(2);
    expect(machine.state).toMatchObject({ phase: 'live', snapshot: { revision: 2 } });
  });

  it('uses a notification only when the state read is not a fresh request roster', async () => {
    const active = player(ROUTE_ONE, USER_ONE, 0x00ffff);
    const staleActivationSnapshot = rosterFrame([active], QuantumCommand.ACTIVATE_WALL);
    const transport = new ScriptedQuantumTransport(244, [staleActivationSnapshot], [rosterFrame([active])]);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    const snapshot = await machine.refresh();

    expect(snapshot.players).toEqual([active]);
    expect(transport.notificationTimeouts).toEqual([3_000]);
  });

  it('stops before mutation when the caller roster or capacity preflight is stale', async () => {
    const foreign = player(ROUTE_TWO, USER_TWO, 0xff00ff);
    const changedTransport = new ScriptedQuantumTransport(244, [rosterFrame([foreign])]);
    const changedMachine = new QuantumRosterTransactionMachine(changedTransport, new ManualQuantumTime());

    await expect(
      changedMachine.activate({
        routeId: ROUTE_ONE,
        userId: USER_ONE,
        diodeIds: [1],
        expectedPlayers: [],
      }),
    ).rejects.toMatchObject({ code: 'roster-changed' });
    expect(changedTransport.writes.map((frame) => frame[1])).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST]);

    const fullRoster = Array.from({ length: QUANTUM_MAX_PLAYERS }, (_, playerIndex) =>
      player(
        `${playerIndex}0000000-0000-4000-8000-000000000000`,
        `${playerIndex}1111111-1111-4111-8111-111111111111`,
        playerIndex + 1,
      ),
    );
    const fullTransport = new ScriptedQuantumTransport(244, [rosterFrame(fullRoster)]);
    const fullMachine = new QuantumRosterTransactionMachine(fullTransport, new ManualQuantumTime());
    await expect(
      fullMachine.activate({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x123456 }),
    ).rejects.toMatchObject({ code: 'board-full' });
    expect(fullTransport.writes.map((frame) => frame[1])).toEqual([QuantumCommand.REQUEST_USER_ROUTE_LIST]);
  });

  it('fails confirmation if activating a target removes another player', async () => {
    const foreign = player(ROUTE_TWO, USER_TWO, 0xff00ff);
    const target = player(ROUTE_ONE, USER_ONE, 0x00ff00);
    const transport = new ScriptedQuantumTransport(244, [rosterFrame([foreign]), rosterFrame([target])]);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    await expect(
      machine.activate({ routeId: ROUTE_ONE, userId: USER_ONE, diodeIds: [1], color: 0x00ff00 }),
    ).rejects.toMatchObject({ code: 'confirmation-failed' });
    expect(machine.state).toMatchObject({ phase: 'failed', lastError: 'confirmation-failed' });
  });

  it('removes exactly one user and requires all other players to survive', async () => {
    const target = player(ROUTE_ONE, USER_ONE, 0x00ff00);
    const foreign = player(ROUTE_TWO, USER_TWO, 0xff00ff);
    const transport = new ScriptedQuantumTransport(244, [rosterFrame([target, foreign]), rosterFrame([foreign])]);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    const result = await machine.remove({ userId: USER_ONE, routeId: ROUTE_ONE });

    expect(result.players).toEqual([foreign]);
    expect(transport.writes.map((frame) => frame[1])).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.TURN_OFF_BY_USER,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
  });

  it('refuses a frame that cannot fit one acknowledged write before touching transport', async () => {
    const transport = new ScriptedQuantumTransport(226, []);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    await expect(
      machine.activate({
        routeId: ROUTE_ONE,
        userId: USER_ONE,
        diodeIds: Array.from({ length: QUANTUM_MAX_DIODE_IDS }, (_, diodeIndex) => diodeIndex),
      }),
    ).rejects.toMatchObject({ code: 'frame-too-large' });
    expect(transport.writes).toEqual([]);
    expect(machine.state.phase).toBe('idle');
  });

  it('rejects a compact zero user UUID before touching transport', async () => {
    const transport = new ScriptedQuantumTransport(244, []);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    await expect(
      machine.activate({
        routeId: ROUTE_ONE,
        userId: '00000000000000000000000000000000',
        diodeIds: [1],
      }),
    ).rejects.toThrow('non-zero user UUID');
    expect(transport.writes).toEqual([]);
  });

  it('surfaces controller refusal without relabeling it as a read timeout', async () => {
    const transport = new ScriptedQuantumTransport(244, [Uint8Array.of(1, 0xc7, 9)]);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    await expect(machine.refresh()).rejects.toMatchObject({
      code: 'controller-refused',
      controllerFailure: 'board-full',
    });
    expect(machine.state).toMatchObject({ phase: 'failed', lastError: 'controller-refused' });
  });

  it('serializes overlapping refreshes and advances authoritative revisions', async () => {
    const transport = new ScriptedQuantumTransport(244, [rosterFrame([]), rosterFrame([])]);
    const machine = new QuantumRosterTransactionMachine(transport, new ManualQuantumTime());

    const [first, second] = await Promise.all([machine.refresh(), machine.refresh()]);

    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
    expect(transport.writes.map((frame) => frame[1])).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
  });

  it('compares roster ownership independent of countdown and record order', () => {
    const first = [player(ROUTE_ONE, USER_ONE, 0x00ff00, 1), player(ROUTE_TWO, USER_TWO, 0xff00ff, 2)];
    const reordered = [player(ROUTE_TWO, USER_TWO, 0xff00ff, 900), player(ROUTE_ONE, USER_ONE, 0x00ff00, 800)];
    expect(quantumRostersEqual(first, reordered)).toBe(true);
    expect(
      quantumRostersEqual(first, [
        { ...first[0], routeId: ROUTE_ONE.replaceAll('-', ''), userId: USER_ONE.replaceAll('-', '') },
        first[1],
      ]),
    ).toBe(true);
    expect(quantumRostersEqual(first, [{ ...reordered[0], color: 0xffff00 }, reordered[1]])).toBe(false);
  });

  it('uses the typed transaction error class for state-machine failures', () => {
    const error = new QuantumRosterTransactionError('roster-unavailable', 'missing');
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('QuantumRosterTransactionError');
  });
});
