/**
 * Fetches in server components are cached by default by next.
 * But direct query calls are not, therefore always use the rest api
 * when fetching data in server components, as it will leverage the next cache and be more
 * performant.
 */
import 'server-only';
import { cache } from 'react';
import { unstable_cache } from 'next/cache';
// oxlint-disable-next-line no-restricted-imports -- raw postgres-js sql usage; migrate to drizzle
import { rowsFromResult, sql } from '@/app/lib/db/db';
import { getGradeLabel } from '@boardsesh/db/queries';

import type { Climb, ParsedBoardRouteParametersWithUuid, BoardName, LayoutId, Size } from '../types';
import { getSizesForLayoutId, getAllLayouts, getSetsForLayoutAndSize } from '@/app/lib/board-constants';
import { isNoMatchClimb, isNoMatch } from '@/app/lib/no-match-climb';
import { withReadDeadline } from '@/app/lib/db/read-deadline';
import { remainingReadBudgetMs } from '@/app/lib/db/request-read-budget';

/**
 * Thrown by the cached executor for a genuinely missing row, and translated back
 * to `null` outside the cache. `unstable_cache` never stores a rejection, so a
 * climb the crawler reached before the import finished re-reads on the next
 * request instead of answering 404 for the rest of the hour-long entry.
 */
class ClimbRowMissingError extends Error {
  constructor(climbUuid: string) {
    super(`[db] no climb row for ${climbUuid}`);
    this.name = 'ClimbRowMissingError';
  }
}

// Resolves an old/bookmarked/shared climb link through board_climb_aliases:
// a climb that's since been merged into another (e.g. the MoonBoard
// angle-dedup migration 0193_moonboard_angle_dedup_backfill) must still
// resolve to where its stats/ticks/favorites actually live now, not render an
// empty husk. A miss returns the input uuid unchanged, mirroring
// resolveCanonicalClimbUuid in
// packages/db/src/queries/aliases.ts (not reused directly — that helper
// takes a drizzle db handle and this file's queries are raw postgres-js sql).
async function resolveCanonicalClimbUuidWeb(boardName: BoardName, climbUuid: string): Promise<string> {
  const result = rowsFromResult<{ canonical_uuid: string }>(
    await withReadDeadline(
      'climb-alias',
      sql`
      SELECT canonical_uuid FROM board_climb_aliases
      WHERE board_type = ${boardName} AND alias_uuid = ${climbUuid}
      LIMIT 1
    `,
      remainingReadBudgetMs(),
    ),
  );
  return result[0]?.canonical_uuid ?? climbUuid;
}

/**
 * Throws `ClimbRowMissingError` when no row matches — a genuinely missing climb,
 * which the caller turns back into `null`. Anything else (a saturated pool, a
 * read deadline, a dead database) throws its own error, so the page can tell
 * "this climb does not exist" from "we could not answer right now". The two used
 * to be indistinguishable, and both rendered a 404 on an indexed URL.
 */
async function fetchClimbFromDb(
  boardName: BoardName,
  layoutId: LayoutId,
  angle: number,
  requestedClimbUuid: string,
): Promise<Climb> {
  const climbUuid = await resolveCanonicalClimbUuidWeb(boardName, requestedClimbUuid);

  // Direct-by-UUID lookups intentionally do NOT filter `frames_count = 1`.
  // Search/dedupe still skip multi-frame climbs (see queries/climbs/*),
  // but the player needs to be able to render them when a URL points at one.
  const result = rowsFromResult<Climb & { difficulty_id: number | null }>(
    await withReadDeadline(
      'climb-select',
      sql`
        SELECT climbs.uuid, climbs.setter_username, climbs.user_id as "userId", climbs.name, climbs.description,
        climbs.layout_id as "layoutId", climbs.board_type as "boardType",
        climbs.frames, climbs.frames_count as "framesCount", climbs.frames_pace as "framesPace",
        COALESCE(climb_stats.angle, ${angle}) as angle, climbs.angle as "catalogAngle",
        COALESCE(climb_stats.ascensionist_count, 0) as ascensionist_count,
        ROUND(climb_stats.display_difficulty::numeric, 0) as difficulty_id,
        ROUND(climb_stats.quality_average::numeric, 2) as quality_average,
        ROUND(climb_stats.difficulty_average::numeric - climb_stats.display_difficulty::numeric, 2) AS difficulty_error,
        CASE WHEN climb_stats.benchmark_difficulty > 0 THEN climb_stats.benchmark_difficulty::text ELSE NULL END as benchmark_difficulty,
        climbs.is_draft, climbs.created_at, climbs.published_at, climbs.characteristics,
        climbs.compatible_size_ids as "compatibleSizeIds"
        FROM board_climbs climbs
        LEFT JOIN board_climb_stats climb_stats
          ON climb_stats.climb_uuid = climbs.uuid
          AND climb_stats.angle = ${angle}
          AND climb_stats.board_type = ${boardName}
        WHERE climbs.board_type = ${boardName}
        AND climbs.layout_id = ${layoutId}
        AND climbs.uuid = ${climbUuid}
        limit 1
      `,
      remainingReadBudgetMs(),
    ),
  );
  const row = result[0];
  if (!row) throw new ClimbRowMissingError(climbUuid);
  return {
    ...row,
    difficulty: getGradeLabel(row.difficulty_id),
    is_no_match: row.characteristics != null ? isNoMatch(row.characteristics) : isNoMatchClimb(row.description),
  } as Climb;
}

