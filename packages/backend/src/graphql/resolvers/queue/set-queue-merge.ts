/**
 * Merge-on-write for `setQueue` (issue #3933, residual of #3906).
 *
 * `setQueue` replaces the whole queue with a client-composed payload. Between
 * the moment a client composes that payload and the moment the server writes
 * it, a party member's `addQueueItem` can land — and the wholesale write throws
 * it away. Nothing detects the loss: the server's own post-write state is
 * internally consistent, so the client hash watchdog stays quiet.
 *
 * The fix rides on infrastructure that already exists. Every sequence-consuming
 * queue event is written to the per-session replay buffer (`pubsub`,
 * 100 entries / 5-minute TTL, Redis only), and the client sync gate already
 * tracks the last sequence it APPLIED. Given that baseline, the server can
 * replay the window and re-append the adds the client never saw.
 *
 * Deliberately conservative: this returns `degraded` — meaning "fall back to
 * the legacy wholesale overwrite" — for every case where the buffer cannot be
 * trusted to describe the window completely, rather than merging on partial
 * evidence. A partial merge that silently dropped an add would be the original
 * bug wearing a fix's clothes.
 */
import type { ClimbQueueItem, QueueEvent } from '@boardsesh/shared-schema';

/** Sequence-buffer read seam. Injected so tests drive it without a live Redis. */
export type QueueEventReader = (sessionId: string, sinceSequence: number) => Promise<QueueEvent[]>;

export type ConcurrentAddMergeResult =
  /** The window is fully described; `survivors` are the peer adds to re-append. */
  | { status: 'merged'; survivors: ClimbQueueItem[] }
  /** The buffer can't describe the window — caller must use the legacy overwrite. */
  | { status: 'degraded'; reason: DegradeReason };

export type DegradeReason =
  /** `getEventsSince` threw (Redis down mid-call, parse failure). */
  | 'buffer-read-failed'
  /**
   * The newest buffered sequence is behind the committed queue state. The
   * buffer write is fire-and-forget and happens strictly AFTER the CAS commits
   * (`publishQueueEvent` -> `storeEventInBuffer(...).catch(...)`), so a peer's
   * add can be in `currentState.queue` with no buffered `QueueItemAdded` yet.
   * Merging here would drop exactly the item this fix exists to save.
   */
  | 'buffer-lag'
  /**
   * The buffer no longer reaches back to the client's baseline — evicted past
   * 100 events, or expired past the 5-minute TTL. Adds older than the buffer's
   * oldest entry are invisible, so a merge would be partial.
   */
  | 'buffer-coverage';

/** How long to wait before re-reading a buffer that looked behind the state. */
export const BUFFER_LAG_REFETCH_DELAY_MS = 25;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Work out which climbs a peer added inside the `setQueue` window and are
 * missing from the incoming payload.
 *
 * `callerClientId` is the caller's own connection id. Its own adds are excluded
 * — a client's `addQueueItem` only advances its sync gate once the subscription
 * ECHO arrives, so a `setQueue` fired before that echo has a baseline older
 * than its own add. Re-appending it would resurrect a climb the caller just
 * deliberately replaced away. Compared non-null only: `clientId` is coerced to
 * null for anonymous connections and two nulls must never match.
 */
export async function collectConcurrentAdds(params: {
  sessionId: string;
  /** Last server sequence the client had applied when it composed the payload. */
  baselineSequence: number;
  /** uuids in the incoming payload — already-present items are never survivors. */
  incomingUuids: ReadonlySet<string>;
  /** Freshly read server state the write will CAS against. */
  currentState: { queue: ClimbQueueItem[]; sequence: number };
  callerClientId: string | null;
  readEvents: QueueEventReader;
}): Promise<ConcurrentAddMergeResult> {
  const { sessionId, baselineSequence, incomingUuids, currentState, callerClientId, readEvents } = params;

  // Client is level with (or ahead of) the committed state: no window to merge.
  // Ahead happens legitimately — the caller's own earlier mutation bumped the
  // sequence and the gate applied the echo before this call.
  if (currentState.sequence <= baselineSequence) {
    return { status: 'merged', survivors: [] };
  }

  // Read the WHOLE buffer (not just events after the baseline) so both ends can
  // be checked: the newest entry proves the buffer has caught up with the
  // committed state, the oldest proves it still reaches back to the baseline.
  let events: QueueEvent[];
  try {
    events = await readEvents(sessionId, 0);
  } catch {
    return { status: 'degraded', reason: 'buffer-read-failed' };
  }

  if (newestSequence(events) < currentState.sequence) {
    // The buffer LPUSH may simply still be in flight. Give it one chance.
    await sleep(BUFFER_LAG_REFETCH_DELAY_MS);
    try {
      events = await readEvents(sessionId, 0);
    } catch {
      return { status: 'degraded', reason: 'buffer-read-failed' };
    }
    if (newestSequence(events) < currentState.sequence) {
      // Also the resting state when a buffer write failed outright —
      // `storeEventInBuffer` swallows its own errors, leaving a permanent gap
      // that no amount of waiting closes.
      return { status: 'degraded', reason: 'buffer-lag' };
    }
  }

  // Sequences are contiguous across buffered events (every write increments by
  // one and publishes; only `PlaybackStateChanged` reuses a sequence and it is
  // never buffered). So the buffer covers the baseline exactly when its oldest
  // entry is the very next sequence after it.
  if (oldestSequence(events) > baselineSequence + 1) {
    return { status: 'degraded', reason: 'buffer-coverage' };
  }

  // Fold the window in ascending sequence order (`getEventsSince` sorts) so a
  // later remove cancels an earlier add and a re-add revives it.
  const addedByPeers = new Set<string>();
  for (const event of events) {
    if (event.sequence <= baselineSequence) continue;
    if (event.__typename === 'QueueItemAdded') {
      if (callerClientId !== null && event.clientId === callerClientId) continue;
      addedByPeers.add(event.item.uuid);
    } else if (event.__typename === 'QueueItemRemoved') {
      addedByPeers.delete(event.uuid);
    }
  }

  // Take the survivor bodies from committed server state rather than the
  // buffered event, so a later `replaceQueueItem` on the same uuid wins, and
  // an add already undone by some other path never resurrects.
  const seen = new Set<string>();
  const survivors: ClimbQueueItem[] = [];
  for (const item of currentState.queue) {
    if (!addedByPeers.has(item.uuid)) continue;
    if (incomingUuids.has(item.uuid)) continue;
    if (seen.has(item.uuid)) continue;
    seen.add(item.uuid);
    survivors.push(item);
  }

  return { status: 'merged', survivors };
}

function newestSequence(events: QueueEvent[]): number {
  let newest = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.sequence > newest) newest = event.sequence;
  }
  return newest;
}

function oldestSequence(events: QueueEvent[]): number {
  let oldest = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.sequence < oldest) oldest = event.sequence;
  }
  return oldest;
}
