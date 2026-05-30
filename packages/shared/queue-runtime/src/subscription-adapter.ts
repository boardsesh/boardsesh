// Wire-format normaliser for queue subscription events.
//
// Web's `SubscriptionQueueEvent` (from `@boardsesh/shared-schema`) and
// mobile's locally-defined `QueueUpdateEvent` describe the same protocol but
// each carries its own item shape: web's already matches `ClimbQueueItem`,
// mobile's is a slim subscription-only payload that needs an explicit lift.
// Centralizing the lift here (a) removes ~110 lines of inline normalization
// from `packages/mobile/src/providers/queue-provider.tsx`, and (b) documents
// the wire contract in one place so a schema change won't silently diverge
// between platforms.

import {
  mapQueueEventToAction,
  type ClimbQueueItem,
  type EventMappingResult,
  type MapEventContext,
  type SyncQueueEvent,
} from '@boardsesh/queue';

/**
 * The wire envelope shape we accept. Structurally compatible with both web's
 * `SubscriptionQueueEvent` and mobile's `QueueUpdateEvent`. Both alias
 * conventions are accepted: `addedItem`/`item` on QueueItemAdded,
 * `currentItem`/`item` on CurrentClimbChanged, `mirroredUuid`/`uuid` on
 * ClimbMirrored.
 */
export type SubscriptionWireEnvelope<TWireItem> =
  | {
      __typename: 'FullSync';
      state: {
        queue: TWireItem[];
        currentClimbQueueItem: TWireItem | null;
      };
    }
  | {
      __typename: 'QueueItemAdded';
      addedItem?: TWireItem;
      item?: TWireItem;
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
      currentItem?: TWireItem | null;
      item?: TWireItem | null;
      clientId?: string | null;
      correlationId?: string | null;
    }
  | {
      __typename: 'ClimbMirrored';
      mirrored: boolean;
      mirroredUuid?: string | null;
      uuid?: string | null;
    };

export type MapEnvelopeOptions<TWireItem> = {
  /** Lift the wire item shape to the reducer's `ClimbQueueItem`. Defaults
   *  to identity — web's wire items already match. Mobile passes
   *  `toClimbQueueItem` from `packages/mobile/src/lib/queue-conversion.ts`. */
  mapItem?: (item: TWireItem) => ClimbQueueItem;
  /** Pass-through to `mapQueueEventToAction` for echo suppression. */
  context?: MapEventContext;
};

/**
 * Normalise a wire subscription envelope into a reducer dispatch decision.
 * Combines the per-platform item lift with the shared
 * `mapQueueEventToAction` so callers only carry their reducer dispatch.
 */
export function mapSubscriptionEnvelopeToAction<TWireItem>(
  envelope: SubscriptionWireEnvelope<TWireItem>,
  options: MapEnvelopeOptions<TWireItem> = {},
): EventMappingResult {
  const lift = options.mapItem ?? ((item: TWireItem) => item as unknown as ClimbQueueItem);
  const syncEvent = liftEnvelopeToSyncEvent(envelope, lift);
  return mapQueueEventToAction(syncEvent, options.context);
}

function liftEnvelopeToSyncEvent<TWireItem>(
  envelope: SubscriptionWireEnvelope<TWireItem>,
  lift: (item: TWireItem) => ClimbQueueItem,
): SyncQueueEvent {
  switch (envelope.__typename) {
    case 'FullSync':
      return {
        __typename: 'FullSync',
        state: {
          queue: envelope.state.queue.map(lift),
          currentClimbQueueItem:
            envelope.state.currentClimbQueueItem === null ? null : lift(envelope.state.currentClimbQueueItem),
        },
      };
    case 'QueueItemAdded': {
      const wireItem = envelope.addedItem ?? envelope.item;
      return {
        __typename: 'QueueItemAdded',
        item: wireItem ? lift(wireItem) : undefined,
        position: envelope.position ?? null,
      };
    }
    case 'QueueItemRemoved':
      return { __typename: 'QueueItemRemoved', uuid: envelope.uuid };
    case 'QueueReordered':
      return {
        __typename: 'QueueReordered',
        uuid: envelope.uuid,
        oldIndex: envelope.oldIndex,
        newIndex: envelope.newIndex,
      };
    case 'CurrentClimbChanged': {
      const wireItem = envelope.currentItem !== undefined ? envelope.currentItem : envelope.item;
      return {
        __typename: 'CurrentClimbChanged',
        item: wireItem == null ? null : lift(wireItem),
        clientId: envelope.clientId ?? null,
        correlationId: envelope.correlationId ?? null,
      };
    }
    case 'ClimbMirrored':
      return {
        __typename: 'ClimbMirrored',
        mirrored: envelope.mirrored,
        mirroredUuid: envelope.mirroredUuid ?? envelope.uuid ?? null,
      };
  }
}
