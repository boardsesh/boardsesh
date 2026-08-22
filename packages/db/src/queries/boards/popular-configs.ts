import { sql, type SQL } from 'drizzle-orm';
import { rowsOf } from '../util/rows';

/**
 * One listed `(board_type, layout_id, size_id, set_ids)` configuration, with the
 * three counts everything downstream ranks on.
 *
 * The presentation half of the backend's `CachedPopularConfig` (`displayName`)
 * deliberately stays in the resolver: it is copy, not data, and the sitemap job
 * has no use for it.
 */
export type PopularBoardConfigRow = {
  boardType: string;
  layoutId: number;
  layoutName: string | null;
  sizeId: number;
  sizeName: string | null;
  sizeDescription: string | null;
  setIds: number[];
  setNames: string[];
  climbCount: number;
  totalAscents: number;
  boardCount: number;
};

/** Anything that can run a statement — a drizzle client, a transaction, a script db. */
type ConfigQueryRunner = { execute: (query: SQL) => Promise<unknown> };

/**
 * Every listed per-size board configuration with its climb count, ascent total
 * and physical-board count.
 *
 * A climb counts for a config only if it fits the size's edges AND all its holds
 * belong to placements in that config's sets (`board_climb_holds.hold_id` is a
 * PLACEMENT id, not a hole id). ~31 configs, ~750 ms worst case per LATERAL.
 *
 * **Two callers, deliberately one query.** The backend `popularBoardConfigs`
 * resolver (Redis-cached for a year, re-warmed on deploy) and the
 * `refresh-sitemap-tier2` job, which needs the winning `size_id`/`set_ids` per
 * layout to run the tier-2 predicate at all. The job cannot reach the resolver,
 * and a second copy of this SQL is how the materialised sitemap would come to
 * describe a different set of configurations than the site serves — the exact
 * divergence the #4583 ruling calls out. Extracting it here makes that drift
 * structurally impossible instead of merely detectable.
 *
 * Caching is the CALLER's business: the resolver keeps its Redis layer, the job
 * runs it once per night uncached.
 */
export async function fetchPopularBoardConfigRows(db: ConfigQueryRunner): Promise<PopularBoardConfigRow[]> {
  const result = await db.execute(sql`
    SELECT
      configs.board_type,
      configs.layout_id,
      bl.name AS layout_name,
      configs.size_id,
      bps.name AS size_name,
      bps.description AS size_description,
      configs.set_ids,
      configs.set_names,
      COALESCE(cc.climb_count, 0) AS climb_count,
      COALESCE(cc.total_ascents, 0) AS total_ascents,
      COALESCE(ub_counts.board_count, 0) AS board_count
    FROM (
      SELECT
        psls.board_type,
        psls.layout_id,
        psls.product_size_id AS size_id,
        array_agg(DISTINCT psls.set_id ORDER BY psls.set_id) AS set_ids,
        array_agg(DISTINCT bs.name ORDER BY bs.name) AS set_names
      FROM board_product_sizes_layouts_sets psls
      JOIN board_sets bs ON bs.board_type = psls.board_type AND bs.id = psls.set_id
      WHERE psls.is_listed = true
      GROUP BY psls.board_type, psls.layout_id, psls.product_size_id
    ) configs
    JOIN board_layouts bl ON bl.board_type = configs.board_type AND bl.id = configs.layout_id
    JOIN board_product_sizes bps ON bps.board_type = configs.board_type AND bps.id = configs.size_id
    LEFT JOIN (
      SELECT
        ub.board_type,
        ub.layout_id,
        ub.size_id,
        COUNT(*)::int AS board_count
      FROM user_boards ub
      WHERE ub.deleted_at IS NULL
      GROUP BY ub.board_type, ub.layout_id, ub.size_id
    ) ub_counts
      ON ub_counts.board_type = configs.board_type
      AND ub_counts.layout_id = configs.layout_id
      AND ub_counts.size_id = configs.size_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(DISTINCT bc.uuid)::int AS climb_count,
        COALESCE(SUM(bcs.ascensionist_count), 0)::int AS total_ascents
      FROM board_climbs bc
      LEFT JOIN board_climb_stats bcs
        ON bcs.board_type = bc.board_type AND bcs.climb_uuid = bc.uuid
      WHERE bc.board_type = configs.board_type
        AND bc.layout_id = configs.layout_id
        AND bc.is_listed = true
        AND bc.is_draft = false
        AND bc.edge_left > bps.edge_left
        AND bc.edge_right < bps.edge_right
        AND bc.edge_bottom > bps.edge_bottom
        AND bc.edge_top < bps.edge_top
        AND NOT EXISTS (
          SELECT 1 FROM board_climb_holds bch
          WHERE bch.climb_uuid = bc.uuid
            AND bch.board_type = bc.board_type
            AND NOT EXISTS (
              SELECT 1 FROM board_placements bp
              WHERE bp.board_type = bch.board_type
                AND bp.layout_id = bc.layout_id
                AND bp.id = bch.hold_id
                AND bp.set_id = ANY(configs.set_ids)
            )
        )
    ) cc ON true
    WHERE bl.is_listed = true
      AND bps.is_listed = true
    ORDER BY board_count DESC, total_ascents DESC, configs.board_type, bl.name
  `);

  return rowsOf<Record<string, unknown>>(result).map((row) => ({
    boardType: row.board_type as string,
    layoutId: Number(row.layout_id),
    layoutName: (row.layout_name as string) ?? null,
    sizeId: Number(row.size_id),
    sizeName: (row.size_name as string) ?? null,
    sizeDescription: (row.size_description as string) ?? null,
    setIds: (row.set_ids as number[]).map(Number),
    setNames: row.set_names as string[],
    climbCount: Number(row.climb_count),
    totalAscents: Number(row.total_ascents),
    boardCount: Number(row.board_count),
  }));
}
