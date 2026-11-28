import {
  BleError,
  BleSessionRuntime,
  bounded,
  defaultBleScheduler,
  throwIfAborted,
  type BleCharacteristic,
  type BleOpenOptions,
  type BleScheduler,
  type BleTransport,
  type BleWriteMode,
  type BoardBleCapabilities,
  type BoardBleProtocol,
  type BoardBleSession,
} from '@boardsesh/ble-core';
import {
  QUANTUM_DEVICE_NAME_PREFIXES,
  QUANTUM_LEGACY_SERVICE_UUID,
  QUANTUM_METADATA_CHARACTERISTIC_UUID,
  QUANTUM_MODELS,
  QUANTUM_NOTIFY_CHARACTERISTIC_UUID,
  QUANTUM_SERVICE_UUID,
  QUANTUM_STATE_CHARACTERISTIC_UUID,
  QUANTUM_WRITE_CHARACTERISTIC_UUID,
  QuantumCommand,
  type QuantumBoardModelId,
} from './constants';
import {
  parseQuantumControllerMetadata,
  parseQuantumDeviceSerial,
  type QuantumBroadcast,
  type QuantumControllerMetadata,
} from './codec';
import { QuantumNotificationInbox } from './notifications';
import {
  QuantumRosterTransactionError,
  QuantumRosterTransactionMachine,
  assertQuantumWriteEligible,
  type QuantumActivateTransaction,
  type QuantumRemoveTransaction,
  type QuantumRosterMachineOptions,
  type QuantumRosterMachineState,
  type QuantumRosterSnapshot,
  type QuantumRosterTransport,
  type QuantumTime,
  type QuantumWriteEligibility,
} from './transaction';

/** Deadline for one FFF2 write, FFF4 read or FFF5 read; matches the native adapter. */
export const QUANTUM_GATT_OPERATION_TIMEOUT_MS = 5_000;
/** Deadline for each characteristic lookup and for enabling FFF1 notifications. */
export const QUANTUM_SETUP_OPERATION_TIMEOUT_MS = 5_000;
/**
 * Smallest `maxWriteBytes` open() accepts: one activation with a single diode
 * (43 + 2 bytes), and therefore every removal (20) and route-list request (5).
 * Activations longer than the link's limit are refused as `frame-too-large`
 * before any write. Report the native values: Android 182+ after the MTU
 * 512/247/185 ladder, iOS `QB_` 512, Web Bluetooth 509.
 */
export const QUANTUM_MIN_WRITE_BYTES = 45;

/** The only commands layer transactions send. Turn-off-all (0x45), turn-off-by-route
 * (0x42) and turn-on-all (0x64) affect other climbers' layers and are refused. */
const QUANTUM_TRANSACTION_COMMANDS: ReadonlySet<number> = new Set([
  QuantumCommand.ACTIVATE_WALL,
  QuantumCommand.BOARD_SWIPE,
  QuantumCommand.TURN_OFF_BY_USER,
  QuantumCommand.REQUEST_USER_ROUTE_LIST,
]);

/**
 * A Quantum wall is shared: each player owns at most one coloured layer.
 * `show()` and `clear()` always reject `BleError('unsupported')` without a
 * write, so code holding a generic `BoardBleSession` cannot overwrite or wipe
 * another climber's layer. Use the layer methods instead.
 *
 * Aborting a layer call's signal rejects that call with `BleError('cancelled')`
 * at once, and a mutation not yet written is never written. What `rosterState`
 * shows after a call that wrote a mutation:
 * - The write resolved: its read-back still runs, even after an abort, and
 *   `rosterState` is the roster it confirmed.
 * - The call failed before reading that mutation back, on a live link (the
 *   write rejected, the controller refused, the read-back request failed): the
 *   session re-reads the roster before the next call runs and before the failed
 *   call rejects with its own error. If that re-read fails too, `rosterState`
 *   reports the re-read's failure.
 * - The link was retired (timeout, disconnect, lost notifications): nothing is
 *   read. `rosterState` keeps the last confirmed roster, which may be stale.
 */
