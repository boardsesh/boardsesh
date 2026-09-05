import { randomUUID } from 'expo-crypto';
import type { Climb, ClimbInput, ClimbQueueItemInput } from '@boardsesh/shared-schema';
import { isPlaylistPeekQueueItemUuid, type ClimbQueueItem } from '@boardsesh/queue';
// Subpath import, not the barrel: nine queue-provider suites whole-module-mock
// `@boardsesh/queue-react`, and this module sits in all of their graphs.
import { toClimbQueueItemInput } from '@boardsesh/queue-react/queue-item-input';

// `isClimbResolved` lives in ./queue-climb-resolution (no expo-crypto import) so
// the shared visual can pull the predicate without this module's native deps.
export { isClimbResolved } from './queue-climb-resolution';

/**
 * Map a `Climb` to the GraphQL `ClimbInput` for queue mutations. `ClimbInput` is
 * a strict subset of `Climb` — sending extra fields (notably `created_at`, which
 * search results carry but `ClimbInput` does not define) makes the server reject
 * the whole mutation ("Field \"created_at\" is not defined by type
 * \"ClimbInput\""), which silently breaks queue sync to party peers. TypeScript
 * won't catch the excess fields on a plain assignment, so build the input
 * explicitly here and let the `ClimbInput` return type pin the shape. Use this at
 * every wire boundary (add / setCurrent / setQueue) so it can't be bypassed by an
 * item built from a raw climb (e.g. `addToQueue({ uuid, climb })`).
 */
export function toClimbInput(climb: Climb): ClimbInput {
  return {
    uuid: climb.uuid,
    // Board the climb belongs to. Round-tripped through the queue so a connected
    // board can skip a climb set for a different board/layout (a "spill" climb
    // from a party peer on another board, or a queue left over from a board
    // switch) instead of dark-firing the wall.
    boardType: climb.boardType,
    layoutId: climb.layoutId,
    setter_username: climb.setter_username,
    userId: climb.userId,
    name: climb.name,
    description: climb.description,
    frames: climb.frames,
    angle: climb.angle,
    ascensionist_count: climb.ascensionist_count,
    difficulty: climb.difficulty,
    quality_average: climb.quality_average,
    stars: climb.stars,
    difficulty_error: climb.difficulty_error,
    mirrored: climb.mirrored,
    benchmark_difficulty: climb.benchmark_difficulty,
    is_no_match: climb.is_no_match,
    characteristics: climb.characteristics,
    is_draft: climb.is_draft,
    published_at: climb.published_at,
    userAscents: climb.userAscents,
    userAttempts: climb.userAttempts,
    framesCount: climb.framesCount,
    framesPace: climb.framesPace,
    // Round-trip the Boardsesh grade so party peers render it without a refetch.
    boardseshDifficulty: climb.boardseshDifficulty,
    boardseshConfidence: climb.boardseshConfidence,
    // The sizes the climb fits on. A party peer standing at a different-sized
    // wall needs it: on Woods the 8x10's hold ids all exist on the 12x12 as
    // different holds, so without this the peer's board lights the wrong climb
    // instead of skipping it (canAddClimbToBoard rule 5).
    compatibleSizeIds: climb.compatibleSizeIds,
  };
}

/**
 * Map a local queue item to the GraphQL `ClimbQueueItemInput` — the ONE item->wire
 * seam for every mobile write path (add / setCurrent / setQueue / replace).
 *
 * The item level carries more than the climb: `addedBy` / `addedByUser` are who
 * queued it (the avatar peers render on the queue row), `tickedBy` is who has
 * sent it this session, and `suggested` marks a playlist suggestion. This client
 * used to send only `{ uuid, climb }`, so every climb queued from a phone landed
 * on peers anonymous — and worse, a phone's next full-queue write stripped the
 * attribution off the climbs the crew had queued from web (#3995). The field list
 * lives in the shared mapper so the two platforms cannot drift again.
 */
export function toQueueItemWireInput(item: ClimbQueueItem): ClimbQueueItemInput {
  return toClimbQueueItemInput(item, toClimbInput);
}

/**
 * Build a ClimbQueueItem from a Climb returned by SEARCH_CLIMBS / climb-detail
 * queries. The mutation input is GraphQL's `ClimbInput`, which is a strict
 * subset of `Climb` — passing the whole response (e.g. with `created_at`)
 * triggers a server-side validation error and surfaces as the generic
 * "Action failed" toast. Pick the exact fields here and let TypeScript verify
 * the shape, so callers can't drift.
 *
 * This must carry the SAME field set as `toClimbInput` above. Anything it drops
 * that `toClimbInput` sends is a field this client silently strips on its way
 * into the queue; anything it carries that a peer's selection set omits FLAPS,
 * because the peer rebuilds without it and its next full-queue write pushes the
 * gap back to everyone. `climb-to-queue-item.test.ts` asserts the two key sets
 * are equal, and `queue-climb-field-contract.test.ts` ties both to the schema.
 * See #3927.
 *
 * The same contract now applies one level up, at the queue item itself: what
 * `toQueueItemWireInput` sends, `SUBSCRIPTION_QUEUE_ITEM_FIELDS` must select and
 * `toClimbQueueItem` must rebuild. See #3995.
 */