/**
 * `unstable_cache` is constructed per call because its `tags` carry the climb
 * uuid — a module-level instance could only hold one static tag set, and a
 * uuid-keyed registry of instances would grow without bound on a crawl. What
 * *is* hoisted is the executor: `unstable_cache` keys on the callback's source
 * text, so passing a stable module-level function with explicit primitive
 * arguments (the pattern `search-climbs.ts` documents) keeps the key derivation
 * deterministic instead of resting on a fresh closure per request.
 *
 * The miss is translated from a rejection to `null` out here, on purpose: a
 * `null` returned from inside would be stored for the full hour, so a climb
 * crawled minutes before its import landed would keep 404-ing until the entry
 * expired. `unstable_cache` does not store rejections.
 */
async function cachedClimbFetch(
  boardName: BoardName,
  layoutId: LayoutId,
  angle: number,
  climbUuid: string,
): Promise<Climb | null> {
  try {
    return await unstable_cache(fetchClimbFromDb, ['climb', boardName, String(layoutId), climbUuid, String(angle)], {
      revalidate: 3600,
      tags: [`climb-${climbUuid}`],
    })(boardName, layoutId, angle, climbUuid);
  } catch (error) {
    if (error instanceof ClimbRowMissingError) return null;
    throw error;
  }
}

/**
 * React-`cache`d on primitives, so `generateMetadata` and the page body share
 * one read per request. `unstable_cache` has no in-flight single-flight and
 * Next renders the two concurrently, so on a cold key both used to miss and
 * both used to run the alias lookup and the climb select — four statements
 * where two would do.
 * Keying on primitives (rather than the params object) makes the dedupe work in
 * the `/b/{slug}` tree too, where the two entry points build their own objects.
 *
 * Resolves to `null` when the climb genuinely does not exist; rejects when the
 * read failed.
 */
const getClimbCached = cache(
  async (boardName: BoardName, layoutId: LayoutId, angle: number, climbUuid: string): Promise<Climb | null> =>
    cachedClimbFetch(boardName, layoutId, angle, climbUuid),
);

export async function getClimb(params: ParsedBoardRouteParametersWithUuid): Promise<Climb | null> {
  return getClimbCached(params.board_name, params.layout_id, params.angle, params.climb_uuid);
}

export type ClimbStatsForAngle = {
  angle: number;
  ascensionist_count: string; // comes as string from DB
  quality_average: string | null; // comes as string from DB
  difficulty_average: number | null;
  display_difficulty: number | null;
  fa_username: string | null;
  fa_at: string | null;
  difficulty: string | null;
  /**
   * True once `quality_average` is on the canonical 1-5 scale. Aurora reports
   * quality on 1-3, and the 1-3→1-5 backfill (migrations 0115/0116) records
   * itself here. Publishing an unnormalized average as a schema.org rating with
   * `bestRating: 5` would understate every row it touched.
   */
  quality_normalized: boolean;
  /**
   * The quality blend's OWN denominator — how many ratings are behind
   * `quality_average`.
   *
   * Not `ascensionist_count`, which is the blended ascent total
   * (`upstream + boardsesh`). Precisely: the upstream side counts only when
   * upstream actually supplied a quality, plus Boardsesh's one-vote-per-climber
   * count. On an upstream-sourced climb with no native ratings that lands close
   * to `upstream_ascensionist_count`, and legitimately so — Aurora's quality
   * average IS an average over the ascents that rated it, so those ascents are
   * its rating population. What it never does is claim Boardsesh ascents, or
   * upstream ascents on a climb upstream never rated, as ratings.
   */
  rating_count: string; // comes as string from DB
};