export interface QuantumBleSession extends BoardBleSession {
  /** FFF5 metadata read during open(). Diode addresses are specific to this model. */
  readonly controller: Readonly<QuantumControllerMetadata>;
  /** The 12-digit hexadecimal serial from the advertised `QB_` or `QBB_` name. */
  readonly serial: string;
  /** `QB_` controllers take acknowledged writes, `QBB_` controllers unacknowledged writes. */
  readonly writeMode: BleWriteMode;
  /**
   * Phase of the roster transaction machine and the last roster a transaction
   * confirmed. FFF1 roster and wall-cleared broadcasts do not update it; mirror
   * those through `onBroadcast()`.
   */
  readonly rosterState: QuantumRosterMachineState;
  /** Request (0x47) and read back a fresh roster. Sends no mutation. */
  refreshRoster(signal?: AbortSignal): Promise<QuantumRosterSnapshot>;
  /** Add or replace this player's layer. Resolves only after a fresh roster confirms it and every other layer. */
  activateLayer(request: QuantumActivateTransaction, signal?: AbortSignal): Promise<QuantumRosterSnapshot>;
  /** Remove this player's layer by user id. Resolves only after a fresh roster confirms the removal. */
  removeLayer(request: QuantumRemoveTransaction, signal?: AbortSignal): Promise<QuantumRosterSnapshot>;
  /** Every recognised FFF1 notification, including rosters other phones caused. */
  onBroadcast(listener: (broadcast: QuantumBroadcast) => void): () => void;
}

export interface QuantumBleSessionOptions extends BleOpenOptions {
  /**
   * The model of the board setup the climber selected. Required: open() refuses
   * a controller whose FFF5 metadata is missing or reports another model, before
   * any roster command, because diode addresses differ between models.
   */
  expectedModelId: QuantumBoardModelId;
  /** Roster clock and transaction delays. Defaults to the session scheduler, with performance.now for elapsed time. */
  time?: QuantumTime;
  machine?: QuantumRosterMachineOptions;
}

export type QuantumBleProtocolOptions = Omit<QuantumBleSessionOptions, keyof BleOpenOptions>;

/** The selected setup and the physical controller disagree. Never send diode
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

type ReadableBleCharacteristic = BleCharacteristic & Required<Pick<BleCharacteristic, 'read'>>;
type SubscribableBleCharacteristic = BleCharacteristic & Required<Pick<BleCharacteristic, 'subscribe'>>;

function isReadable(characteristic: BleCharacteristic): characteristic is ReadableBleCharacteristic {
  return typeof characteristic.read === 'function';
}

function isSubscribable(characteristic: BleCharacteristic): characteristic is SubscribableBleCharacteristic {
  return typeof characteristic.subscribe === 'function';
}

const QUANTUM_CAPABILITIES: BoardBleCapabilities = Object.freeze({
  // show() accepts no lights: a layer needs an owner, a route and one colour.
  rgb: false,
  roles: Object.freeze([]),
  readback: true,
});

/** One layer call's cancellation state, shared with the roster transport. */
export type QuantumTransactionScope = {
  readonly signal: AbortSignal;
  /** True once a mutation frame has been submitted; its read-back then survives cancellation. */
  readonly mutationWritten: boolean;
  /** The roster transport calls this immediately before it submits a mutation frame. */
  mutationSubmitted(): void;
};

export interface QuantumRosterTransportOptions {
  write: BleCharacteristic;
  state: ReadableBleCharacteristic;
  writeMode: BleWriteMode;
  /** One complete frame must fit one write; frames are never split. */
  maximumWriteBytes: number;
  inbox: QuantumNotificationInbox;
  /** Supplies the connection lifetime, the scheduler and teardown on an uncertain link. */
  runtime: BleSessionRuntime;
  /** The layer call in progress. Once its signal aborts, only read-backs of an already written mutation are sent. */
  currentTransaction?: () => QuantumTransactionScope | undefined;
}

