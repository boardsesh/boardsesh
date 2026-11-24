import { and, eq, sql, type SQL } from 'drizzle-orm';
import { GraphQLError } from 'graphql';
import { rowsFromResult } from '@boardsesh/db/client';
import {
  gradeValueSql,
  holdIntegrityCondition,
  playlistBoardScopeConditions,
  playlistVisibilityCondition,
  publicClimbCondition,
  retiredByResetCondition,
} from '@boardsesh/db/queries';
import { boardClimbs, playlists } from '@boardsesh/db/schema';
import type { BoardName, GymGradeInventoryBoard } from '@boardsesh/shared-schema';
import { getRoutableBoardAngles, parseSetIds } from '@boardsesh/board-config';
import { isValidBoardName } from '../../../db/queries/util/table-select';
import {
  authorizedReportingBoardCondition,
  type GymReportingScope,
  type GymReportingTransaction,
} from './gym-reporting';

export const GYM_INVENTORY_MAX_BOARDS = 32;
export const GYM_INVENTORY_MAX_REFS = 4_096;
const MAX_OFFERING_ROWS = 8_192;

export type SprayInventoryBinding = {
  boardId: number;
  boardUuid: string;
  gymId: number;
  wallId: number;
  versionId: number;
  layoutId: number;
  angle: number;
};

export type GradeCollectionHeader = {
  id: string;
  uuid: string;
  name: string;
  boardType: string;
  layoutId: number | null;
};

type InventoryBoardRow = {
  id: number;
  uuid: string;
  boardType: string;
  layoutId: number;
  sizeId: number;
  setIds: string;
  angle: number;
  isAngleAdjustable: boolean;
  wallId: number | null;
  versionId: number | null;
  onlyMe: boolean;
  selected: boolean;
  collection: GradeCollectionHeader | null;
};

type InventoryBoard = InventoryBoardRow & {
  name: string;
  physicalBoardUuid: string;
  readySprayBinding: SprayInventoryBinding | null;
  compatibleCollection: GradeCollectionHeader | null;
};

export const inventoryScopeTooLarge = () =>
  new GraphQLError('Inventory scope is too large', { extensions: { code: 'SCOPE_TOO_LARGE' } });

export function validCollectionHeader(
  collection: GradeCollectionHeader,
  board: Pick<InventoryBoardRow, 'boardType' | 'layoutId'>,
): boolean {
  return (
    collection.boardType === board.boardType && (collection.layoutId === null || collection.layoutId === board.layoutId)
  );
}

export function rawSprayLayoutCondition(layoutId: number): SQL {
  return and(eq(boardClimbs.boardType, 'spray'), eq(boardClimbs.layoutId, layoutId))!;
}

/** Keep the raw indexed probe ahead of eligibility work even inside observer SQL. */
export function boundedSprayLayoutSql(layoutId: number): SQL {
  return sql`
    SELECT uuid, board_type, layout_id, is_draft, is_listed, is_hidden, frames, missing_hold_count, retired_by_reset
    FROM board_climbs WHERE ${rawSprayLayoutCondition(layoutId)} LIMIT ${GYM_INVENTORY_MAX_REFS + 1}
  `;
}

export function sprayInventoryClimbCondition(layoutId: number): SQL {
  return and(
    rawSprayLayoutCondition(layoutId),
    publicClimbCondition(boardClimbs),
    eq(boardClimbs.isHidden, false),
    sql`NULLIF(${boardClimbs.frames}, '') IS NOT NULL`,
    ...holdIntegrityCondition({ holdIntegrity: 'intact' }),
    ...retiredByResetCondition('spray', {}),
  )!;
}

/** The picker uses the same version ownership/status check, but allows some owner exemptions. */
function currentSprayWallJoin(): SQL {
  return sql`
    LEFT JOIN spray_walls spray_wall ON spray_wall.board_uuid = user_boards.uuid
      AND spray_wall.layout_id = user_boards.layout_id AND spray_wall.deleted_at IS NULL
      AND spray_wall.archived_at IS NULL AND spray_wall.hidden_at IS NULL
    LEFT JOIN spray_wall_versions spray_version ON spray_version.id = spray_wall.current_version_id
      AND spray_version.wall_id = spray_wall.id AND spray_version.status = 'published'
  `;
}

