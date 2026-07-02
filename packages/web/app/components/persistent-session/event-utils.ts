import type { SessionUser, SubscriptionQueueEvent } from '@boardsesh/shared-schema';
import type { SessionUser as GeneratedSessionUser } from '@boardsesh/shared-schema/generated';
import type { ClimbQueueItem } from '@boardsesh/queue';
import { upsertRuntimeSessionUser, type SubscriptionWireEnvelope } from '@boardsesh/queue-runtime';

// Re-export pure queue utilities from the shared package — the web app used to
// have its own copies; now it delegates to the single implementation.
export { insertQueueItemIdempotent, evaluateQueueEventSequence } from '@boardsesh/queue';
export type { QueueSequenceDecision } from '@boardsesh/queue';

/**
 * Queue-state events only — `PlaybackStateChanged` is ephemeral (consumed by
 * `use-drawer-playback` for the engine; doesn't mutate queue state) and is
 * filtered out by callers before reaching `toWireEnvelope`.
 */
export type QueueStateEvent = Exclude<SubscriptionQueueEvent, { __typename: 'PlaybackStateChanged' }>;

/**
 * Adapt the wire-format `SubscriptionQueueEvent` (from `@boardsesh/shared-schema`)
 * to the runtime's structural `SubscriptionWireEnvelope<ClimbQueueItem>` (from
 * `@boardsesh/queue-runtime`). Both unions share the same `__typename` set and
 * the same aliased field names, but their `ClimbQueueItem` declarations come
 * from different packages so direct assignment isn't possible.
 *
 * Explicit per-variant rebuild + `assertNever` default rather than an
 * `as unknown as` cast: TypeScript — not runtime — surfaces drift between the
 * two unions (new variant, renamed field, narrowed field type). A silent cast
 * would let an unrecognized __typename fall through to
 * `mapSubscriptionEnvelopeToAction`'s switch which has no `default` clause and
 * would silently drop the event.
 *
 * Lives here (not in `graphql-queue/`) because the root persistent-session
 * event processor is now the primary consumer; the board-route subscription
 * hook (`use-queue-event-subscription.ts`) re-exports it for its existing
 * importers until a later workstream deletes that hook.
 */
export function toWireEnvelope(event: QueueStateEvent): SubscriptionWireEnvelope<ClimbQueueItem> {
  switch (event.__typename) {
    case 'FullSync':
      return {
        __typename: 'FullSync',
        state: {
          queue: event.state.queue,
          currentClimbQueueItem: event.state.currentClimbQueueItem,
        },
      };
    case 'QueueItemAdded':
      return {
        __typename: 'QueueItemAdded',
        addedItem: event.addedItem,
        position: event.position,
      };
    case 'QueueItemRemoved':
      return { __typename: 'QueueItemRemoved', uuid: event.uuid };
    case 'QueueReordered':
      return {
        __typename: 'QueueReordered',
        uuid: event.uuid,
        oldIndex: event.oldIndex,
        newIndex: event.newIndex,
      };
    case 'CurrentClimbChanged':
      return {
        __typename: 'CurrentClimbChanged',
        currentItem: event.currentItem,
        clientId: event.clientId,
        correlationId: event.correlationId,
      };
    case 'ClimbMirrored':
      return {
        __typename: 'ClimbMirrored',
        mirrored: event.mirrored,
        mirroredUuid: event.mirroredUuid,
      };
    default:
      return assertNever(event);
  }
}

function assertNever(unhandledEvent: never): never {
  throw new Error(`Unhandled SubscriptionQueueEvent variant: ${JSON.stringify(unhandledEvent)}`);
}

export const toSyncQueueEvent = toWireEnvelope;

/**
 * Normalize a SessionUser coming off the wire (generated GraphQL type, where
 * nullable fields are `Maybe<T>` = `T | null | undefined`) into the local
 * SessionUser shape (where `avatarUrl?: string` and `userId?: string | null`).
 * Used by reducers that ingest subscription events.
 */
export function coerceSessionUser(user: GeneratedSessionUser): SessionUser {
  return {
    id: user.id,
    username: user.username,
    isLeader: user.isLeader,
    avatarUrl: user.avatarUrl ?? undefined,
    userId: user.userId ?? null,
    connectionState: user.connectionState,
  };
}

export function upsertSessionUser(users: SessionUser[], user: SessionUser): SessionUser[] {
  return upsertRuntimeSessionUser(users, user);
}
