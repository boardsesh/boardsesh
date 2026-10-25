/**
 * Queue sync coordinator — protocol-level glue between WebSocket queue events
 * and the pure queueReducer. No React, no DOM, no network access.
 *
 * Responsibilities:
 *   1. `mapQueueEventToAction` — pure mapping from a normalized WebSocket queue
 *      event to a reducer action. Centralizes the field-name normalization
 *      (web uses `addedItem`/`currentItem`; mobile uses `item`) and the echo
 *      hints (myClientId, serverCorrelationId) the reducer needs.
 *   2. `createQueueSyncCoordinator` — small stateful factory that owns the
 *      client identity and tracks pending correlation IDs with auto-cleanup
 *      via injected timer + dispatch adapters. The reducer's
 *      `pendingCurrentClimbUpdates` slice is still the source of truth; this
 *      coordinator just guarantees stale IDs get pruned even if no echo
 *      arrives.
 *
 * Apps own subscription lifecycle, network calls, analytics, and storage —
 * the coordinator stays platform-agnostic.
 */

import type { ClimbQueueItem, QueueAction, QueueSearchParams } from './types';

/**
 * Wide event union — structurally compatible with web's
 * `SubscriptionQueueEvent` from `@boardsesh/shared-schema` and with mobile's
 * inline `QueueUpdateEvent` types. Field-name aliases (`item` vs `addedItem`,
 * `item` vs `currentItem`) are both accepted; the coordinator picks whichever
 * is present.
 */
export type SyncQueueEvent =
  | {
      __typename: 'FullSync';
      state: {
        queue: ClimbQueueItem[];
        currentClimbQueueItem: ClimbQueueItem | null;
        /** The History / Up next line (F3). Absent or null from a pre-F3 server or a legacy document. */
        historyCount?: number | null;
        /** When the room's current climb last changed (ISO 8601). Absent or null like `historyCount`. */
        currentChangedAt?: string | null;
      };
    }
  | {
      __typename: 'QueueItemAdded';
      addedItem?: ClimbQueueItem;
      item?: ClimbQueueItem;
      position?: number | null;
    }
  | {
      __typename: 'QueueItemRemoved';
      uuid: string;
    }
  | {
      __typename: 'QueueReordered';
      uuid: string;
      oldIndex: number;
      newIndex: number;
    }
  | {
      __typename: 'CurrentClimbChanged';
      currentItem?: ClimbQueueItem | null;
      item?: ClimbQueueItem | null;
      clientId?: string | null;
      correlationId?: string | null;
    }
  | {
      __typename: 'ClimbMirrored';
      mirrored: boolean;
      mirroredUuid?: string | null;
    };

export type MapEventContext = {
  /** This client's stable id, used for fallback echo suppression. */
  myClientId?: string | null;
};

export type EventMappingResult<TSearchParams extends QueueSearchParams = QueueSearchParams> =
  | {
      kind: 'dispatch';
      action: QueueAction<TSearchParams>;
      eventType: SyncQueueEvent['__typename'];
      /** The climb item the event carried, if any. Useful for callers that
       * want to attach analytics (e.g. "added by peer"). */
      item?: ClimbQueueItem | null;
    }
  | { kind: 'ignore'; eventType: SyncQueueEvent['__typename']; reason: string };

/**
 * Pure mapping from a WebSocket queue event to a reducer action.
 * Returns `kind: 'ignore'` for events that carry malformed payloads
 * (e.g., QueueItemAdded with no item). Apps should still treat the absence
 * of a dispatch as a soft signal that something is off.
 */
export function mapQueueEventToAction<TSearchParams extends QueueSearchParams = QueueSearchParams>(
  event: SyncQueueEvent,
  context?: MapEventContext,
): EventMappingResult<TSearchParams> {
  switch (event.__typename) {
    case 'FullSync': {
      return {
        kind: 'dispatch',
        eventType: 'FullSync',
        action: {
          type: 'INITIAL_QUEUE_DATA',
          payload: {
            queue: event.state.queue,
            currentClimbQueueItem: event.state.currentClimbQueueItem,
            // The reducer keeps it only in now-slot mode; legacy mode ignores it.
            historyCount: event.state.historyCount ?? null,
            // Read by the mobile provider's #4979 hold clock, never by the reducer.
            currentChangedAt: event.state.currentChangedAt ?? null,
          },
        },
      };
    }

    case 'QueueItemAdded': {
      const added = event.addedItem ?? event.item;
      if (!added) {
        return { kind: 'ignore', eventType: 'QueueItemAdded', reason: 'no item payload' };
      }
      return {
        kind: 'dispatch',
        eventType: 'QueueItemAdded',
        item: added,
        action: {
          type: 'DELTA_ADD_QUEUE_ITEM',
          payload: { item: added, position: event.position ?? undefined },
        },
      };
    }

    case 'QueueItemRemoved': {
      return {
        kind: 'dispatch',
        eventType: 'QueueItemRemoved',
        action: { type: 'DELTA_REMOVE_QUEUE_ITEM', payload: { uuid: event.uuid } },
      };
    }

    case 'QueueReordered': {
      return {
        kind: 'dispatch',
        eventType: 'QueueReordered',
        action: {
          type: 'DELTA_REORDER_QUEUE_ITEM',
          payload: { uuid: event.uuid, oldIndex: event.oldIndex, newIndex: event.newIndex },
        },
      };
    }

    case 'CurrentClimbChanged': {
      const incoming = event.currentItem !== undefined ? event.currentItem : (event.item ?? null);
      // Always request insertion when there's an incoming item — the reducer's
      // idempotent guard skips climbs already in the queue. This is the safe
      // default for two reasons:
      //   1. Slim subscription payloads (mobile uses uuid/name/frames only) don't
      //      carry `suggested`, so gating on incoming?.suggested would silently
      //      drop legitimate inserts after a dropped QueueItemAdded on reconnect.
      //   2. Browsing-only navigations on web already pass non-suggested items
      //      that exist in the queue, so the idempotent guard makes
      //      shouldAddToQueue:true a no-op there.
      // When the item does need inserting (not already queued), place it right
      // after the current climb, not at the end (issue #2217) — a peer lighting
      // up a new climb should slot it into the "up next" position, matching the
      // local "set climb active" behaviour instead of bumping it to the bottom.
      return {
        kind: 'dispatch',
        eventType: 'CurrentClimbChanged',
        item: incoming,
        action: {
          type: 'DELTA_UPDATE_CURRENT_CLIMB',
          payload: {
            item: incoming,
            shouldAddToQueue: incoming != null,
            insertAfterCurrent: true,
            isServerEvent: true,
            eventClientId: event.clientId ?? undefined,
            myClientId: context?.myClientId ?? undefined,
            serverCorrelationId: event.correlationId ?? undefined,
          },
        },
      };
    }

    case 'ClimbMirrored': {
      return {
        kind: 'dispatch',
        eventType: 'ClimbMirrored',
        action: {
          type: 'DELTA_MIRROR_CURRENT_CLIMB',
          payload: { mirrored: event.mirrored, mirroredUuid: event.mirroredUuid ?? null },
        },
      };
    }
  }
}

