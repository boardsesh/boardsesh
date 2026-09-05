// The item-level wire contract, shared by web and mobile.
//
// A queue item is more than its climb: `addedBy` / `addedByUser` are who put it
// on the wall, `tickedBy` is who has sent it this session, and `suggested` marks
// a playlist suggestion. Dropping any of them on the way out does NOT merely
// leave the field blank for peers — it FLAPS. The client that omits it rebuilds
// every peer item without it, and its next full-queue write pushes the gap back
// to the whole crew, so the originator loses it too on the following FullSync.
// That is exactly the failure #3927 fixed at the climb level and #3995 fixed at
// the item level (mobile shipped a `{ uuid, climb }` mapper and anonymised every
// climb queued from a phone).
//
// Pure TS, no React — it lives in @boardsesh/queue-react because that package
// already owns the mutation wire contract and already depends on shared-schema
// (@boardsesh/queue deliberately has zero dependencies and cannot name
// `ClimbQueueItemInput`). Imported through the `./queue-item-input` subpath so
// the nine mobile provider suites that whole-module-mock `@boardsesh/queue-react`
// still get the real mapper.
import type { ClimbInput, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { stripPrivateClimbFields } from '@boardsesh/queue';
import type { QueueItemUser } from '@boardsesh/queue';

/**
 * The identity a client stamps onto an item IT introduces. `addedBy` is the
 * connection clientId (legacy attribution); `addedByUser` is the party profile
 * the queue row renders an avatar from.
 */
export type QueueItemAttribution = {
  addedBy: string | null;
  addedByUser?: QueueItemUser;
};

/**
 * The item shape both platforms' local queue items structurally satisfy. Generic
 * over the climb so each platform keeps its own local Climb type and supplies its
 * own `toClimbInput`.
 */
export type WireBoundQueueItem<TClimb> = {
  uuid: string;
  climb: TClimb;
  addedBy?: string | null;
  addedByUser?: QueueItemUser;
  tickedBy?: (string | null)[] | null;
  suggested?: boolean | null;
};

/**
 * Compile-time exhaustiveness guard: `satisfies Record<keyof ClimbQueueItemInput,
 * true>` turns typecheck RED the moment a seventh field lands on the GraphQL
 * input without this mapper learning to send it. Tests compare the mapper's own
 * `Object.keys` against this set, so neither side can be hand-edited into
 * agreement with a stale field list.
 */
export const WIRE_ITEM_FIELDS = {
  uuid: true,
  climb: true,
  addedBy: true,
  addedByUser: true,
  tickedBy: true,
  suggested: true,
} satisfies Record<keyof ClimbQueueItemInput, true>;

/**
 * Map a local queue item to the GraphQL `ClimbQueueItemInput`.
 *
 * Deliberately a pure passthrough: no identity fallback lives here. Stamping
 * "me" onto an unattributed item at the WIRE would claim authorship of every
 * peer item on the next full-queue write — including one a peer added before
 * their profile resolved. Attribution belongs at item CONSTRUCTION, where the
 * client knows the item is its own.
 */
export function toClimbQueueItemInput<TClimb>(
  item: WireBoundQueueItem<TClimb>,
  toClimbInput: (climb: TClimb) => ClimbInput,
): ClimbQueueItemInput {
  return {
    uuid: item.uuid,
    // Strip the private per-climber fields on the way out (`myDifficulty`, the
    // climber's own grade). Each platform's `toClimbInput` enumerates its
    // fields, so today nothing gets through anyway — this is the guard that
    // holds the day one of them starts spreading a climb. See
    // PRIVATE_CLIMB_FIELDS in @boardsesh/queue.
    climb: stripPrivateClimbFields(toClimbInput(item.climb)),
    // Left undefined (not coerced to null) when absent, matching what web has
    // always written — a null would overwrite a peer's value on the server.
    addedBy: item.addedBy,
    addedByUser: item.addedByUser
      ? {
          id: item.addedByUser.id,
          username: item.addedByUser.username,
          avatarUrl: item.addedByUser.avatarUrl,
        }
      : undefined,
    // The wire type is `[String!]` — drop local nulls rather than send a value
    // the server would reject.
    tickedBy: item.tickedBy?.filter((id): id is string => id !== null),
    suggested: item.suggested,
  };
}
