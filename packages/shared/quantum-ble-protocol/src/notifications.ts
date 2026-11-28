import { defaultBleScheduler, type BleScheduler } from '@boardsesh/ble-core';
import { QuantumCommand } from './constants';
import { parseQuantumBroadcast, type QuantumBroadcast, type QuantumControllerFailure } from './codec';

// Twin of QuantumNotificationInbox in packages/mobile/src/lib/ble/quantum-transport.ts.
// The only difference is the injected scheduler. The mobile rewire deletes that
// copy and imports this one.

const MAX_BUFFERED_NOTIFICATIONS = 16;

type QuantumNotificationRecord = {
  sequence: number;
  frame: Uint8Array;
  broadcast: QuantumBroadcast;
};

type QuantumNotificationWaiter = {
  floor: number;
  cancelTimeout: () => void;
  resolve: (frame: Uint8Array | undefined) => void;
};

/** Tracks the notification sequence at the instant command 0x47 is written, so
 * a fallback read can never accept a roster broadcast from an earlier request. */
export class QuantumNotificationInbox {
  private readonly records: QuantumNotificationRecord[] = [];
  private readonly waiters = new Set<QuantumNotificationWaiter>();
  private readonly listeners = new Set<(broadcast: QuantumBroadcast) => void>();
  private sequence = 0;
  private rosterFloor = 0;
  private mutationFloor = 0;

  constructor(private readonly scheduler: BleScheduler = defaultBleScheduler) {}

  markRosterRequest(): void {
    this.rosterFloor = this.sequence;
  }

  markMutation(): void {
    this.mutationFloor = this.sequence;
  }

  getMutationFailure(command: QuantumCommand): QuantumControllerFailure | undefined {
    for (const { sequence, broadcast } of this.records) {
      if (
        sequence > this.mutationFloor &&
        broadcast.type === 'controller-error' &&
        broadcast.failedCommand === command
      ) {
        return broadcast.failure;
      }
    }
    return undefined;
  }

  push(value: Uint8Array): void {
    // Each characteristic event carries one value. UUIDs and trailers can
    // contain protocol markers, so never scan a payload for a second packet.
    const broadcast = parseQuantumBroadcast(value);
    if (!broadcast) return;
    this.sequence += 1;
    const record: QuantumNotificationRecord = { sequence: this.sequence, frame: value.slice(), broadcast };
    this.records.push(record);
    if (this.records.length > MAX_BUFFERED_NOTIFICATIONS) this.records.shift();
    this.listeners.forEach((listener) => listener(broadcast));
    for (const waiter of this.waiters) {
      if (record.sequence <= waiter.floor || !this.isRosterResponse(record)) continue;
      waiter.cancelTimeout();
      this.waiters.delete(waiter);
      waiter.resolve(record.frame.slice());
    }
  }

  waitForRoster(timeoutMs: number): Promise<Uint8Array | undefined> {
    const buffered = this.records.find((record) => record.sequence > this.rosterFloor && this.isRosterResponse(record));
    if (buffered) return Promise.resolve(buffered.frame.slice());

    return new Promise((resolve) => {
      const waiter: QuantumNotificationWaiter = {
        floor: this.rosterFloor,
        cancelTimeout: () => {},
        resolve,
      };
      this.waiters.add(waiter);
      waiter.cancelTimeout = this.scheduler.setTimeout(() => {
        this.waiters.delete(waiter);
        resolve(undefined);
      }, timeoutMs);
    });
  }

  subscribe(listener: (broadcast: QuantumBroadcast) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.waiters.forEach((waiter) => {
      waiter.cancelTimeout();
      waiter.resolve(undefined);
    });
    this.waiters.clear();
    this.records.length = 0;
    this.sequence = 0;
    this.rosterFloor = 0;
    this.mutationFloor = 0;
  }

  private isRosterResponse(record: QuantumNotificationRecord): boolean {
    return (
      (record.broadcast.type === 'roster' && record.broadcast.command === QuantumCommand.REQUEST_USER_ROUTE_LIST) ||
      record.broadcast.type === 'controller-error'
    );
  }
}
