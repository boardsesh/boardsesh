import type { ClimbQueueItem } from '@boardsesh/queue';

/**
 * Subscription event types matching the QUEUE_UPDATES_SUBSCRIPTION shape.
 * Defined here (rather than in the provider) so pure tests can import them
 * without pulling in React Native.
 *
 * Keep these fields in sync with `SUBSCRIPTION_CLIMB_FIELDS` in
 * `src/lib/graphql/operations.ts` and with `climbToQueueItem` in
 * `src/lib/climb-to-queue-item.ts`. If the subscription drops a field, the queue
 * UI loses it on every server-driven update (FullSync on connect, peer
 * mutations), so the queue row's grade pill and the re-opened play drawer end up
 * blank — and a field this client WRITES but does not rebuild here FLAPS, since
 * its next full-queue write then pushes the gap back to every peer. See #3927.
 */
export type SubscriptionClimb = {
  uuid: string;
  // Board the climb belongs to — round-tripped so a peer on a different board can
  // skip a "spill" climb instead of dark-firing its wall. Nullish from older
  // peers / pre-metadata items (then the spill guard treats it as sendable).
  boardType?: string | null;
  layoutId?: number | null;
  // Owner identity, so the owner-only Edit action can be gated locally on a
  // queued climb without a per-climb refetch. Null for Aurora-synced climbs that
  // predate Boardsesh accounts.
  userId?: string | null;
  name: string;
  // Carried so forking or editing a queued climb keeps its description
  // (use-create-climb-navigation seeds the editor from it).
  description?: string | null;
  frames: string;
  controllerRouteUuid?: string | null;
  setter_username: string;
  angle: number;
  ascensionist_count: number;
  difficulty: string;
  quality_average: string;
  stars: number;
  difficulty_error: string;
  benchmark_difficulty: string | null;
  // mirrored survives a reconnect FullSync so a peer-set mirror flag isn't
  // dropped (the Bluetooth auto-sender repaints unmirrored otherwise).
  // framesCount/framesPace drive multi-frame playback at the setter's pace.
  mirrored?: boolean | null;
  is_no_match?: boolean | null;
  characteristics?: string[] | null;
  // Draft / publish state, so the 24h post-publish edit window can be evaluated
  // locally on a queued climb (computeCanUpdate reads exactly these two).
  is_draft?: boolean | null;
  published_at?: string | null;
  framesCount?: number | null;
  framesPace?: number | null;
  // Boardsesh grade carried on the subscription payload so a peer-broadcast climb
  // renders its grade without a per-climb refetch. Nullish from older peers.
  boardseshDifficulty?: number | null;
  boardseshConfidence?: string | null;
  // The sizes the climb fits on, so a peer standing at a different-sized wall
  // keeps the one signal that separates Woods' two boards (their hold ids
  // overlap as different holds). Nullish from older peers.
  compatibleSizeIds?: number[] | null;
};

export type SubscriptionQueueItemUser = {
  id: string;
  username: string;
  avatarUrl?: string | null;
};

/**
 * Keep these fields in sync with `SUBSCRIPTION_QUEUE_ITEM_FIELDS` in
 * `src/lib/graphql/operations.ts` and with `toQueueItemWireInput` in
 * `src/lib/climb-to-queue-item.ts`. The item level is in the drift contract too
 * (#3995): this client WRITES `addedBy` / `addedByUser` / `tickedBy` /
 * `suggested`, so a field it fails to rebuild here is a field its next
 * full-queue write strips off every peer's queue — the crew's "added by" avatars
 * blink out the moment a phone touches the queue.
 */
export type SubscriptionQueueItem = {
  uuid: string;
  climb: SubscriptionClimb;
  addedBy?: string | null;
  addedByUser?: SubscriptionQueueItemUser | null;
  tickedBy?: (string | null)[] | null;
  suggested?: boolean | null;
};

/**
 * Convert a subscription queue item to a ClimbQueueItem compatible with the
 * shared reducer. `userAscents` / `userAttempts` are user-specific and not
 * carried on subscription payloads — null is correct (mirrors what the
 * search query returns for unauthenticated lookups).
 */
export function toClimbQueueItem(subscriptionItem: SubscriptionQueueItem): ClimbQueueItem {
  return {
    uuid: subscriptionItem.uuid,
    // Who queued it, who has ticked it, whether it's a playlist suggestion. The
    // reducer's ClimbQueueItem types the last three as optional-not-nullable, so
    // a server null narrows to undefined rather than being carried as null.
    addedBy: subscriptionItem.addedBy,
    addedByUser: subscriptionItem.addedByUser ?? undefined,
    tickedBy: subscriptionItem.tickedBy ?? undefined,
    suggested: subscriptionItem.suggested ?? undefined,
    climb: {
      uuid: subscriptionItem.climb.uuid,
      boardType: subscriptionItem.climb.boardType ?? undefined,
      layoutId: subscriptionItem.climb.layoutId,
      userId: subscriptionItem.climb.userId,
      name: subscriptionItem.climb.name,
      description: subscriptionItem.climb.description,
      frames: subscriptionItem.climb.frames,
      controllerRouteUuid: subscriptionItem.climb.controllerRouteUuid,
      setter_username: subscriptionItem.climb.setter_username,
      angle: subscriptionItem.climb.angle,
      ascensionist_count: subscriptionItem.climb.ascensionist_count,
      difficulty: subscriptionItem.climb.difficulty,
      quality_average: subscriptionItem.climb.quality_average,
      stars: subscriptionItem.climb.stars,
      difficulty_error: subscriptionItem.climb.difficulty_error,
      benchmark_difficulty: subscriptionItem.climb.benchmark_difficulty,
      mirrored: subscriptionItem.climb.mirrored,
      is_no_match: subscriptionItem.climb.is_no_match,
      characteristics: subscriptionItem.climb.characteristics,
      is_draft: subscriptionItem.climb.is_draft,
      published_at: subscriptionItem.climb.published_at,
      framesCount: subscriptionItem.climb.framesCount,
      framesPace: subscriptionItem.climb.framesPace,
      boardseshDifficulty: subscriptionItem.climb.boardseshDifficulty,
      boardseshConfidence: subscriptionItem.climb.boardseshConfidence,
      compatibleSizeIds: subscriptionItem.climb.compatibleSizeIds,
    },
  };
}
