import type { ClimbQueueItemInput, RelayBoardClimbResult } from '@boardsesh/shared-schema';

/**
 * How long a relayed climb may take to light before this phone says it didn't
 * reach the board: the relay mutation, the holder's phone hearing it, a BLE
 * write to an original MoonBoard (write-with-response, 23-byte MTU: the slow
 * box), the holder's report and its echo back here. The issue's rollout gate
 * is "relayed climbs light within 8 s". Tune on the bench.
 */
export const RELAY_CONFIRM_TIMEOUT_MS = 8_000;

let mintedCount = 0;

/**
 * A fresh relay request id. It only has to be unique among this board's
 * relays for a few seconds (the server echoes it back to whoever asked), so a
 * time, a counter and some randomness do; no crypto module needed.
 */
export function mintRelayRequestId(): string {
  mintedCount += 1;
  return `relay-${Date.now().toString(36)}-${mintedCount.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Statuses that mean no phone is there to light the climb: no holder, this
 * very connection is the holder (a stale hold of its own), or the holder has
 * no live relay subscription (socket dropped, another board). The next Put on
 * board connects instead.
 */
const HOLDER_GONE_STATUSES: ReadonlySet<string> = new Set(['NO_HOLDER', 'SELF_HOLDER', 'HOLDER_UNREACHABLE']);

/**
 * What became of one relay.
 *
 * - `confirmed` — the holder's `BoardClimbSet` echoed its id: it lit.
 * - `holder_gone` — the server says no other phone can light it ({@link HOLDER_GONE_STATUSES}).
 * - `unconfirmed` — it didn't land: no echo in time, the holder turned relays
 *   off, the board isn't in Relay mode, the holder can't read the climb, or
 *   the request failed.
 * - `superseded` — a newer relay replaced it, or the climber stopped: say nothing.
 */
export type RelayOutcome =
  | { kind: 'confirmed'; relayRequestId: string; climbUuid: string }
  | { kind: 'holder_gone'; status: string }
  | { kind: 'unconfirmed'; cause: 'timeout' | 'refused' | 'error'; status?: string }
  | { kind: 'superseded' };

export type RelaySendArgs = {
  boardId: number;
  climb: ClimbQueueItemInput;
  angle: number | null;
  mirrored: boolean;
};

export type RelaySenderDeps = {
  relayClimb: (args: RelaySendArgs & { relayRequestId: string }) => Promise<RelayBoardClimbResult>;
  subscribeEchoes: (listener: (relayRequestId: string) => void) => () => void;
  mintId: () => string;
  timeoutMs?: number;
};

export type RelaySender = {
  /**
   * Send one climb to the holder with a fresh id and wait for its echo. Latest
   * wins: a newer send supersedes this one. A send of the climb already on its
   * way joins it instead of sending again (Put on board's press and the drive
   * it starts ask for the same climb in one tap).
   */
  send: (args: RelaySendArgs) => Promise<RelayOutcome>;
  /** Supersede the relay in flight (the climber stopped, or the board changed). */
  cancel: () => void;
  /** A relay is waiting for its echo. */
  isPending: () => boolean;
};

type Pending = {
  /** Board, climb, angle and orientation: a send with the same key joins this one. */
  sendKey: string;
  relayRequestId: string;
  climbUuid: string;
  boardId: number;
  promise: Promise<RelayOutcome>;
  settle: (outcome: RelayOutcome) => void;
};

/**
 * Relay mode (#7220): send climbs to the holder's phone and confirm each one.
 * Never retries: a relay that didn't land is said once, and the climber's
 * next press is the retry. The echo listener is attached before the request
 * goes, since the holder can echo before the mutation's own answer arrives.
 */
export function createRelaySender({
  relayClimb,
  subscribeEchoes,
  mintId,
  timeoutMs = RELAY_CONFIRM_TIMEOUT_MS,
}: RelaySenderDeps): RelaySender {
  let pending: Pending | null = null;

  const cancel = () => {
    pending?.settle({ kind: 'superseded' });
  };

  const send = (args: RelaySendArgs): Promise<RelayOutcome> => {
    const climbUuid = args.climb.climb.uuid;
    const sendKey = `${args.boardId}:${climbUuid}:${args.angle ?? ''}:${args.mirrored ? 1 : 0}`;
    if (pending && pending.sendKey === sendKey) return pending.promise;
    cancel();
    const relayRequestId = mintId();
    let settled = false;
    let resolvePromise: (outcome: RelayOutcome) => void = () => {};
    const promise = new Promise<RelayOutcome>((resolve) => {
      resolvePromise = resolve;
    });
    let unsubscribe: (() => void) | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const entry: Pending = {
      sendKey,
      relayRequestId,
      climbUuid,
      boardId: args.boardId,
      promise,
      settle: (outcome) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        timer = null;
        unsubscribe?.();
        unsubscribe = null;
        if (pending === entry) pending = null;
        resolvePromise(outcome);
      },
    };
    pending = entry;
    unsubscribe = subscribeEchoes((echoedId) => {
      if (echoedId === relayRequestId) entry.settle({ kind: 'confirmed', relayRequestId, climbUuid });
    });
    // The clock covers the whole round trip, the mutation included.
    timer = setTimeout(() => entry.settle({ kind: 'unconfirmed', cause: 'timeout' }), timeoutMs);
    relayClimb({ ...args, relayRequestId }).then(
      (result) => {
        if (result.status === 'SENT') return;
        if (HOLDER_GONE_STATUSES.has(result.status)) entry.settle({ kind: 'holder_gone', status: result.status });
        else entry.settle({ kind: 'unconfirmed', cause: 'refused', status: result.status });
      },
      () => entry.settle({ kind: 'unconfirmed', cause: 'error' }),
    );
    return promise;
  };

  return { send, cancel, isPending: () => pending !== null };
}
