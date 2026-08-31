import {
  QUANTUM_MAX_PLAYERS,
  QuantumCommand,
  QuantumRosterTransactionError,
  QuantumRosterTransactionMachine,
  encodeQuantumTurnOffAll,
  parseQuantumBroadcast,
  quantumBroadcastLength,
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

const MAX_QUANTUM_BROADCAST_BYTES = 4 + QUANTUM_MAX_PLAYERS * 37;
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

export type QuantumAssembledBroadcast = {
  frame: Uint8Array;
  broadcast: QuantumBroadcast;
};

/**
 * Strict notification reassembly for FFF1. Notifications can be split at ATT
 * boundaries even after a large MTU was negotiated. Unsupported commands and
 * malformed roster headers are discarded one byte at a time until the next
 * protocol marker, while incomplete supported broadcasts remain buffered.
 */
export class QuantumBroadcastAssembler {
  private buffered = new Uint8Array();

  push(chunk: Uint8Array): QuantumAssembledBroadcast[] {
    if (chunk.length === 0) return [];
    const combined = new Uint8Array(this.buffered.length + chunk.length);
    combined.set(this.buffered);
    combined.set(chunk, this.buffered.length);
    this.buffered = combined.slice(-MAX_QUANTUM_BROADCAST_BYTES * 2);

    const broadcasts: QuantumAssembledBroadcast[] = [];
    while (this.buffered.length > 0) {
      if (this.buffered[0] !== 1) {
        this.buffered = this.buffered.slice(1);
        continue;
      }
      if (this.buffered.length < 2) break;

      const rawCommand = this.buffered[1];
      const rosterCommand =
        rawCommand === QuantumCommand.ACTIVATE_WALL ||
        rawCommand === QuantumCommand.BOARD_SWIPE ||
        rawCommand === QuantumCommand.REQUEST_USER_ROUTE_LIST;
      if (rosterCommand && this.buffered.length < 4) break;

      const expectedLength = quantumBroadcastLength(this.buffered);
      if (expectedLength === undefined || expectedLength > MAX_QUANTUM_BROADCAST_BYTES) {
        this.buffered = this.buffered.slice(1);
        continue;
      }
      if (this.buffered.length < expectedLength) break;

      const frame = this.buffered.slice(0, expectedLength);
      this.buffered = this.buffered.slice(expectedLength);
      const parsed = parseQuantumBroadcast(frame);
      if (parsed) broadcasts.push({ frame, broadcast: parsed });
    }
    return broadcasts;
  }

  reset(): void {
    this.buffered = new Uint8Array();
  }
}

type QuantumNotificationRecord = QuantumAssembledBroadcast & { sequence: number };
type QuantumNotificationWaiter = {
  floor: number;
  timeoutId: ReturnType<typeof setTimeout>;
  resolve: (frame: Uint8Array | undefined) => void;
};

/** Tracks the notification sequence at the instant command 0x47 is written, so
 * a fallback read can never accept a roster broadcast from an earlier request. */
export class QuantumNotificationInbox {
  private readonly assembler = new QuantumBroadcastAssembler();
  private readonly records: QuantumNotificationRecord[] = [];
  private readonly waiters = new Set<QuantumNotificationWaiter>();
  private readonly listeners = new Set<(broadcast: QuantumBroadcast) => void>();
  private sequence = 0;
  private rosterFloor = 0;

  markRosterRequest(): void {
    this.rosterFloor = this.sequence;
  }

  push(chunk: Uint8Array): void {
    for (const assembled of this.assembler.push(chunk)) {
      this.sequence += 1;
      const record: QuantumNotificationRecord = { sequence: this.sequence, ...assembled };
      this.records.push(record);
      if (this.records.length > MAX_BUFFERED_NOTIFICATIONS) this.records.shift();
      this.listeners.forEach((listener) => listener(assembled.broadcast));

      for (const waiter of this.waiters) {
        if (record.sequence <= waiter.floor || !this.isRosterResponse(record)) continue;
        clearTimeout(waiter.timeoutId);
        this.waiters.delete(waiter);
        waiter.resolve(record.frame.slice());
      }
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
    this.assembler.reset();
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
  private readonly clearSettleDelayMs: number;
  private operationTail: Promise<void> = Promise.resolve();
  private latestSnapshot: QuantumRosterSnapshot | undefined;
  private revision = 0;
  private readonly listeners = new Set<(snapshot: QuantumRosterSnapshot) => void>();
  private readonly removeBroadcastListener: () => void;

  constructor(
    private readonly transport: QuantumBluetoothTransport,
    options: QuantumBoardControllerOptions = {},
  ) {
    this.time = options.time ?? SYSTEM_TIME;
    this.clearSettleDelayMs = options.clearSettleDelayMs ?? 250;
    this.transactionMachine = new QuantumRosterTransactionMachine(transport, this.time);
    this.removeBroadcastListener = transport.onBroadcast((broadcast) => {
      if (broadcast.type === 'roster') this.publish(broadcast.players, this.time.now());
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

  refresh(): Promise<QuantumRosterSnapshot> {
    return this.enqueue(async () => this.publishMachineSnapshot(await this.transactionMachine.refresh()));
  }

  activate(request: QuantumActivateTransaction): Promise<QuantumRosterSnapshot> {
    return this.enqueue(async () => this.publishMachineSnapshot(await this.transactionMachine.activate(request)));
  }

  remove(request: QuantumRemoveTransaction): Promise<QuantumRosterSnapshot> {
    return this.enqueue(async () => this.publishMachineSnapshot(await this.transactionMachine.remove(request)));
  }

  /** Global clear is deliberately impossible without an explicit UI-owned
   * confirmation. Callers should obtain that confirmation inline, then pass
   * `confirmed: true`; the empty roster readback is still mandatory. */
  clearAll({ confirmed }: { confirmed: boolean }): Promise<QuantumRosterSnapshot> {
    if (!confirmed) {
      return Promise.reject(new Error('Quantum global clear requires explicit confirmation'));
    }

    return this.enqueue(async () => {
      await this.transactionMachine.refresh();
      const frame = encodeQuantumTurnOffAll();
      if (frame.length > this.transport.maximumWriteBytes) {
        throw new QuantumRosterTransactionError(
          'frame-too-large',
          `Quantum clear needs ${frame.length} atomic bytes; transport allows ${this.transport.maximumWriteBytes}`,
        );
      }
      await this.transport.writeWithResponse(frame);
      await this.time.sleep(this.clearSettleDelayMs);
      const after = await this.transactionMachine.refresh();
      if (after.players.length !== 0) {
        throw new QuantumRosterTransactionError('confirmation-failed', 'Quantum global clear was not confirmed');
      }
      return this.publishMachineSnapshot(after);
    });
  }

  destroy(): void {
    this.removeBroadcastListener();
    this.listeners.clear();
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
