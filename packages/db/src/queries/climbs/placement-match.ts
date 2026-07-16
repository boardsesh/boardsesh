import { sql, type SQL } from 'drizzle-orm';

type PlacementMatchSql = {
  boardType: SQL;
  climbHoldId: SQL;
  placementId: SQL;
  placementHoleId: SQL;
};

type MoonBoardPlacementCoverageSql = {
  boardType: SQL;
  climbUuid: SQL;
  layoutId: SQL;
};

/**
 * Match a climb hold to its physical placement.
 *
 * Aurora-family climbs store placement IDs in `board_climb_holds.hold_id`.
 * MoonBoard frames store layout-independent grid-cell IDs instead, so its
 * layout-specific placements bridge through `board_placements.hole_id`.
 */
export function climbHoldPlacementMatchSql({
  boardType,
  climbHoldId,
  placementId,
  placementHoleId,
}: PlacementMatchSql): SQL {
  return sql`(
    (${boardType} = 'moonboard' AND ${placementHoleId} = ${climbHoldId})
    OR (${boardType} <> 'moonboard' AND ${placementId} = ${climbHoldId})
  )`;
}

/**
 * Keep MoonBoard consumers from treating a partially mapped frame as a climb.
 * Other board families retain their existing placement-ID behavior.
 */
export function moonBoardPlacementCoverageSql({ boardType, climbUuid, layoutId }: MoonBoardPlacementCoverageSql): SQL {
  const missingPlacementMatch = climbHoldPlacementMatchSql({
    boardType: sql.raw('coverage_ch.board_type'),
    climbHoldId: sql.raw('coverage_ch.hold_id'),
    placementId: sql.raw('coverage_bp.id'),
    placementHoleId: sql.raw('coverage_bp.hole_id'),
  });

  return sql`(
    ${boardType} <> 'moonboard'
    OR NOT EXISTS (
      SELECT 1
      FROM board_climb_holds coverage_ch
      WHERE coverage_ch.board_type = ${boardType}
        AND coverage_ch.climb_uuid = ${climbUuid}
        AND NOT EXISTS (
          SELECT 1
          FROM board_placements coverage_bp
          WHERE coverage_bp.board_type = coverage_ch.board_type
            AND coverage_bp.layout_id = ${layoutId}
            AND ${missingPlacementMatch}
        )
    )
  )`;
}
