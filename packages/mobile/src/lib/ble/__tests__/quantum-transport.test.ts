import { describe, expect, it, vi } from 'vitest';
import {
  QuantumCommand,
  encodeQuantumUuid,
  type QuantumActivePlayer,
  type QuantumBroadcast,
  type QuantumTime,
} from '@boardsesh/ble-protocol/quantum';
import {
  QuantumBoardController,
  QuantumBroadcastAssembler,
  QuantumNotificationInbox,
  type QuantumBluetoothTransport,
} from '../quantum-transport';

const ROUTE = '10000000-0000-4000-8000-000000000001';
const USER = '20000000-0000-4000-8000-000000000001';

function rosterFrame(players: readonly QuantumActivePlayer[]): Uint8Array {
  const frame = new Uint8Array(4 + players.length * 37);
  frame.set([1, QuantumCommand.REQUEST_USER_ROUTE_LIST, players.length, 0]);
  players.forEach((player, index) => {
    const offset = 4 + index * 37;
    frame.set(encodeQuantumUuid(player.routeId), offset);
    frame.set(encodeQuantumUuid(player.userId), offset + 16);
    frame[offset + 32] = (player.remainingSeconds >>> 8) & 0xff;
    frame[offset + 33] = player.remainingSeconds & 0xff;
    frame[offset + 34] = (player.color >>> 16) & 0xff;
    frame[offset + 35] = (player.color >>> 8) & 0xff;
    frame[offset + 36] = player.color & 0xff;
  });
  return frame;
}

const PLAYER: QuantumActivePlayer = {
  routeId: ROUTE,
  userId: USER,
  remainingSeconds: 120,
  color: 0x00ffff,
};

describe('QuantumBroadcastAssembler', () => {
  it('strictly reassembles a split FFF1 roster and drops leading garbage', () => {
    const assembler = new QuantumBroadcastAssembler();
    const frame = rosterFrame([PLAYER]);

    expect(assembler.push(Uint8Array.of(0xff, 0x00, ...frame.slice(0, 3)))).toEqual([]);
    const assembled = assembler.push(frame.slice(3));

    expect(assembled).toHaveLength(1);
    expect(assembled[0].frame).toEqual(frame);
    expect(assembled[0].broadcast).toEqual({
      type: 'roster',
      command: QuantumCommand.REQUEST_USER_ROUTE_LIST,
      players: [PLAYER],
    });
  });

  it('rejects a five-player header instead of buffering an unbounded frame', () => {
    const assembler = new QuantumBroadcastAssembler();
    expect(assembler.push(Uint8Array.of(1, QuantumCommand.REQUEST_USER_ROUTE_LIST, 5, 0))).toEqual([]);
    expect(assembler.push(Uint8Array.of(1, QuantumCommand.TURN_OFF_ALL, 0, 0, 0, 0))).toHaveLength(1);
  });
});

describe('QuantumNotificationInbox', () => {
  it('never satisfies a fresh route-list request with a stale notification', async () => {
    vi.useFakeTimers();
    try {
      const inbox = new QuantumNotificationInbox();
      const oldFrame = rosterFrame([]);
      const newFrame = rosterFrame([PLAYER]);
      inbox.push(oldFrame);
      inbox.markRosterRequest();

      const pending = inbox.waitForRoster(1_000);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      inbox.push(newFrame);
      await expect(pending).resolves.toEqual(newFrame);
    } finally {
      vi.useRealTimers();
    }
  });
});

class ScriptedTransport implements QuantumBluetoothTransport {
  readonly maximumWriteBytes = 509;
  readonly writes: Uint8Array[] = [];
  private readonly broadcastListeners = new Set<(broadcast: QuantumBroadcast) => void>();

  constructor(private readonly reads: Array<Uint8Array | undefined>) {}

  isAvailable(): Promise<boolean> {
    return Promise.resolve(true);
  }

  requestAndConnect(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }

  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  onDisconnect(): () => void {
    return () => {};
  }

  onBroadcast(listener: (broadcast: QuantumBroadcast) => void): () => void {
    this.broadcastListeners.add(listener);
    return () => this.broadcastListeners.delete(listener);
  }

  writeWithResponse(frame: Uint8Array): Promise<void> {
    this.writes.push(frame.slice());
    return Promise.resolve();
  }

  readState(): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.reads.shift());
  }
}

class InstantTime implements QuantumTime {
  readonly sleeps: number[] = [];

  now(): number {
    return 123;
  }

  sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    return Promise.resolve();
  }
}

describe('QuantumBoardController', () => {
  it('requires explicit confirmation and proves a global clear with readback', async () => {
    const transport = new ScriptedTransport([rosterFrame([PLAYER]), rosterFrame([])]);
    const time = new InstantTime();
    const controller = new QuantumBoardController(transport, { time });

    await expect(controller.clearAll({ confirmed: false })).rejects.toThrow('explicit confirmation');
    const snapshot = await controller.clearAll({ confirmed: true });

    expect(snapshot.players).toEqual([]);
    expect(transport.writes.map((frame) => frame[1])).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.TURN_OFF_ALL,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
    expect(time.sleeps).toContain(250);
  });
});