/**
 * Adapts raw ble-core characteristics to the transaction machine's transport.
 * A low-level building block: it checks a frame's first byte and command, not
 * its CRC or who owns the layer. Ownership is enforced only by
 * `QuantumRosterTransactionMachine`, so never hand it frames built elsewhere.
 *
 * Platform operations run under the connection lifetime, not a caller's
 * signal, so a caller never abandons a GATT operation midway. A cancelled layer
 * call sends no further mutation but keeps the read-back of one already
 * written. A timed-out write, read or roster notification retires the link,
 * because nothing proves the platform cancelled it.
 */
export function createQuantumRosterTransport({
  write,
  state,
  writeMode,
  maximumWriteBytes,
  inbox,
  runtime,
  currentTransaction,
}: QuantumRosterTransportOptions): QuantumRosterTransport {
  const lifetime = runtime.signal;
  const scheduler = runtime.scheduler;
  const retire = (error: unknown) => {
    void runtime.disconnect(error).catch(() => undefined);
  };
  const retireOnTimeout = (error: unknown) => {
    if (error instanceof BleError && error.code === 'timeout') retire(error);
  };
  return {
    maximumWriteBytes,
    writeFrame(frame, isEligible, beforeWrite) {
      if (frame[0] !== 1 || !QUANTUM_TRANSACTION_COMMANDS.has(frame[1])) {
        return Promise.reject(new BleError('unsupported', 'Layer transactions never send this Quantum command'));
      }
      if (frame.length === 0 || frame.length > maximumWriteBytes) {
        return Promise.reject(
          new Error(`Quantum frame needs ${frame.length} atomic bytes; transport allows ${maximumWriteBytes}`),
        );
      }
      const payload = frame.slice();
      const isRosterRequest = payload[1] === QuantumCommand.REQUEST_USER_ROUTE_LIST;
      const transaction = currentTransaction?.();
      const assertNotCancelled = () => {
        // A cancelled call still reads back a mutation it already sent, so the
        // wall's state is known; it never sends anything else.
        if (transaction?.signal.aborted && (!isRosterRequest || !transaction.mutationWritten)) {
          throw new QuantumRosterTransactionError(
            'operation-cancelled',
            'Quantum layer call was cancelled before this command was written',
          );
        }
      };
      return (async () => {
        throwIfAborted(lifetime);
        assertNotCancelled();
        assertQuantumWriteEligible(isEligible);
        if (beforeWrite) {
          await beforeWrite();
          throwIfAborted(lifetime);
          assertNotCancelled();
          assertQuantumWriteEligible(isEligible);
        }
        // Once submitted, a mutation may reach the wall even if the write fails.
        if (!isRosterRequest) transaction?.mutationSubmitted();
        // Mark immediately before the request: a delayed notification from an
        // earlier command cannot cross this freshness floor.
        if (isRosterRequest) inbox.markRosterRequest();
        else inbox.markMutation();
        try {
          await bounded(
            write.write(payload, writeMode, lifetime),
            lifetime,
            QUANTUM_GATT_OPERATION_TIMEOUT_MS,
            scheduler,
          );
        } catch (error) {
          retireOnTimeout(error);
          throw error;
        }
      })();
    },
    getMutationFailure: (command) => inbox.getMutationFailure(command),
    async readState() {
      throwIfAborted(lifetime);
      try {
        return await bounded(state.read(lifetime), lifetime, QUANTUM_GATT_OPERATION_TIMEOUT_MS, scheduler);
      } catch (error) {
        // A late FFF4 read could overlap the next GATT operation.
        retireOnTimeout(error);
        throw error;
      }
    },
    async waitForNotification(timeoutMs) {
      if (lifetime.aborted) return undefined;
      const frame = await inbox.waitForRoster(timeoutMs);
      if (!frame && !lifetime.aborted) retire(new BleError('timeout', 'Quantum roster notification timed out'));
      return frame;
    },
  };
}

