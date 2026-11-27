import { describe, expect, it, vi } from 'vitest';
import {
  QuantumCommand,
  encodeQuantumUuid,
  type QuantumActivePlayer,
  type QuantumBroadcast,
  type QuantumTime,
} from '@boardsesh/ble-protocol/quantum';
import { QuantumBoardController, QuantumNotificationInbox, type QuantumBluetoothTransport } from '../quantum-transport';

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

describe('QuantumNotificationInbox', () => {
  it('keeps a scoped mutation refusal even when it precedes the roster request', () => {
    const inbox = new QuantumNotificationInbox();
    const releaseRefusal = Uint8Array.of(1, QuantumCommand.TURN_OFF_BY_USER | 0x80, 254);
    inbox.push(releaseRefusal);
    inbox.markMutation();
    expect(inbox.getMutationFailure(QuantumCommand.TURN_OFF_BY_USER)).toBeUndefined();
    inbox.push(releaseRefusal);
    inbox.markRosterRequest();
    expect(inbox.getMutationFailure(QuantumCommand.TURN_OFF_BY_USER)).toBe('ack-timeout');
    expect(inbox.getMutationFailure(QuantumCommand.ACTIVATE_WALL)).toBeUndefined();
  });

  it('consumes a full oversized roster without dispatching embedded packet markers', async () => {
    const inbox = new QuantumNotificationInbox();
    const listener = vi.fn();
    inbox.subscribe(listener);
    const frame = rosterFrame(Array.from({ length: 5 }, () => PLAYER));
    frame.set([1, QuantumCommand.REQUEST_USER_ROUTE_LIST, 0, 0], 4);
    frame[3] = 7;
    inbox.markRosterRequest();
    inbox.push(frame);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].players).toHaveLength(5);
    await expect(inbox.waitForRoster(100)).resolves.toEqual(frame);
    const controller = new QuantumBoardController(new ScriptedTransport([frame]), { time: new InstantTime() });
    await expect(controller.refresh()).rejects.toMatchObject({ code: 'board-full' });
  });

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

  writeFrame(frame: Uint8Array): Promise<void> {
    this.writes.push(frame.slice());
    return Promise.resolve();
  }

  readState(): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.reads.shift());
  }
}

class InstantTime implements QuantumTime {
  readonly sleeps: number[] = [];

  monotonicNow(): number {
    return this.sleeps.reduce((total, delay) => total + delay, 0);
  }

  now(): number {
    return 123;
  }

  sleep(milliseconds: number): Promise<void> {
    this.sleeps.push(milliseconds);
    return Promise.resolve();
  }
}

describe('QuantumBoardController', () => {
  it('sends only an owner-scoped removal and confirms it with readback', async () => {
    const transport = new ScriptedTransport([rosterFrame([PLAYER]), rosterFrame([])]);
    const time = new InstantTime();
    const controller = new QuantumBoardController(transport, { time });

    const snapshot = await controller.remove({ userId: USER, routeId: ROUTE });

    expect(snapshot.players).toEqual([]);
    expect(transport.writes.map((frame) => frame[1])).toEqual([
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
      QuantumCommand.TURN_OFF_BY_USER,
      QuantumCommand.REQUEST_USER_ROUTE_LIST,
    ]);
    expect(transport.writes[1].slice(2, 18)).toEqual(encodeQuantumUuid(USER));
  });
});
