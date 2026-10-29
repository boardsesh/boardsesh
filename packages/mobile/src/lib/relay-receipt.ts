// When did this phone hear that the crew moved the wall? (#7014)
//
// A crewmate's Put on the wall reaches the phone holding the board as a
// `CurrentClimbChanged` (or a `FullSync` in now-slot mode) on the queue stream,
// and the BLE auto-sender writes the climb a React render later. QA measured
// 2 to 8 s end to end with the holder pocketed, and nothing on that path waits
// on purpose, so the auto-sender reports the two app stages it can see: event
// receipt to write start, and the write itself. This module carries the
// receipt time from the queue stream (use-session-realtime.ts) to the
// auto-sender (bluetooth-provider.tsx) without either importing the other.
//
// Instrumentation only. Times are `performance.now()` so a frozen screenshot
// clock or a wall-clock jump cannot produce a negative stage.

export type RelayEventType = 'CurrentClimbChanged' | 'FullSync';

export type RelayReceipt = {
  /** Queue-item uuid the event made current: the auto-sender's write target. */
  queueItemUuid: string;
  eventType: RelayEventType;
  /** The sender's correlation id, when the event carries one. */
  correlationId: string | null;
  /** `performance.now()` when the event reached the queue stream handler. */
  receivedAt: number;
};

/**
 * A receipt older than this is not a relay any more. The auto-sender can skip
 * the item (no board connected, the 4 h hold, the off-screen adopt gate, a
 * byte-identical dedup) and write it much later on a reconnect or a Put on the
 * wall; that wait is the climber's, not the pipeline's. QA's slowest relay was
 * about 8 s, so 30 s keeps every real one with room to spare.
 */
export const RELAY_RECEIPT_MAX_AGE_MS = 30_000;

let pendingReceipt: RelayReceipt | null = null;

/**
 * Queue items this phone put on the wall itself, with when. A now-slot open's
 * echo is a `FullSync`, which carries no correlation id or client id, so this
 * is the only way to tell that echo from a crewmate's move (#7014 review). A
 * crewmate moving the wall back to the same item inside the window is missed:
 * a lost sample, never a wrong one.
 */
const ownMoves = new Map<string, number>();
const MAX_TRACKED_OWN_MOVES = 32;

function isRecentOwnMove(queueItemUuid: string, now: number): boolean {
  const movedAt = ownMoves.get(queueItemUuid);
  return movedAt !== undefined && now - movedAt <= RELAY_RECEIPT_MAX_AGE_MS;
}

/** This phone sent a move to this queue item (a fresh send or a re-send). */
export function noteOwnMove(queueItemUuid: string): void {
  const now = relayClockMs();
  ownMoves.delete(queueItemUuid);
  ownMoves.set(queueItemUuid, now);
  for (const [uuid, movedAt] of ownMoves) {
    if (ownMoves.size <= MAX_TRACKED_OWN_MOVES && now - movedAt <= RELAY_RECEIPT_MAX_AGE_MS) break;
    ownMoves.delete(uuid);
  }
  // The climber picked it here, so its write is not a relay any more.
  if (pendingReceipt?.queueItemUuid === queueItemUuid) pendingReceipt = null;
}

export function relayClockMs(): number {
  return performance.now();
}

/**
 * Record a server event that changes which climb is current on this phone.
 * Only a crewmate's change counts. Left out, so they cannot leave a stamp that
 * a later write of the same item would read as a relay:
 * - a re-broadcast of the climb already current (it writes nothing);
 * - an echo the caller recognised as this phone's own (`ownEcho`: its
 *   correlation id is still pending, or it names this connection's client id),
 *   which matters when the climber moved on again before the echo arrived;
 * - any event for an item this phone moved to itself in the last
 *   `RELAY_RECEIPT_MAX_AGE_MS`, which covers the now-slot `FullSync` echo.
 */
export function noteRelayReceipt({
  eventType,
  incomingQueueItemUuid,
  localQueueItemUuid,
  correlationId,
  ownEcho = false,
}: {
  eventType: RelayEventType;
  incomingQueueItemUuid: string | null | undefined;
  localQueueItemUuid: string | null | undefined;
  correlationId?: string | null;
  ownEcho?: boolean;
}): void {
  if (!incomingQueueItemUuid || incomingQueueItemUuid === localQueueItemUuid || ownEcho) return;
  const receivedAt = relayClockMs();
  if (isRecentOwnMove(incomingQueueItemUuid, receivedAt)) return;
  pendingReceipt = {
    queueItemUuid: incomingQueueItemUuid,
    eventType,
    correlationId: correlationId ?? null,
    receivedAt,
  };
}

/**
 * Hand the receipt to the write for that queue item, once. A write for any
 * other item leaves it: the crew moved on and a newer event replaces it. A
 * receipt past `RELAY_RECEIPT_MAX_AGE_MS` is dropped instead of reported.
 */
export function takeRelayReceipt(queueItemUuid: string): RelayReceipt | null {
  const receipt = pendingReceipt;
  if (!receipt) return null;
  if (relayClockMs() - receipt.receivedAt > RELAY_RECEIPT_MAX_AGE_MS) {
    pendingReceipt = null;
    return null;
  }
  if (receipt.queueItemUuid !== queueItemUuid) return null;
  pendingReceipt = null;
  return receipt;
}

/** Forget everything: the session ended or the climber signed out. */
export function clearRelayReceipt(): void {
  pendingReceipt = null;
  ownMoves.clear();
}