async function fetchClimbStatsForAllAnglesFromDb(
  boardName: BoardName,
  climbUuid: string,
): Promise<ClimbStatsForAngle[]> {
  const result = rowsFromResult<ClimbStatsForAngle & { difficulty_id: number | null }>(
    await withReadDeadline(
      'climb-stats-all-angles',
      sql`
    SELECT
      climb_stats.angle,
      COALESCE(climb_stats.ascensionist_count, 0) as ascensionist_count,
      ROUND(climb_stats.quality_average::numeric, 2) as quality_average,
      climb_stats.difficulty_average,
      climb_stats.display_difficulty,
      climb_stats.fa_username,
      climb_stats.fa_at,
      climb_stats.quality_normalized,
      -- The blend's own denominator, verbatim from the definition on
      -- board_climb_stats.quality_average: the upstream side counts only when it
      -- actually supplied a quality, plus Boardsesh's one-vote-per-climber count.
      COALESCE(CASE WHEN climb_stats.upstream_quality_average IS NOT NULL
                    THEN climb_stats.upstream_ascensionist_count END, 0)
        + COALESCE(climb_stats.boardsesh_quality_count, 0) as rating_count,
      ROUND(climb_stats.display_difficulty::numeric, 0) as difficulty_id
    FROM board_climb_stats climb_stats
    WHERE climb_stats.board_type = ${boardName}
    AND climb_stats.climb_uuid = ${climbUuid}
    ORDER BY climb_stats.angle ASC
  `,
      remainingReadBudgetMs(),
    ),
  );
  return result.map((row) => ({
    ...row,
    difficulty: getGradeLabel(row.difficulty_id),
  })) as ClimbStatsForAngle[];
}

/**
 * Per-angle grade/ascents/FA for one climb — the angle cross-links on the climb
 * front door.
 *
 * Cached under the same `climb-${uuid}` tag as `getClimb`, so one
 * `revalidateTag` clears both: a page that renders the climb's own facts from a
 * fresh row and its angle table from an hour-old one is worse than either.
 */
const getClimbStatsForAllAnglesCached = cache(
  async (boardName: BoardName, climbUuid: string): Promise<ClimbStatsForAngle[]> =>
    unstable_cache(fetchClimbStatsForAllAnglesFromDb, ['climb-stats-all-angles', boardName, climbUuid], {
      revalidate: 3600,
      tags: [`climb-${climbUuid}`],
    })(boardName, climbUuid),
);

export async function getClimbStatsForAllAngles(
  params: ParsedBoardRouteParametersWithUuid,
): Promise<ClimbStatsForAngle[]> {
  return getClimbStatsForAllAnglesCached(params.board_name, params.climb_uuid);
}

export type LayoutRow = {
  id: number;
  name: string;
};

export const getLayouts = (board_name: BoardName): LayoutRow[] => {
  // Use hardcoded data instead of database query
  const layouts = getAllLayouts(board_name);
  return layouts.map((layout) => ({
    id: layout.id,
    name: layout.name,
  }));
};

export type SizeRow = {
  id: number;
  name: string;
  description: string;
};

export const getSizes = (board_name: BoardName, layout_id: LayoutId): SizeRow[] => {
  // Use hardcoded data instead of database query
  const sizes = getSizesForLayoutId(board_name, layout_id);
  return sizes.map((size) => ({
    id: size.id,
    name: size.name,
    description: size.description,
  }));
};

export type SetRow = {
  id: number;
  name: string;
};

export const getSets = (board_name: BoardName, layout_id: LayoutId, size_id: Size): SetRow[] => {
  // Use hardcoded data instead of database query
  return getSetsForLayoutAndSize(board_name, layout_id, size_id);
};
