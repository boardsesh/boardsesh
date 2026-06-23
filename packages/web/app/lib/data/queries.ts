/**
 * Fetches in server components are cached by default by next.
 * But direct query calls are not, therefore always use the rest api
 * when fetching data in server components, as it will leverage the next cache and be more
 * performant.
 */
import 'server-only';
import { unstable_cache } from 'next/cache';
// oxlint-disable-next-line no-restricted-imports -- raw postgres-js sql usage; migrate to drizzle
import { rowsFromResult, sql } from '@/app/lib/db/db';
import { getGradeLabel } from '@boardsesh/db/queries';

import type { Climb, ParsedBoardRouteParametersWithUuid, BoardName, LayoutId, Size } from '../types';
import { getSizesForLayoutId, getAllLayouts, getSetsForLayoutAndSize } from '@/app/lib/board-constants';
import { isNoMatchClimb, isNoMatch } from '@/app/lib/no-match-climb';

async function fetchClimbFromDb(params: ParsedBoardRouteParametersWithUuid): Promise<Climb> {
  // Direct-by-UUID lookups intentionally do NOT filter `frames_count = 1`.
  // Search/dedupe still skip multi-frame climbs (see queries/climbs/*),
  // but the player needs to be able to render them when a URL points at one.
  const result = rowsFromResult<Climb & { difficulty_id: number | null }>(
    await sql`
        SELECT climbs.uuid, climbs.setter_username, climbs.user_id as "userId", climbs.name, climbs.description,
        climbs.frames, climbs.frames_count as "framesCount", climbs.frames_pace as "framesPace",
        COALESCE(climb_stats.angle, ${params.angle}) as angle, COALESCE(climb_stats.ascensionist_count, 0) as ascensionist_count,
        ROUND(climb_stats.display_difficulty::numeric, 0) as difficulty_id,
        ROUND(climb_stats.quality_average::numeric, 2) as quality_average,
        ROUND(climb_stats.difficulty_average::numeric - climb_stats.display_difficulty::numeric, 2) AS difficulty_error,
        CASE WHEN climb_stats.benchmark_difficulty > 0 THEN climb_stats.benchmark_difficulty::text ELSE NULL END as benchmark_difficulty,
        climbs.is_draft, climbs.created_at, climbs.published_at, climbs.characteristics
        FROM board_climbs climbs
        LEFT JOIN board_climb_stats climb_stats
          ON climb_stats.climb_uuid = climbs.uuid
          AND climb_stats.angle = ${params.angle}
          AND climb_stats.board_type = ${params.board_name}
        WHERE climbs.board_type = ${params.board_name}
        AND climbs.layout_id = ${params.layout_id}
        AND climbs.uuid = ${params.climb_uuid}
        limit 1
      `,
  );
  const row = result[0];
  return {
    ...row,
    difficulty: getGradeLabel(row.difficulty_id),
    is_no_match: row.characteristics != null ? isNoMatch(row.characteristics) : isNoMatchClimb(row.description),
  } as Climb;
}

export async function getClimb(params: ParsedBoardRouteParametersWithUuid): Promise<Climb> {
  const cachedFn = unstable_cache(
    async () => fetchClimbFromDb(params),
    ['climb', params.board_name, String(params.layout_id), params.climb_uuid, String(params.angle)],
    {
      revalidate: 3600,
      tags: [`climb-${params.climb_uuid}`],
    },
  );
  return cachedFn();
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
};

export const getClimbStatsForAllAngles = async (
  params: ParsedBoardRouteParametersWithUuid,
): Promise<ClimbStatsForAngle[]> => {
  const result = rowsFromResult<ClimbStatsForAngle & { difficulty_id: number | null }>(
    await sql`
    SELECT
      climb_stats.angle,
      COALESCE(climb_stats.ascensionist_count, 0) as ascensionist_count,
      ROUND(climb_stats.quality_average::numeric, 2) as quality_average,
      climb_stats.difficulty_average,
      climb_stats.display_difficulty,
      climb_stats.fa_username,
      climb_stats.fa_at,
      ROUND(climb_stats.display_difficulty::numeric, 0) as difficulty_id
    FROM board_climb_stats climb_stats
    WHERE climb_stats.board_type = ${params.board_name}
    AND climb_stats.climb_uuid = ${params.climb_uuid}
    ORDER BY climb_stats.angle ASC
  `,
  );
  return result.map((row) => ({
    ...row,
    difficulty: getGradeLabel(row.difficulty_id),
  })) as ClimbStatsForAngle[];
};

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