function sprayOnlyMeCondition(): SQL {
  return sql`EXISTS (SELECT 1 FROM resource_privacy inventory_policy
    WHERE inventory_policy.kind = 'board' AND inventory_policy.resource_id = user_boards.uuid
      AND inventory_policy.audience = 'only_me')`;
}

export async function readInventoryBoards(
  tx: GymReportingTransaction,
  scope: GymReportingScope,
): Promise<InventoryBoard[]> {
  if (scope.boardIds.length === 0) return [];
  const rows = rowsFromResult<InventoryBoardRow>(
    await tx.execute(sql`
    SELECT user_boards.id::double precision AS id, user_boards.uuid, user_boards.board_type AS "boardType",
      user_boards.layout_id::int AS "layoutId", user_boards.size_id::int AS "sizeId",
      user_boards.set_ids AS "setIds", user_boards.angle::int AS angle,
      user_boards.is_angle_adjustable AS "isAngleAdjustable",
      spray_wall.id::double precision AS "wallId", spray_version.id::double precision AS "versionId",
      ${sprayOnlyMeCondition()} AS "onlyMe", selected.board_id IS NOT NULL AS selected,
      CASE WHEN playlists.id IS NULL THEN NULL ELSE json_build_object(
        'id', playlists.id::text, 'uuid', playlists.uuid, 'name', playlists.name,
        'boardType', playlists.board_type, 'layoutId', playlists.layout_id
      ) END AS collection
    FROM user_boards
    ${currentSprayWallJoin()}
    LEFT JOIN gym_board_grade_collections selected ON selected.board_id = user_boards.id
      AND user_boards.board_type <> 'spray'
    LEFT JOIN playlists ON playlists.id = selected.playlist_id AND ${playlistVisibilityCondition(scope.viewerId)}
    WHERE user_boards.id IN (${sql.join(
      scope.boardIds.map((id) => sql`${id}`),
      sql`, `,
    )})
  `),
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  return scope.activityBoards.flatMap(({ id, name, physicalBoardUuid }) => {
    const board = byId.get(id);
    if (!board) return [];
    const readySprayBinding =
      board.boardType === 'spray' && board.wallId !== null && board.versionId !== null && !board.onlyMe
        ? {
            boardId: board.id,
            boardUuid: board.uuid,
            gymId: scope.gym.id,
            wallId: board.wallId,
            versionId: board.versionId,
            layoutId: board.layoutId,
            angle: board.angle,
          }
        : null;
    return [
      {
        ...board,
        name,
        physicalBoardUuid,
        readySprayBinding,
        compatibleCollection:
          board.collection && isValidBoardName(board.boardType) && validCollectionHeader(board.collection, board)
            ? board.collection
            : null,
      },
    ];
  });
}

/** Validate the exact prior binding in the fresh post-fence statement. */
export function sprayInventoryBindingExistsSql(binding: SprayInventoryBinding, viewerId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM user_boards ${currentSprayWallJoin()}
    WHERE ${authorizedReportingBoardCondition(binding.gymId, viewerId)}
      AND user_boards.id = ${binding.boardId} AND user_boards.uuid = ${binding.boardUuid}
      AND user_boards.board_type = 'spray' AND user_boards.layout_id = ${binding.layoutId}
      AND user_boards.angle = ${binding.angle} AND spray_wall.id = ${binding.wallId}
      AND spray_version.id = ${binding.versionId} AND NOT ${sprayOnlyMeCondition()}
  )`;
}

export function currentReferenceDifficultySql(): SQL {
  return gradeValueSql(sql`board_climb_stats.display_difficulty`, 'upstream');
}

export function currentReferenceGradeJoins(): SQL {
  return sql`
    LEFT JOIN board_climb_stats ON board_climb_stats.board_type = variant.board_type
      AND board_climb_stats.climb_uuid = variant.climb_uuid AND board_climb_stats.angle = variant.angle
    LEFT JOIN board_climb_grades ON board_climb_grades.board_type = variant.board_type
      AND board_climb_grades.climb_uuid = variant.climb_uuid AND board_climb_grades.angle = variant.angle
  `;
}

const offeringColumns = (boardId: number, physicalBoardUuid: string) =>
  sql`${boardId}::bigint AS board_id, ${physicalBoardUuid}::text AS physical_board_uuid,
    board_climbs.board_type, board_climbs.layout_id, board_climbs.uuid AS climb_uuid`;

export function ledInventoryVariantsSql(
  board: Pick<
    InventoryBoardRow,
    'id' | 'uuid' | 'boardType' | 'layoutId' | 'sizeId' | 'setIds' | 'angle' | 'isAngleAdjustable'
  >,
  collection: GradeCollectionHeader,
  physicalBoardUuid = board.uuid,
): SQL {
  const angle = sql`coalesce(ref.angle, ${board.angle}::int)`;
  const supportedAngles = getRoutableBoardAngles(board.boardType as BoardName);
  const setIds = parseSetIds(board.setIds);
  const compatibility = playlistBoardScopeConditions({
    boardName: board.boardType,
    layoutId: board.layoutId,
    sizeId: board.sizeId,
    setIds,
  });
  return sql`
    SELECT ${offeringColumns(board.id, physicalBoardUuid)}, ${angle} AS angle
    FROM playlist_climbs ref
    LEFT JOIN board_climb_aliases alias ON alias.board_type = ${board.boardType} AND alias.alias_uuid = ref.climb_uuid
    JOIN board_climbs ON board_climbs.board_type = ${board.boardType}
      AND board_climbs.uuid = coalesce(alias.canonical_uuid, ref.climb_uuid)
    WHERE ref.playlist_id = ${collection.id}::bigint
      AND ${publicClimbCondition(boardClimbs)} AND NOT board_climbs.is_hidden
      AND NULLIF(board_climbs.frames, '') IS NOT NULL
      AND ${angle} = ANY(ARRAY[${sql.join(
        supportedAngles.map((value) => sql`${value}`),
        sql`, `,
      )}]::int[])
      ${board.isAngleAdjustable ? sql`` : sql`AND ${angle} = ${board.angle}`}
      ${sql.join(
        compatibility.map((condition) => sql`AND ${condition}`),
        sql` `,
      )}
  `;
}

function sprayInventoryVariantsSql(board: InventoryBoard, binding: SprayInventoryBinding): SQL {
  return sql`(
    WITH bounded AS MATERIALIZED (${boundedSprayLayoutSql(binding.layoutId)})
    SELECT ${offeringColumns(board.id, board.physicalBoardUuid)}, ${binding.angle}::int AS angle
    FROM bounded board_climbs
    WHERE (SELECT count(*) FROM bounded) <= ${GYM_INVENTORY_MAX_REFS}
      AND ${sprayInventoryClimbCondition(binding.layoutId)}
  )`;
}

/** No aliases, grades, or activity are consulted until each eligible input passes the cardinality limits. */
export async function assertInventoryWorkBounded(tx: GymReportingTransaction, boards: InventoryBoard[]): Promise<void> {
  const probes = new Map<string, { source: SQL; configurations: number }>();
  for (const board of boards) {
    const binding = board.readySprayBinding;
    const collection = board.compatibleCollection;
    if (!binding && !collection) continue;
    const key = binding ? `spray:${binding.layoutId}` : `playlist:${collection?.id}`;
    const prior = probes.get(key);
    if (prior) {
      prior.configurations++;
      continue;
    }
    const source = binding
      ? sql`SELECT 1 FROM board_climbs WHERE ${rawSprayLayoutCondition(binding.layoutId)}`
      : sql`SELECT 1 FROM playlist_climbs WHERE playlist_id = ${collection?.id}::bigint`;
    probes.set(key, { source, configurations: 1 });
  }
  if (probes.size === 0) return;
  const checks = [...probes.values()].map(
    ({ source, configurations }) => sql`
    SELECT count(*)::int AS count, ${configurations}::int AS configurations
    FROM (${source} LIMIT ${GYM_INVENTORY_MAX_REFS + 1}) bounded
  `,
  );
  const [result] = rowsFromResult<{ max: number; total: number }>(
    await tx.execute(sql`
    SELECT max(count)::int AS max, sum(count * configurations)::int AS total
    FROM (${sql.join(checks, sql` UNION ALL `)}) counts
  `),
  );
  if (result.max > GYM_INVENTORY_MAX_REFS || result.total > MAX_OFFERING_ROWS) throw inventoryScopeTooLarge();
}

export async function countRawInventoryRows(tx: GymReportingTransaction, source: SQL): Promise<number> {
  const [row] = rowsFromResult<{ count: number }>(
    await tx.execute(sql`
    SELECT count(*)::int AS count FROM (${source} LIMIT ${GYM_INVENTORY_MAX_REFS + 1}) bounded
  `),
  );
  return row.count;
}

export function currentInventoryVariantsSql(boards: InventoryBoard[]): SQL {
  const sourceQueries = boards.flatMap((board) => {
    if (board.readySprayBinding) return [sprayInventoryVariantsSql(board, board.readySprayBinding)];
    if (board.compatibleCollection)
      return [ledInventoryVariantsSql(board, board.compatibleCollection, board.physicalBoardUuid)];
    return [];
  });
  if (sourceQueries.length === 0) {
    return sql`SELECT NULL::bigint AS board_id, NULL::text AS physical_board_uuid, NULL::text AS board_type,
      NULL::int AS layout_id, NULL::text AS climb_uuid, NULL::int AS angle WHERE false`;
  }
  return sql`SELECT DISTINCT * FROM (${sql.join(sourceQueries, sql` UNION ALL `)}) current_offerings`;
}

export function inventoryBoardSummary(board: InventoryBoard, count: number): GymGradeInventoryBoard {
  const spray = board.boardType === 'spray';
  const status = spray
    ? board.onlyMe
      ? 'OWNER_ONLY'
      : board.readySprayBinding
        ? 'READY'
        : 'WALL_UNAVAILABLE'
    : !board.selected
      ? 'CHOOSE_COLLECTION'
      : !board.compatibleCollection
        ? 'COLLECTION_UNAVAILABLE'
        : count === 0
          ? 'COLLECTION_EMPTY'
          : 'READY';
  return {
    boardUuid: board.uuid,
    physicalBoardUuid: board.physicalBoardUuid,
    boardName: board.name,
    kind: spray ? 'SPRAY_WALL' : 'LED_COLLECTION',
    status,
    included: status === 'READY',
    variantCount: count,
    collectionName: board.compatibleCollection?.name ?? null,
  };
}

/** For #7970. Uses current spray availability even if no exposure is known. */
export function activeSprayInventorySql(bindings: readonly SprayInventoryBinding[]): SQL {
  return currentInventoryVariantsSql(
    bindings.map((binding) => ({
      id: binding.boardId,
      uuid: binding.boardUuid,
      boardType: 'spray',
      layoutId: binding.layoutId,
      sizeId: binding.layoutId,
      setIds: '',
      angle: binding.angle,
      isAngleAdjustable: false,
      wallId: binding.wallId,
      versionId: binding.versionId,
      onlyMe: false,
      selected: false,
      collection: null,
      name: '',
      physicalBoardUuid: binding.boardUuid,
      readySprayBinding: binding,
      compatibleCollection: null,
    })),
  );
}

export function gradeCollectionAccessSql(viewerId: string): SQL {
  return playlistVisibilityCondition(viewerId, playlists);
}

export { type InventoryBoard, type InventoryBoardRow };
