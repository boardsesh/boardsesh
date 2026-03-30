import { sql } from 'drizzle-orm';
import { db } from '../../../db/client';
import { validateInput } from '../shared/helpers';
import { BoardNameSchema, ExternalUUIDSchema } from '../../../validation/schemas';

export interface ClimbStatsForAngle {
  angle: number;
  ascensionistCount: number;
  qualityAverage: number | null;
  difficultyAverage: number | null;
  displayDifficulty: number | null;
  faUsername: string | null;
  faAt: string | null;
  difficulty: string | null;
}

export interface ClimbStatsRow {
  angle: number;
  ascensionist_count: string;
  quality_average: string | null;
  difficulty_average: number | null;
  display_difficulty: number | null;
  fa_username: string | null;
  fa_at: string | null;
  difficulty: string | null;
}

export const climbStatsQuery = {
  climbStats: async (
    _: unknown,
    { boardName, climbUuid }: { boardName: string; climbUuid: string },
  ): Promise<ClimbStatsForAngle[]> => {
    validateInput(BoardNameSchema, boardName, 'boardName');
    validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');

    const result = await db.execute(sql`
      SELECT
        climb_stats.angle,
        COALESCE(climb_stats.ascensionist_count, 0) as ascensionist_count,
        ROUND(climb_stats.quality_average::numeric, 2) as quality_average,
        climb_stats.difficulty_average,
        climb_stats.display_difficulty,
        climb_stats.fa_username,
        climb_stats.fa_at,
        dg.boulder_name as difficulty
      FROM board_climb_stats climb_stats
      LEFT JOIN board_difficulty_grades dg
        ON dg.difficulty = ROUND(climb_stats.display_difficulty::numeric)
        AND dg.board_type = ${boardName}
      WHERE climb_stats.board_type = ${boardName}
      AND climb_stats.climb_uuid = ${climbUuid}
      ORDER BY climb_stats.angle ASC
    `);

    const rows = result as unknown as ClimbStatsRow[];

    return rows.map((r) => ({
      angle: Number(r.angle),
      ascensionistCount: Number(r.ascensionist_count || 0),
      qualityAverage: r.quality_average ? Number(r.quality_average) : null,
      difficultyAverage: r.difficulty_average ? Number(r.difficulty_average) : null,
      displayDifficulty: r.display_difficulty ? Number(r.display_difficulty) : null,
      faUsername: r.fa_username,
      faAt: r.fa_at ? String(r.fa_at) : null,
      difficulty: r.difficulty,
    }));
  },
};