/** Default TTL for pending correlation IDs (ms). Anything not echoed back
 *  within this window is presumed dropped, and we prune it from the
 *  reducer's pending set so it doesn't suppress a future genuine event. */
export const DEFAULT_PENDING_TTL_MS = 30_000;

export type ScheduleCleanupFn = (callback: () => void, delayMs: number) => () => void;

export type SyncCoordinatorOptions<TSearchParams extends QueueSearchParams = QueueSearchParams> = {
  /** Apps inject their reducer dispatch so the coordinator can prune
   *  pending correlation IDs on cleanup timeout. */
  dispatch: (action: QueueAction<TSearchParams>) => void;
  /** Stable identity for this client; auto-generated if omitted. Web reads
   *  this from `persistentSession.clientId`; mobile generates and persists. */
  clientId?: string;
  /** Override for tests; defaults to crypto-backed UUID generator. */
  generateId?: () => string;
  /** Override for tests / RN; defaults to setTimeout+clearTimeout. The
   *  returned function cancels the scheduled callback. */
  scheduleCleanup?: ScheduleCleanupFn;
  /** Pending correlation ID TTL in ms (default 30s). */
  pendingTtlMs?: number;
};

export type SyncCoordinator<TSearchParams extends QueueSearchParams = QueueSearchParams> = {
  readonly clientId: string;
  generateCorrelationId(): string;
  /** Track a correlation ID for an in-flight local mutation. The reducer's
   *  echo-suppression logic will match against the pending set; this
   *  coordinator schedules a cleanup dispatch after `ttlMs` so the entry is
   *  pruned even if the echo never arrives. */
  trackPendingMutation(correlationId: string, ttlMs?: number): void;
  /** Convenience wrapper around `mapQueueEventToAction` that always passes
   *  this coordinator's clientId. */
  mapIncomingEvent(event: SyncQueueEvent): EventMappingResult<TSearchParams>;
  /** Cancel all in-flight cleanup timers. Call on provider unmount. */
  dispose(): void;
};

const defaultScheduleCleanup: ScheduleCleanupFn = (callback, delayMs) => {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
};

export function generateClientId(): string {
  return generateId();
}

export function generateCorrelationId(): string {
  return generateId();
}

function generateId(): string {
  const cryptoObj: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined' && (globalThis as { crypto?: { randomUUID?: () => string } }).crypto
      ? (globalThis as { crypto: { randomUUID?: () => string } }).crypto
      : undefined;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 11)}`;
}

export function createQueueSyncCoordinator<TSearchParams extends QueueSearchParams = QueueSearchParams>(
  options: SyncCoordinatorOptions<TSearchParams>,
): SyncCoordinator<TSearchParams> {
  const generate = options.generateId ?? generateId;
  const schedule = options.scheduleCleanup ?? defaultScheduleCleanup;
  const ttl = options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
  const clientId = options.clientId ?? generate();
  const cancelByCorrelationId = new Map<string, () => void>();

  return {
    clientId,
    generateCorrelationId: () => generate(),
    trackPendingMutation(correlationId, ttlMs) {
      const previousCancel = cancelByCorrelationId.get(correlationId);
      if (previousCancel) previousCancel();
      const cancel = schedule(() => {
        cancelByCorrelationId.delete(correlationId);
        options.dispatch({
          type: 'CLEANUP_PENDING_UPDATE',
          payload: { correlationId },
        });
      }, ttlMs ?? ttl);
      cancelByCorrelationId.set(correlationId, cancel);
    },
    mapIncomingEvent(event) {
      return mapQueueEventToAction<TSearchParams>(event, { myClientId: clientId });
    },
    dispose() {
      for (const cancel of cancelByCorrelationId.values()) cancel();
      cancelByCorrelationId.clear();
    },
  };
}
