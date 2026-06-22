import type { ClimbQueueItem } from '@boardsesh/queue';

/**
 * Subscription event types matching the QUEUE_UPDATES_SUBSCRIPTION shape.
 * Defined here (rather than in the provider) so pure tests can import them
 * without pulling in React Native.
 *
 * Keep these fields in sync with `SUBSCRIPTION_CLIMB_FIELDS` in
 * `src/lib/graphql/operations.ts` and with `climbToQueueItem` in
 * `src/components/play-drawer/PlayDrawer.tsx`. If the subscription drops a
 * field, the queue UI loses it on every server-driven update (FullSync on
 * connect, peer mutations), so the queue row's grade pill and the
 * re-opened play drawer end up blank.
 */
export type SubscriptionClimb = {
  uuid: string;
  // Board the climb belongs to — round-tripped so a peer on a different board can
  // skip a "spill" climb instead of dark-firing its wall. Nullish from older
  // peers / pre-metadata items (then the spill guard treats it as sendable).
  boardType?: string | null;
  layoutId?: number | null;
  name: string;
  frames: string;
  setter_username: string;
  angle: number;
  ascensionist_count: number;
  // Per-source ascensionist counts (all nullable) so a peer-synced queue row can
  // honour the local "Ascent counts" setting. Nullish from older peers.
  kilterAscensionistCount?: number | null;
  auroraAscensionistCount?: number | null;
  boardseshAscensionistCount?: number | null;
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
  framesCount?: number | null;
  framesPace?: number | null;
};

export type SubscriptionQueueItem = {
  uuid: string;
  climb: SubscriptionClimb;
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
    climb: {
      uuid: subscriptionItem.climb.uuid,
      boardType: subscriptionItem.climb.boardType ?? undefined,
      layoutId: subscriptionItem.climb.layoutId,
      name: subscriptionItem.climb.name,
      frames: subscriptionItem.climb.frames,
      setter_username: subscriptionItem.climb.setter_username,
      angle: subscriptionItem.climb.angle,
      ascensionist_count: subscriptionItem.climb.ascensionist_count,
      kilterAscensionistCount: subscriptionItem.climb.kilterAscensionistCount,
      auroraAscensionistCount: subscriptionItem.climb.auroraAscensionistCount,
      boardseshAscensionistCount: subscriptionItem.climb.boardseshAscensionistCount,
      difficulty: subscriptionItem.climb.difficulty,
      quality_average: subscriptionItem.climb.quality_average,
      stars: subscriptionItem.climb.stars,
      difficulty_error: subscriptionItem.climb.difficulty_error,
      benchmark_difficulty: subscriptionItem.climb.benchmark_difficulty,
      mirrored: subscriptionItem.climb.mirrored,
      is_no_match: subscriptionItem.climb.is_no_match,
      characteristics: subscriptionItem.climb.characteristics,
      framesCount: subscriptionItem.climb.framesCount,
      framesPace: subscriptionItem.climb.framesPace,
    },
  };
}
