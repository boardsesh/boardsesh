import { sql, type SQL } from 'drizzle-orm';
import {
  boardSupportsMirroring,
  getBoardCapabilities,
  getRoutableBoardAngles,
  parseSetIds,
} from '@boardsesh/board-config';
import { holdIntegrityCondition, playlistBoardScopeConditions, publicClimbCondition } from '@boardsesh/db/queries';
import { boardClimbs } from '@boardsesh/db/schema';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import type { InventoryBoardRow } from './gym-inventory';

type RankingBoard = Pick<
  InventoryBoardRow,
  'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'angle' | 'isAngleAdjustable'
>;

export function validRankingOrientation(board: RankingBoard, angle: number, isMirror: boolean): boolean {
  return (
    isValidBoardName(board.boardType) &&
    getRoutableBoardAngles(board.boardType).includes(angle) &&
    (board.isAngleAdjustable || board.angle === angle) &&
    (!isMirror || boardSupportsMirroring(board.boardType, board.layoutId))
  );
}

/** Apply to one contributing logical configuration and an unaliased board_climbs join. */
export function ledRankingVariantCondition(board: RankingBoard, angle: SQL, mirror: SQL): SQL {
  if (!isValidBoardName(board.boardType) || board.boardType === 'spray') return sql`false`;
  const angles = getRoutableBoardAngles(board.boardType).filter(
    (angle) => board.isAngleAdjustable || angle === board.angle,
  );
  if (!angles.length) return sql`false`;
  const compatible = playlistBoardScopeConditions({
    boardName: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds: parseSetIds(board.setIds),
  });
  return sql`
    board_climbs.board_type = ${board.boardType}
    AND ${publicClimbCondition(boardClimbs)} AND NOT board_climbs.is_hidden
    AND NULLIF(btrim(board_climbs.frames), '') IS NOT NULL
    AND ${angle} = ANY(ARRAY[${sql.join(
      angles.map((allowedAngle) => sql`${allowedAngle}`),
      sql`, `,
    )}]::int[])
    AND ${mirror} IS NOT NULL
    ${boardSupportsMirroring(board.boardType, board.layoutId) ? sql`` : sql`AND ${mirror} IS FALSE`}
    ${sql.join(
      [...compatible, ...holdIntegrityCondition({ holdIntegrity: 'intact' })].map((condition) => sql`AND ${condition}`),
      sql` `,
    )}
    ${
      getBoardCapabilities(board.boardType).angleBoundClimbs
        ? sql`AND (board_climbs.angle IS NULL OR board_climbs.angle = ${angle} OR EXISTS (
          SELECT 1 FROM board_climb_stats by_angle
          WHERE by_angle.board_type = board_climbs.board_type AND by_angle.climb_uuid = board_climbs.uuid
            AND by_angle.angle = ${angle}
        ))`
        : sql``
    }
  `;
}
