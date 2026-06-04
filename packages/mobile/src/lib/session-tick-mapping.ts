import { type useRouter } from 'expo-router';
import type { LogbookEntry } from '@boardsesh/profile-stats';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import { getBoardConfigForPlaylist } from './playlists/board-details-for-playlist';

type Router = ReturnType<typeof useRouter>;

/**
 * Normalise a session's per-climb ticks into the `LogbookEntry` shape the shared
 * `deriveProfileViewModel` aggregation consumes, bucketed by board type (the
 * derive step keys every chart off `Record<boardType, LogbookEntry[]>`).
 *
 * `SessionDetailTick.status` is a free-form string off the GraphQL record, so we
 * narrow it to the three statuses the stats layer understands; anything else
 * (shouldn't happen in practice) falls through as an attempt.
 */
export function sessionTicksToLogbook(ticks: SessionDetailTick[]): Record<string, LogbookEntry[]> {
  const byBoard: Record<string, LogbookEntry[]> = {};
  for (const tick of ticks) {
    const boardType = tick.boardType;
    const entry: LogbookEntry = {
      climbed_at: tick.climbedAt,
      difficulty: tick.difficulty ?? null,
      // Session ticks carry no consensus override, so the user difficulty doubles
      // as the effective grade for bucketing.
      effectiveDifficulty: tick.difficulty ?? null,
      tries: Math.max(1, tick.attemptCount),
      angle: tick.angle,
      status: normaliseStatus(tick.status),
      layoutId: tick.layoutId ?? null,
      boardType,
      climbUuid: tick.climbUuid,
    };
    (byBoard[boardType] ??= []).push(entry);
  }
  return byBoard;
}

function normaliseStatus(status: string): LogbookEntry['status'] {
  if (status === 'flash') return 'flash';
  if (status === 'send') return 'send';
  return 'attempt';
}

/**
 * Navigate to the climb-detail route for a session tick. `SessionDetailTick`
 * only carries `boardType` + `layoutId`, so we resolve the renderable size/sets
 * via `getBoardConfigForPlaylist` (same path the playlist tiles use). Returns
 * early — without navigating — for boards the bundled config can't resolve
 * (e.g. MoonBoard), matching the playlist behaviour of falling back cleanly.
 */
export function navigateToSessionClimb(router: Router, tick: SessionDetailTick): void {
  const config = getBoardConfigForPlaylist(tick.boardType, tick.layoutId);
  if (!config) return;
  router.push({
    pathname: '/(tabs)/climbs/[climbUuid]',
    params: {
      climbUuid: tick.climbUuid,
      boardName: config.boardName,
      layoutId: String(config.layoutId),
      sizeId: String(config.sizeId),
      setIds: config.setIds.join(','),
      angle: String(tick.angle),
    },
  });
}
