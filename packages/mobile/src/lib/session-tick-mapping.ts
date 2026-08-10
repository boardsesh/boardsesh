import { type useRouter } from 'expo-router';
import type { SessionDetailTick } from '@boardsesh/shared-schema';
import type { ClimbListItemClimb } from '../components/ClimbListItemContent';
import { renderBoardToPlaylistConfig } from './playlists/board-details-for-playlist';

type Router = ReturnType<typeof useRouter>;

/**
 * Adapt a session tick into the permissive `ClimbListItemClimb` shape the shared
 * climb-list visual (thumbnail + name + colorized grade) consumes. Mirrors
 * LogbookRow's `ascentToClimb`. Returns null without frames — the host then
 * falls back to the plain text row (e.g. MoonBoard, which has no bundled art).
 *
 * The logger's personal `quality` is deliberately NOT surfaced as the community
 * star average, so `quality_average` stays '0' (the row hides the star when 0).
 *
 * Boardsesh-grade fallback: a climber's OWN logged ascent grade always wins over
 * the Boardsesh grade (the hard rule). `tick.difficulty` is that effective grade
 * (their own, or the community consensus the resolver folds in) — null only for a
 * truly ungraded/attempt tick, the exact signal the frameless path uses
 * (SessionTickRow ~L187). So we carry the Boardsesh grade fields onto the climb
 * ONLY when `tick.difficulty == null`: then `ClimbListItemContent.resolveGrade`
 * fills the blank with the Boardsesh grade (when the toggle is on and it's
 * trusted), instead of showing nothing. When a grade IS present we OMIT the
 * fields, so `ClimbListItemContent` renders `difficulty` (the climber's / crowd's
 * grade) unchanged — honouring the invariant documented on `ClimbListItemClimb`
 * that the Boardsesh fields are set only alongside a community/consensus grade,
 * never a user's own logged one.
 */
export function sessionTickToClimb(tick: SessionDetailTick): ClimbListItemClimb | null {
  if (!tick.frames) return null;
  const isUngraded = tick.difficulty == null;
  return {
    uuid: tick.climbUuid,
    name: tick.climbName ?? '',
    frames: tick.frames,
    difficulty: tick.difficultyName ?? '',
    ascensionist_count: 0,
    quality_average: '0',
    setter_username: tick.setterUsername ?? '',
    benchmark_difficulty: tick.isBenchmark ? (tick.difficultyName ?? null) : null,
    mirrored: tick.isMirror,
    is_no_match: tick.isNoMatch,
    ...(isUngraded
      ? { boardseshDifficulty: tick.boardseshDifficulty, boardseshConfidence: tick.boardseshConfidence }
      : {}),
  };
}

/**
 * Navigate to the climb-detail route for a session tick. `SessionDetailTick`
 * only carries `boardType` + `layoutId`, so we resolve the renderable size/sets
 * from the tick's resolved `renderBoard`, else the layout default. Returns
 * early — without navigating — for boards the bundled config can't resolve
 * (e.g. MoonBoard), matching the playlist behaviour of falling back cleanly.
 */
export function navigateToSessionClimb(router: Router, tick: SessionDetailTick): void {
  const config = renderBoardToPlaylistConfig(tick.boardType, tick.layoutId, tick.renderBoard);
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
