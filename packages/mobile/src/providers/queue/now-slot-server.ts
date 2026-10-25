/**
 * F3 now-slot mode, the mobile half (#6666; docs/current-climb-outside-queue.md
 * sections 2 and 7): the per-connect server probe, its telemetry, and the
 * whole-queue clamp that follows the probe.
 */
import { clampNowSlotPayload, clampQueueAroundCurrent, type ClimbQueueItem } from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { execute, type ClientSource } from '@boardsesh/graphql-client';
import { QUEUE_STATE_FIELDS_PROBE } from '@boardsesh/graphql/operations/queue-session';
import { track } from '../../lib/analytics';

/** The `QueueState` fields a backend must serve before a phone sends the `_NOW_SLOT` documents. */
const NOW_SLOT_QUEUE_STATE_FIELDS = ['historyCount', 'currentChangedAt'] as const;

type QueueStateFieldsProbeResponse = {
  __type?: { fields?: ReadonlyArray<{ name: string }> | null } | null;
};

/**
 * Does the backend behind `client` serve the Now slot fields? One
 * `__type(name: "QueueState")` query, run on every socket connect before the
 * join; the caller caches the answer for that connection. Fails closed: any
 * error reads as a backend without F3, so the phone keeps today's documents.
 */
export async function probeNowSlotServer(client: ClientSource): Promise<boolean> {
  try {
    const response = await execute<QueueStateFieldsProbeResponse>(client, { query: QUEUE_STATE_FIELDS_PROBE });
    const fieldNames = new Set((response?.__type?.fields ?? []).map(({ name }) => name));
    return NOW_SLOT_QUEUE_STATE_FIELDS.every((fieldName) => fieldNames.has(fieldName));
  } catch (probeError) {
    if (__DEV__) console.warn('[queue] Now slot server probe failed; staying on the legacy documents', probeError);
    return false;
  }
}

let reportedNowSlotServerThisLaunch = false;

/**
 * `Queue Server Probe`: at most once per launch while the answer is yes, and on
 * every no. A no after the F3 backend is live, outside a deploy window, means a
 * rollback or a broken probe.
 */
export function reportQueueServerProbe(nowSlotServer: boolean, fallback: 'probe' | 'validation-error'): void {
  if (nowSlotServer) {
    if (reportedNowSlotServerThisLaunch) return;
    reportedNowSlotServerThisLaunch = true;
  }
  track(SHARED_EVENTS.QueueServerProbe, { nowSlotServer, fallback });
}

/** Test-only: forget that this launch already reported a yes. */
export function resetQueueServerProbeReportForTests(): void {
  reportedNowSlotServerThisLaunch = false;
}

export type SyncedQueuePayload = {
  queue: ClimbQueueItem[];
  /** The line to send with `setQueue`; null in legacy mode, where the document has no such argument. */
  historyCount: number | null;
};

/**
 * The whole-queue payload for `setQueue` (a local replace, the session seed and
 * its re-seed). The clamp follows the server probe (section 5, release order):
 * in now-slot mode the climb on the wall is extra and History is trimmed first,
 * so a 501-entry room is written back whole; in legacy mode it keeps 500
 * entries in all, because a backend before F3 refuses 501.
 */
export function clampSyncedQueue(
  queue: ClimbQueueItem[],
  currentClimbQueueItem: ClimbQueueItem | null | undefined,
  historyCount: number | null | undefined,
  nowSlotMode: boolean,
): SyncedQueuePayload {
  if (!nowSlotMode) return { queue: clampQueueAroundCurrent(queue, currentClimbQueueItem), historyCount: null };
  const clamped = clampNowSlotPayload({ queue, currentClimbQueueItem: currentClimbQueueItem ?? null, historyCount });
  return { queue: clamped.queue, historyCount: clamped.historyCount };
}
