/**
 * F3 now-slot mode, the mobile half (#6666; docs/current-climb-outside-queue.md
 * sections 2 and 7): the per-connect server probe, its telemetry, and the
 * whole-queue clamp that follows the probe.
 */
import { clampNowSlotPayload, clampQueueAroundCurrent, type ClimbQueueItem } from '@boardsesh/queue';
import { SHARED_EVENTS } from '@boardsesh/analytics';
import { execute, type ClientSource } from '@boardsesh/graphql-client';
import { QUEUE_CAPABILITIES_PROBE } from '@boardsesh/graphql/operations/queue-session';
import { track } from '../../lib/analytics';

/** The `QueueState` fields a backend must serve before a phone sends the `_NOW_SLOT` documents. */
const NOW_SLOT_QUEUE_STATE_FIELDS = ['historyCount', 'currentChangedAt'] as const;

type QueueCapabilitiesProbeResponse = {
  queueState?: { fields?: ReadonlyArray<{ name: string }> | null } | null;
  currentClimbChanged?: { fields?: ReadonlyArray<{ name: string }> | null } | null;
};

export type QueueServerCapabilities = { nowSlot: boolean; attribution: boolean };

/** Probe every connection, including when the now-slot feature flag is off. */
export async function probeQueueServerCapabilities(client: ClientSource): Promise<QueueServerCapabilities> {
  try {
    const response = await execute<QueueCapabilitiesProbeResponse>(client, { query: QUEUE_CAPABILITIES_PROBE });
    const stateFields = new Set((response?.queueState?.fields ?? []).map(({ name }) => name));
    const eventFields = new Set((response?.currentClimbChanged?.fields ?? []).map(({ name }) => name));
    return {
      nowSlot: NOW_SLOT_QUEUE_STATE_FIELDS.every((fieldName) => stateFields.has(fieldName)),
      attribution: stateFields.has('currentChangedBy') && eventFields.has('currentChangedBy'),
    };
  } catch (probeError) {
    if (__DEV__) console.warn('[queue] Server capability probe failed; staying on legacy documents', probeError);
    return { nowSlot: false, attribution: false };
  }
}

/** Only schema validation failures permit an actor-free retry. */
export function isAttributionValidationError(error: unknown): boolean {
  if (Array.isArray(error)) return error.some((entry: unknown) => isAttributionValidationError(entry));
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
          ? error.message
          : '';
  return (
    message.includes('currentChangedBy') && /cannot query field|graphql_validation_failed|is not defined/i.test(message)
  );
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
