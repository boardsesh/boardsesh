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

let pendingReceipt: RelayReceipt | null = null;

export function relayClockMs(): number {
  return performance.now();
}

/**
 * Record a server event that changes which climb is current on this phone.
 * Only a change counts: the echo of this phone's own move finds the climb
 * already current (the local dispatch is optimistic), and a re-broadcast of the
 * climb already up writes nothing. Either would otherwise leave a stamp that a
 * later relight of the same item would read as a relay.
 */
export function noteRelayReceipt({
  eventType,
  incomingQueueItemUuid,
  localQueueItemUuid,
  correlationId,
}: {
  eventType: RelayEventType;
  incomingQueueItemUuid: string | null | undefined;
  localQueueItemUuid: string | null | undefined;
  correlationId?: string | null;
}): void {
  if (!incomingQueueItemUuid || incomingQueueItemUuid === localQueueItemUuid) return;
  pendingReceipt = {
    queueItemUuid: incomingQueueItemUuid,
    eventType,
    correlationId: correlationId ?? null,
    receivedAt: relayClockMs(),
  };
}

/**
 * Hand the receipt to the write for that queue item, once. A write for any
 * other item leaves it: the crew moved on and a newer event replaces it.
 */
export function takeRelayReceipt(queueItemUuid: string): RelayReceipt | null {
  const receipt = pendingReceipt;
  if (!receipt || receipt.queueItemUuid !== queueItemUuid) return null;
  pendingReceipt = null;
  return receipt;
}

export function resetRelayReceiptForTests(): void {
  pendingReceipt = null;
}