/** Transaction delays follow the injected scheduler. BleScheduler has no
 * monotonic clock, so elapsed-time checks keep performance.now(). */
function schedulerTime(scheduler: BleScheduler): QuantumTime {
  return {
    now: () => scheduler.now(),
    monotonicNow: () => performance.now(),
    sleep: (milliseconds) =>
      new Promise<void>((resolve) => {
        scheduler.setTimeout(resolve, milliseconds);
      }),
  };
}

function assertKnownModel(modelId: QuantumBoardModelId): void {
  if (!QUANTUM_MODELS.some((model) => model.id === modelId)) {
    throw new RangeError('expectedModelId must be a Quantum model id');
  }
}

function snapshotPlayers<Player extends object>(players: readonly Player[] | undefined): Player[] | undefined {
  return players?.map((player) => ({ ...player }));
}

type QuantumCharacteristics = {
  notify: SubscribableBleCharacteristic;
  write: BleCharacteristic;
  state: ReadableBleCharacteristic;
  metadata: ReadableBleCharacteristic;
};

async function discoverQuantumCharacteristics(
  transport: BleTransport,
  signal: AbortSignal,
  scheduler: BleScheduler,
): Promise<QuantumCharacteristics> {
  // Prefer FFF0 over FFE0 and never combine characteristics across services.
  for (const serviceUuid of [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID]) {
    // One outstanding lookup at a time: Chromium permits a single GATT operation.
    const lookup = (characteristicUuid: string) =>
      bounded(
        transport.getCharacteristic({ serviceUuid, characteristicUuid }, signal),
        signal,
        QUANTUM_SETUP_OPERATION_TIMEOUT_MS,
        scheduler,
      );
    try {
      const notify = await lookup(QUANTUM_NOTIFY_CHARACTERISTIC_UUID);
      const write = await lookup(QUANTUM_WRITE_CHARACTERISTIC_UUID);
      const state = await lookup(QUANTUM_STATE_CHARACTERISTIC_UUID);
      const metadata = await lookup(QUANTUM_METADATA_CHARACTERISTIC_UUID);
      if (!isSubscribable(notify) || !isReadable(state) || !isReadable(metadata)) {
        throw new BleError('unsupported', 'Quantum FFF1 must notify and FFF4/FFF5 must be readable');
      }
      return { notify, write, state, metadata };
    } catch (error) {
      throwIfAborted(signal);
      if (!(error instanceof BleError) || error.code !== 'service-missing') throw error;
    }
  }
  throw new BleError(
    'service-missing',
    'Quantum binary control requires FFF1/FFF2/FFF4/FFF5; legacy JSON controllers without FFF5 are unsupported',
  );
}

