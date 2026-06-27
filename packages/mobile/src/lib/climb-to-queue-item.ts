import { randomUUID } from 'expo-crypto';
import type { Climb, ClimbInput } from '@boardsesh/shared-schema';
import type { ClimbQueueItem } from '@boardsesh/queue';

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
  };
}

/**
 * Build a ClimbQueueItem from a Climb returned by SEARCH_CLIMBS / climb-detail
 * queries. The mutation input is GraphQL's `ClimbInput`, which is a strict
 * subset of `Climb` — passing the whole response (e.g. with `created_at`)
 * triggers a server-side validation error and surfaces as the generic
 * "Action failed" toast. Pick the exact fields here and let TypeScript verify
 * the shape, so callers can't drift.
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
      angle: climb.angle,
      ascensionist_count: climb.ascensionist_count,
      // Per-source counts so the queued row honours the "Ascent counts" setting.
      kilterAscensionistCount: climb.kilterAscensionistCount,
      auroraAscensionistCount: climb.auroraAscensionistCount,
      boardseshAscensionistCount: climb.boardseshAscensionistCount,
      difficulty: climb.difficulty,
      quality_average: climb.quality_average,
      stars: climb.stars,
      difficulty_error: climb.difficulty_error,
      benchmark_difficulty: climb.benchmark_difficulty,
      is_no_match: climb.is_no_match,
      characteristics: climb.characteristics,
      userAscents: climb.userAscents,
      userAttempts: climb.userAttempts,
      // Carry multi-frame playback metadata so a climb queued from search /
      // detail plays back at the setter's pace instead of DEFAULT_PACE_MS.
      framesCount: climb.framesCount,
      framesPace: climb.framesPace,
    },
  };
}