export function climbToQueueItem(climb: Climb, options?: { suggested?: boolean; uuid?: string }): ClimbQueueItem {
  return {
    uuid: options?.uuid ?? randomUUID(),
    suggested: options?.suggested,
    climb: {
      uuid: climb.uuid,
      // Board metadata so the BLE auto-sender can detect a board/layout mismatch
      // before writing (see toClimbInput above).
      layoutId: climb.layoutId,
      boardType: climb.boardType,
      name: climb.name,
      frames: climb.frames,
      setter_username: climb.setter_username,
      // Owner identity, so the owner-only Edit action can be gated on a queued
      // climb (use-climb-actions / ClimbActionsSheet read exactly this, and the
      // play drawer feeds them the queue item's climb). Null for Aurora-synced
      // climbs that predate Boardsesh accounts.
      userId: climb.userId,
      // Carried so forking or editing a queued climb keeps its description.
      description: climb.description,
      // Mirror state, so re-deriving a queue item from an already-mirrored climb
      // keeps the flip. A search / detail response never sets this (no climbs
      // column backs it, and no resolver populates it) — it only ever arrives on
      // a climb that has already been through the queue, via a peer's
      // `mirrorCurrentClimb`. The paths that would otherwise lose it all rebuild
      // an item from such a climb: the climb-actions preview, the play-drawer
      // open, and the "on the wall" preview.
      mirrored: climb.mirrored,
      angle: climb.angle,
      ascensionist_count: climb.ascensionist_count,
      difficulty: climb.difficulty,
      quality_average: climb.quality_average,
      stars: climb.stars,
      difficulty_error: climb.difficulty_error,
      benchmark_difficulty: climb.benchmark_difficulty,
      is_no_match: climb.is_no_match,
      characteristics: climb.characteristics,
      // Draft / publish state — the other two inputs to the Edit gate
      // (`computeCanUpdate` reads exactly these).
      is_draft: climb.is_draft,
      published_at: climb.published_at,
      userAscents: climb.userAscents,
      userAttempts: climb.userAttempts,
      // Carry multi-frame playback metadata so a climb queued from search /
      // detail plays back at the setter's pace instead of DEFAULT_PACE_MS.
      framesCount: climb.framesCount,
      framesPace: climb.framesPace,
      // Carry the Boardsesh grade so the queue row / play drawer render it.
      boardseshDifficulty: climb.boardseshDifficulty,
      boardseshConfidence: climb.boardseshConfidence,
      // Size compatibility, so a queued climb keeps the one signal that tells
      // Woods' two boards apart (see toClimbInput above).
      compatibleSizeIds: climb.compatibleSizeIds,
    },
  };
}

/** The outcome of {@link resolveCommittableQueueItem}. */
export type CommittableQueueItem = {
  /** The item that is safe to dispatch. */
  item: ClimbQueueItem;
  /**
   * True when a transient peek was minted into a real item — the caller must
   * ADD it to the queue, because the thing it replaced was never in it.
   */
  converted: boolean;
};

/**
 * Make a queue item safe to commit.
 *
 * `findNextQueueItemWithSuggestions` hands back a synthetic
 * `playlist-peek:<climbUuid>` item for the next-up playlist suggestion. That
 * uuid is a local rendering device: it is not in the queue, and
 * `toQueueItemWireInput` sends `item.uuid` verbatim, so dispatching one puts a
 * uuid on the wire that no peer can reconcile against their queue. Every path
 * that turns a DISPLAYED item into a COMMITTED one has to launder it first.
 *
 * There are two such paths — the queue provider's `nextClimb()` and the play
 * drawer's "Put on the wall" — and until the drawer could pin a peek (which the
 * shared-session browse latch makes routine, since browsing walks the suggestion
 * track item by item) only the first one did. Extracted here so a third commit
 * path can't be written without it, and so the rule has one test instead of two
 * hand-agreeing copies.
 *
 * `suggested: true` is preserved on the minted item so suggestion pruning still
 * treats it as suggestion-origin. The peek carries the queue package's wide
 * `Climb`; `climbToQueueItem` reads only the `ClimbInput` subset, so the cast is
 * runtime-safe.
 */
export function resolveCommittableQueueItem(item: ClimbQueueItem): CommittableQueueItem {
  if (!isPlaylistPeekQueueItemUuid(item.uuid)) return { item, converted: false };
  return {
    item: climbToQueueItem(item.climb as unknown as Climb, { suggested: true }),
    converted: true,
  };
}