/** Takes ownership of a connected transport, including cleanup when initialization fails. Writes nothing. */
async function openQuantumBleSession(
  transport: BleTransport,
  options: QuantumBleSessionOptions,
): Promise<QuantumBleSession> {
  const scheduler = options.scheduler ?? defaultBleScheduler;
  const inbox = new QuantumNotificationInbox(scheduler);
  let unsubscribe: (() => void) | undefined;
  const runtime = new BleSessionRuntime(
    {
      deviceId: transport.deviceId,
      deviceName: transport.deviceName,
      maxWriteBytes: transport.maxWriteBytes,
      getCharacteristic: (target, signal) => transport.getCharacteristic(target, signal),
      onDisconnect: (listener) => transport.onDisconnect(listener),
      async disconnect() {
        try {
          unsubscribe?.();
        } finally {
          inbox.reset();
          await transport.disconnect();
        }
      },
    },
    scheduler,
  );
  // A caller cancelling the connect sees a cancellation, not a lost connection.
  const abortOpen = () => {
    void runtime.disconnect(new BleError('cancelled')).catch(() => undefined);
  };
  options.signal?.addEventListener('abort', abortOpen, { once: true });
  if (options.signal?.aborted) abortOpen();
  const fail = (error: unknown) => {
    void runtime.disconnect(error).catch(() => undefined);
  };
  try {
    throwIfAborted(runtime.signal);
    assertKnownModel(options.expectedModelId);
    if (!Number.isSafeInteger(transport.maxWriteBytes) || transport.maxWriteBytes < 1) {
      throw new BleError('invalid-input', 'maxWriteBytes must be a positive integer');
    }
    if (transport.maxWriteBytes < QUANTUM_MIN_WRITE_BYTES) {
      throw new BleError(
        'unsupported',
        `Quantum needs ${QUANTUM_MIN_WRITE_BYTES}-byte writes; negotiate a larger MTU before opening`,
      );
    }
    const deviceName = transport.deviceName;
    const serial = parseQuantumDeviceSerial(deviceName);
    if (!deviceName || !serial) {
      throw new BleError('unsupported', 'Selected device is not a supported Quantum controller');
    }
    // QBB_ does not start with QB_: only persistent binary QB_ boards acknowledge writes.
    const writeMode: BleWriteMode = deviceName.startsWith('QB_') ? 'with-response' : 'without-response';
    const characteristics = await discoverQuantumCharacteristics(transport, runtime.signal, scheduler);
    throwIfAborted(runtime.signal);
    if (
      writeMode === 'with-response'
        ? !characteristics.write.writeWithResponse
        : !characteristics.write.writeWithoutResponse
    ) {
      throw new BleError('unsupported', 'Quantum FFF2 does not support the selected controller write mode');
    }
    const metadataBytes = await bounded(
      characteristics.metadata.read(runtime.signal),
      runtime.signal,
      QUANTUM_GATT_OPERATION_TIMEOUT_MS,
      scheduler,
    );
    throwIfAborted(runtime.signal);
    const metadata = parseQuantumControllerMetadata(metadataBytes);
    if (!metadata || metadata.model.id !== options.expectedModelId) {
      throw new QuantumControllerModelMismatchError(options.expectedModelId, metadata?.model.id);
    }
    const controller = Object.freeze({ ...metadata });

    // Enable FFF1 notifications before the first roster command can be written.
    const subscribing = characteristics.notify.subscribe(
      (bytes) => {
        if (!runtime.signal.aborted) inbox.push(bytes);
      },
      fail,
      runtime.signal,
    );
    // A subscription can finish after cancellation; tear that late listener down too.
    void subscribing.then(
      (remove) => {
        if (runtime.signal.aborted) {
          try {
            remove();
          } catch {
            /* The transport has already been disconnected. */
          }
        }
      },
      () => undefined,
    );
    unsubscribe = await bounded(subscribing, runtime.signal, QUANTUM_SETUP_OPERATION_TIMEOUT_MS, scheduler);
    throwIfAborted(runtime.signal);

    let activeTransaction: QuantumTransactionScope | undefined;
    const machine = new QuantumRosterTransactionMachine(
      createQuantumRosterTransport({
        write: characteristics.write,
        state: characteristics.state,
        writeMode,
        maximumWriteBytes: transport.maxWriteBytes,
        inbox,
        runtime,
        currentTransaction: () => activeTransaction,
      }),
      options.time ?? schedulerTime(scheduler),
      options.machine,
    );
    // The machine's eligibility follows the connection, not the caller's signal:
    // a cancelled call must still read back a mutation it already wrote. The
    // roster transport applies the caller's signal to unsent frames instead.
    const eligibility =
      (callerEligibility?: QuantumWriteEligibility): QuantumWriteEligibility =>
      () =>
        !runtime.signal.aborted && (callerEligibility?.() ?? true);
    // One layer call at a time; the runtime queue waits for a cancelled call's
    // read-back before the next call reads its own fresh roster.
    const runTransaction = <Result>(work: () => Promise<Result>, callerSignal?: AbortSignal) =>
      runtime.run(async (operationSignal) => {
        let mutationWritten = false;
        let revisionAtMutation: number | undefined;
        const transaction: QuantumTransactionScope = {
          signal: operationSignal,
          get mutationWritten() {
            return mutationWritten;
          },
          mutationSubmitted() {
            mutationWritten = true;
            revisionAtMutation = machine.state.snapshot?.revision;
          },
        };
        activeTransaction = transaction;
        try {
          return await work();
        } catch (error) {
          // A mutation went out but the call failed before any roster confirmed it
          // (the write rejected, the controller refused, the read-back failed). The
          // controller may have applied it, so re-read the wall on this live link
          // before the next call runs. A retired link has nothing left to read.
          if (mutationWritten && !runtime.signal.aborted && machine.state.snapshot?.revision === revisionAtMutation) {
            try {
              await machine.refresh(eligibility());
            } catch {
              /* rosterState then reports the re-read's own failure. */
            }
          }
          throw error;
        } finally {
          if (activeTransaction === transaction) activeTransaction = undefined;
        }
      }, callerSignal);

    return {
      capabilities: QUANTUM_CAPABILITIES,
      controller,
      serial,
      writeMode,
      get rosterState() {
        return machine.state;
      },
      refreshRoster(signal) {
        return runTransaction(() => machine.refresh(eligibility()), signal);
      },
      activateLayer(request, signal) {
        let snapshot: QuantumActivateTransaction;
        try {
          // Snapshot at submission: queued work must not see later caller edits.
          snapshot = {
            ...request,
            diodeIds: [...request.diodeIds],
            expectedPlayers: snapshotPlayers(request.expectedPlayers),
          };
        } catch (error) {
          return Promise.reject(error);
        }
        return runTransaction(
          () => machine.activate({ ...snapshot, isEligible: eligibility(snapshot.isEligible) }),
          signal,
        );
      },
      removeLayer(request, signal) {
        let snapshot: QuantumRemoveTransaction;
        try {
          snapshot = { ...request, expectedPlayers: snapshotPlayers(request.expectedPlayers) };
        } catch (error) {
          return Promise.reject(error);
        }
        return runTransaction(
          () => machine.remove({ ...snapshot, isEligible: eligibility(snapshot.isEligible) }),
          signal,
        );
      },
      onBroadcast(listener) {
        return inbox.subscribe((broadcast) => {
          try {
            listener(broadcast);
          } catch {
            /* An observer cannot interrupt roster bookkeeping. */
          }
        });
      },
      show: () =>
        Promise.reject(
          new BleError('unsupported', 'Quantum walls hold one layer per player; use activateLayer() for your layer'),
        ),
      clear: () =>
        Promise.reject(
          new BleError('unsupported', 'Quantum has no whole-wall clear; use removeLayer() for your own layer'),
        ),
      disconnect: () => runtime.disconnect(),
      onDisconnect: (listener) => runtime.onDisconnect(listener),
    };
  } catch (error) {
    await runtime.disconnect().catch(() => undefined);
    if (options.signal?.aborted) throw new BleError('cancelled');
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortOpen);
  }
}

/** `expectedModelId` is required: there is no way to open a session without the model check. */
export function createQuantumBleProtocol(options: QuantumBleProtocolOptions): BoardBleProtocol<QuantumBleSession> {
  assertKnownModel(options.expectedModelId);
  const configuration: QuantumBleProtocolOptions = {
    ...options,
    machine: options.machine ? { ...options.machine } : undefined,
  };
  return {
    id: 'quantum',
    discovery: {
      // Controllers are matched by advertised name; neither Boardsesh adapter
      // filters the scan by service. Both services are listed so Web Bluetooth
      // grants access to whichever one the controller exposes.
      serviceUuids: [],
      optionalServiceUuids: [QUANTUM_SERVICE_UUID, QUANTUM_LEGACY_SERVICE_UUID],
      namePrefixes: QUANTUM_DEVICE_NAME_PREFIXES,
    },
    // Only the signal and scheduler come from open(): the model check cannot be overridden there.
    open: (transport, openOptions = {}) =>
      openQuantumBleSession(transport, {
        ...configuration,
        signal: openOptions.signal,
        scheduler: openOptions.scheduler,
      }),
  };
}
