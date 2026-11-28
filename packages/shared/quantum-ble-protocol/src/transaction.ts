import { QUANTUM_MAX_PLAYERS, QUANTUM_ZERO_UUID, QuantumCommand } from './constants';
import {
  canonicalQuantumUuid,
  encodeQuantumActivation,
  encodeQuantumRosterRequest,
  encodeQuantumTurnOffUser,
  parseQuantumBroadcast,
  quantumUuidsEqual,
  type QuantumActivation,
  type QuantumActivePlayer,
  type QuantumControllerFailure,
} from './codec';

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

/** The roster reports whole seconds. A layer on its last reported second can
 * expire between reads. Every survivor must still match its original owner,
 * route and color, and longer-lived layers must still be present. */
function confirmsForeignLayers(
  before: readonly QuantumActivePlayer[],
  after: readonly QuantumActivePlayer[],
  elapsedMs: number,
): boolean {
  const remaining = [...before];
  for (const survivor of after) {
    const identity = playerIdentity(survivor);
    const index = remaining.findIndex((previous) => playerIdentity(previous) === identity);
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  const elapsedSeconds = Math.ceil(Math.max(0, elapsedMs) / 1000);
  return remaining.every((missing) => missing.remainingSeconds <= elapsedSeconds);
}

/** Rechecked in both the transaction lane and the platform GATT lane. */
export type QuantumWriteEligibility = () => boolean;
/** Runs inside the GATT lane, before a physical mutation. */
export type QuantumWritePreflight = () => Promise<void>;

export function assertQuantumWriteEligible(isEligible?: QuantumWriteEligibility): void {
  if (isEligible && !isEligible()) {
    throw new QuantumRosterTransactionError('operation-cancelled', 'Quantum wall controls are no longer active');
  }
}

export interface QuantumRosterTransport {
  /** Largest complete value accepted by one transport write in its negotiated mode. */
  readonly maximumWriteBytes: number;
  /**
   * Issue one characteristic write in the selected mode. Any preflight must
   * run inside the transport's write lane. Recheck eligibility and physical
   * ownership after it settles and immediately before sending.
   */
  writeFrame(
    frame: Uint8Array,
    isEligible?: QuantumWriteEligibility,
    beforeWrite?: QuantumWritePreflight,
  ): Promise<void>;
  /** A buffered refusal for the last mutation can arrive before the roster request. */
  getMutationFailure?(command: QuantumCommand): QuantumControllerFailure | undefined;
  /** Read one complete value from the state characteristic. */
  readState(): Promise<Uint8Array | undefined>;
  /** Optional notification fallback; the adapter owns its timeout mechanism. */
  waitForNotification?(timeoutMs: number): Promise<Uint8Array | undefined>;
}

export interface QuantumTime {
  now(): number;
  monotonicNow(): number;
  sleep(milliseconds: number): Promise<void>;
}

const SYSTEM_QUANTUM_TIME: QuantumTime = {
  now: () => Date.now(),
  monotonicNow: () => performance.now(),
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
  | 'operation-cancelled'
  | 'frame-too-large'
  | 'transport-failed'
  | 'roster-unavailable'
  | 'controller-refused'
  | 'roster-changed'
  | 'board-full'
  | 'color-in-use'
  | 'target-route-changed'
  | 'target-unavailable'
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
  /** Absent for a fresh player. Required to replace an existing route. */
  expectedOwnedRouteId?: string;
  isEligible?: QuantumWriteEligibility;
  /** Recheck the climb's availability before release and final activation. */
  assertTargetAvailable?: QuantumWritePreflight;
  expectedPlayers?: readonly QuantumActivePlayer[];
};

export type QuantumRemoveTransaction = {
  userId: string;
  routeId: string;
  isEligible?: QuantumWriteEligibility;
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

  refresh(isEligible?: QuantumWriteEligibility): Promise<QuantumRosterSnapshot> {
    return this.enqueue('refresh', () => this.requestFreshRoster('refresh', isEligible));
  }

  async activate(request: QuantumActivateTransaction): Promise<QuantumRosterSnapshot> {
    if (quantumUuidsEqual(request.userId, QUANTUM_ZERO_UUID)) {
      throw new TypeError('Quantum roster mutations require a non-zero user UUID');
    }

    const activationFrame = encodeQuantumActivation(request);
    this.assertFrameFits(activationFrame);

    return this.enqueue('activate', async () => {
      const before = await this.requestFreshRoster('activate', request.isEligible);
      const preflightAt = this.time.monotonicNow();
      this.assertExpectedRoster(before, request.expectedPlayers);

      const ownedPlayers = this.ownedPlayers(before, request.userId);
      const expectedRoute = request.expectedOwnedRouteId;
      if (
        expectedRoute === undefined
          ? ownedPlayers.length !== 0
          : ownedPlayers.length !== 1 || !quantumUuidsEqual(ownedPlayers[0].routeId, expectedRoute)
      ) {
        throw new QuantumRosterTransactionError(
          'target-route-changed',
          'Quantum player no longer owns the expected route',
        );
      }

      const foreignPlayers = before.players.filter((player) => !quantumUuidsEqual(player.userId, request.userId));
      if (ownedPlayers.length === 0 && before.players.length >= QUANTUM_MAX_PLAYERS) {
        throw new QuantumRosterTransactionError('board-full', 'Quantum controller already has four active players');
      }
      if (foreignPlayers.some((player) => quantumUuidsEqual(player.routeId, request.routeId))) {
        throw new QuantumRosterTransactionError('roster-changed', 'Quantum route is already active for another player');
      }
      const color = request.color ?? 0x00ffff;
      if (foreignPlayers.some((player) => player.color === color)) {
        throw new QuantumRosterTransactionError('color-in-use', 'Quantum controller color is already occupied');
      }

      if (ownedPlayers.length === 1) {
        await this.releaseAndConfirm({
          operation: 'activate',
          removalFrame: encodeQuantumTurnOffUser(request.userId),
          userId: request.userId,
          foreignPlayers,
          preflightAt,
          isEligible: request.isEligible,
          beforeWrite: request.assertTargetAvailable,
        });
      }
      this.transition('mutating', 'activate');
      await this.writeAtomic(activationFrame, request.isEligible, request.assertTargetAvailable);
      await this.time.sleep(this.activationSettleDelayMs);
      const command = request.swipe ? QuantumCommand.BOARD_SWIPE : QuantumCommand.ACTIVATE_WALL;
      const after = await this.requestFreshRoster('activate', request.isEligible, command);
      const afterForeignPlayers = after.players.filter((player) => !quantumUuidsEqual(player.userId, request.userId));
      const targetPlayers = this.ownedPlayers(after, request.userId);
      const targetConfirmed =
        targetPlayers.length === 1 &&
        quantumUuidsEqual(targetPlayers[0].routeId, request.routeId) &&
        targetPlayers[0].color === color;

      if (
        !targetConfirmed ||
        !confirmsForeignLayers(foreignPlayers, afterForeignPlayers, this.time.monotonicNow() - preflightAt)
      ) {
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
      const before = await this.requestFreshRoster('remove', request.isEligible);
      const preflightAt = this.time.monotonicNow();
      this.assertExpectedRoster(before, request.expectedPlayers);
      const ownedPlayers = this.ownedPlayers(before, request.userId);
      if (ownedPlayers.length === 0) return before;
      if (ownedPlayers.length !== 1 || !quantumUuidsEqual(ownedPlayers[0].routeId, request.routeId)) {
        throw new QuantumRosterTransactionError(
          'target-route-changed',
          'Quantum player no longer owns the expected removal route',
        );
      }

      return this.releaseAndConfirm({
        operation: 'remove',
        removalFrame,
        userId: request.userId,
        foreignPlayers: before.players.filter((player) => !quantumUuidsEqual(player.userId, request.userId)),
        preflightAt,
        isEligible: request.isEligible,
      });
    });
  }

  private ownedPlayers(snapshot: QuantumRosterSnapshot, userId: string): QuantumActivePlayer[] {
    return snapshot.players.filter((player) => quantumUuidsEqual(player.userId, userId));
  }

  private async releaseAndConfirm({
    operation,
    removalFrame,
    userId,
    foreignPlayers,
    preflightAt,
    isEligible,
    beforeWrite,
  }: {
    operation: 'activate' | 'remove';
    removalFrame: Uint8Array;
    userId: string;
    foreignPlayers: readonly QuantumActivePlayer[];
    preflightAt: number;
    isEligible?: QuantumWriteEligibility;
    beforeWrite?: QuantumWritePreflight;
  }): Promise<QuantumRosterSnapshot> {
    this.transition('mutating', operation);
    await this.writeAtomic(removalFrame, isEligible, beforeWrite);
    if (operation === 'activate') await this.time.sleep(this.releaseBeforeActivationDelayMs);
    const after = await this.requestFreshRoster(operation, isEligible, QuantumCommand.TURN_OFF_BY_USER);
    if (
      this.ownedPlayers(after, userId).length !== 0 ||
      !confirmsForeignLayers(foreignPlayers, after.players, this.time.monotonicNow() - preflightAt)
    ) {
      throw new QuantumRosterTransactionError(
        'confirmation-failed',
        'Quantum removal did not preserve and confirm the expected roster',
      );
    }
    return after;
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

  private async requestFreshRoster(
    operation: QuantumRosterOperation,
    isEligible?: QuantumWriteEligibility,
    mutationCommand?: QuantumCommand,
  ): Promise<QuantumRosterSnapshot> {
    this.transition('refreshing', operation);
    const assertCurrent = () => {
      assertQuantumWriteEligible(isEligible);
      if (mutationCommand === undefined) return;
      const failure = this.transport.getMutationFailure?.(mutationCommand);
      if (failure) {
        throw new QuantumRosterTransactionError(
          'controller-refused',
          `Quantum controller refused the command: ${failure}`,
          {
            controllerFailure: failure,
          },
        );
      }
    };
    assertCurrent();
    await this.writeAtomic(encodeQuantumRosterRequest(), isEligible);
    await this.time.sleep(this.routeListReadDelayMs);

    let readFailure: unknown;
    try {
      assertCurrent();
      const readFrame = await this.transport.readState();
      assertCurrent();
      const roster = this.rosterFromFrame(readFrame);
      if (roster) return this.acceptRoster(roster);
    } catch (error) {
      if (error instanceof QuantumRosterTransactionError) throw error;
      readFailure = error;
    }

    if (this.transport.waitForNotification) {
      try {
        const notification = await this.transport.waitForNotification(this.notificationTimeoutMs);
        assertCurrent();
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
    if (broadcast.players.length > QUANTUM_MAX_PLAYERS) {
      throw new QuantumRosterTransactionError(
        'board-full',
        'Quantum roster exceeds the four layers supported by Boardsesh',
      );
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

  private async writeAtomic(
    frame: Uint8Array,
    isEligible?: QuantumWriteEligibility,
    beforeWrite?: QuantumWritePreflight,
  ): Promise<void> {
    this.assertFrameFits(frame);
    assertQuantumWriteEligible(isEligible);
    await this.transport.writeFrame(frame.slice(), isEligible, beforeWrite);
  }

  private transition(phase: QuantumRosterPhase, operation: QuantumRosterOperation): void {
    this.currentState = { phase, operation, snapshot: this.currentState.snapshot };
  }
}
