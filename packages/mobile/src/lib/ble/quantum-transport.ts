import {
  QUANTUM_MAX_PLAYERS,
  QuantumCommand,
  QuantumRosterTransactionMachine,
  parseQuantumBroadcast,
  type QuantumActivateTransaction,
  type QuantumActivePlayer,
  type QuantumBoardModelId,
  type QuantumBroadcast,
  type QuantumControllerMetadata,
  type QuantumRemoveTransaction,
  type QuantumRosterSnapshot,
  type QuantumRosterTransport,
  type QuantumTime,
} from '@boardsesh/ble-protocol/quantum';
import type { DevicePickerFn } from './types';

const MAX_BUFFERED_NOTIFICATIONS = 16;

export type QuantumControllerConnection = {
  deviceId: string;
  deviceName: string;
  serial: string;
  metadata: QuantumControllerMetadata;
};

export type QuantumDisconnectInfo = {
  description?: string;
};

/** Complete transport used by the platform-neutral roster transaction layer. */
export interface QuantumBluetoothTransport extends QuantumRosterTransport {
  isAvailable(): Promise<boolean>;
  requestAndConnect(
    selectedModelId: QuantumBoardModelId,
    targetSerial?: string,
    targetDeviceId?: string,
  ): Promise<QuantumControllerConnection>;
  disconnect(): Promise<void>;
  onDisconnect(listener: (info?: QuantumDisconnectInfo) => void): () => void;
  onBroadcast(listener: (broadcast: QuantumBroadcast) => void): () => void;
}

export type CreateQuantumBluetoothTransport = (devicePicker: DevicePickerFn) => QuantumBluetoothTransport;

/** A selected setup and physical controller disagree. Never continue with LED
 * addresses from the selected setup when this is thrown. */
export class QuantumControllerModelMismatchError extends Error {
  constructor(
    readonly selectedModelId: QuantumBoardModelId,
    readonly controllerModelId?: QuantumBoardModelId,
  ) {
    super(
      controllerModelId
        ? `Selected Quantum model ${selectedModelId} does not match controller model ${controllerModelId}`
        : 'Quantum controller metadata is missing or invalid',
    );
    this.name = 'QuantumControllerModelMismatchError';
  }
}

type QuantumNotificationRecord = {
  sequence: number;
  frame: Uint8Array;
  broadcast: QuantumBroadcast;
};

type QuantumNotificationWaiter = {
  floor: number;
  timeoutId: ReturnType<typeof setTimeout>;
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

  markRosterRequest(): void {
    this.rosterFloor = this.sequence;
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
      clearTimeout(waiter.timeoutId);
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
        timeoutId: setTimeout(() => {
          this.waiters.delete(waiter);
          resolve(undefined);
        }, timeoutMs),
        resolve,
      };
      this.waiters.add(waiter);
    });
  }

  subscribe(listener: (broadcast: QuantumBroadcast) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  reset(): void {
    this.waiters.forEach((waiter) => {
      clearTimeout(waiter.timeoutId);
      waiter.resolve(undefined);
    });
    this.waiters.clear();
    this.records.length = 0;
    this.sequence = 0;
    this.rosterFloor = 0;
  }

  private isRosterResponse(record: QuantumNotificationRecord): boolean {
    return (
      (record.broadcast.type === 'roster' && record.broadcast.command === QuantumCommand.REQUEST_USER_ROUTE_LIST) ||
      record.broadcast.type === 'controller-error'
    );
  }
}

export type QuantumBoardControllerOptions = {
  time?: QuantumTime;
  clearSettleDelayMs?: number;
};

const SYSTEM_TIME: QuantumTime = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/**
 * One serialized command lane for refresh, layer activation/removal, and the
 * destructive global clear. Write acknowledgement is never treated as proof:
 * every mutation returns only after a fresh FFF4/FFF1 roster readback.
 */
export class QuantumBoardController {
  private readonly transactionMachine: QuantumRosterTransactionMachine;
  private readonly time: QuantumTime;
  private latestSnapshot: QuantumRosterSnapshot | undefined;
  private revision = 0;
  private readonly listeners = new Set<(snapshot: QuantumRosterSnapshot) => void>();
  private readonly removeBroadcastListener: () => void;

  constructor(transport: QuantumBluetoothTransport, options: QuantumBoardControllerOptions = {}) {
    this.time = options.time ?? SYSTEM_TIME;
    this.transactionMachine = new QuantumRosterTransactionMachine(transport, this.time, {
      clearSettleDelayMs: options.clearSettleDelayMs,
    });
    this.removeBroadcastListener = transport.onBroadcast((broadcast) => {
      if (broadcast.type === 'roster' && broadcast.players.length <= QUANTUM_MAX_PLAYERS)
        this.publish(broadcast.players, this.time.now());
      if (broadcast.type === 'wall-cleared') this.publish([], this.time.now());
    });
  }

  get snapshot(): QuantumRosterSnapshot | undefined {
    return this.latestSnapshot;
  }

  subscribe(listener: (snapshot: QuantumRosterSnapshot) => void): () => void {
    this.listeners.add(listener);
    if (this.latestSnapshot) listener(this.latestSnapshot);
    return () => this.listeners.delete(listener);
  }

  async refresh(): Promise<QuantumRosterSnapshot> {
    return this.publishMachineSnapshot(await this.transactionMachine.refresh());
  }

  async activate(request: QuantumActivateTransaction): Promise<QuantumRosterSnapshot> {
    return this.publishMachineSnapshot(await this.transactionMachine.activate(request));
  }

  async remove(request: QuantumRemoveTransaction): Promise<QuantumRosterSnapshot> {
    return this.publishMachineSnapshot(await this.transactionMachine.remove(request));
  }

  /** Global clear is deliberately impossible without an explicit UI-owned
   * confirmation. Callers should obtain that confirmation inline, then pass
   * `confirmed: true`; the empty roster readback is still mandatory. */
  async clearAll(request: { confirmed: boolean }): Promise<QuantumRosterSnapshot> {
    return this.publishMachineSnapshot(await this.transactionMachine.clearAll(request));
  }

  destroy(): void {
    this.removeBroadcastListener();
    this.listeners.clear();
  }

  private publishMachineSnapshot(snapshot: QuantumRosterSnapshot): QuantumRosterSnapshot {
    return this.publish(snapshot.players, snapshot.observedAtMs);
  }

  private publish(players: readonly QuantumActivePlayer[], observedAtMs: number): QuantumRosterSnapshot {
    this.revision += 1;
    const snapshot: QuantumRosterSnapshot = {
      revision: this.revision,
      observedAtMs,
      players: players.map((player) => ({ ...player })),
    };
    this.latestSnapshot = snapshot;
    this.listeners.forEach((listener) => listener(snapshot));
    return snapshot;
  }
}
