import { and, eq, or, sql } from 'drizzle-orm';
import { boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import { sprayClimbVisibilityCondition } from '@boardsesh/db/queries';
import type { ConnectionContext, SyncClimbDocuments } from '@boardsesh/shared-schema';
import { db } from '../../../db/client';
import { requireAuthenticated } from '../shared/helpers';
import {
  BoardNameSchema,
  ExternalUUIDSchema,
  SyncRequiredBoardScopeIdSchema,
  UUIDSchema,
  validateInput,
} from '../../../validation/schemas';
import { normalizeRow } from './row-normalize';

// Match the ordinary pull's documents. Cast timestamps and sequences to text
// before Drizzle maps them, retaining Postgres microseconds and bigint precision.
const climbColumns = {
  uuid: boardClimbs.uuid,
  board_type: boardClimbs.boardType,
  layout_id: boardClimbs.layoutId,
  setter_id: boardClimbs.setterId,
  setter_username: boardClimbs.setterUsername,
  name: boardClimbs.name,
  description: boardClimbs.description,
  hsm: boardClimbs.hsm,
  edge_left: boardClimbs.edgeLeft,
  edge_right: boardClimbs.edgeRight,
  edge_bottom: boardClimbs.edgeBottom,
  edge_top: boardClimbs.edgeTop,
  angle: boardClimbs.angle,
  frames_count: boardClimbs.framesCount,
  frames_pace: boardClimbs.framesPace,
  frames: boardClimbs.frames,
  is_draft: boardClimbs.isDraft,
  is_listed: boardClimbs.isListed,
  is_hidden: boardClimbs.isHidden,
  created_at: boardClimbs.createdAt,
  published_at: boardClimbs.publishedAt,
  user_id: boardClimbs.userId,
  required_set_ids: boardClimbs.requiredSetIds,
  compatible_size_ids: boardClimbs.compatibleSizeIds,
  characteristics: boardClimbs.characteristics,
  hold_fingerprint: boardClimbs.holdFingerprint,
  missing_hold_count: boardClimbs.missingHoldCount,
  updated_at: sql<string>`${boardClimbs.updatedAt}::text`,
  sync_seq: sql<string>`${boardClimbs.syncSeq}::text`,
};
const statsColumns = {
  board_type: boardClimbStats.boardType,
  climb_uuid: boardClimbStats.climbUuid,
  angle: boardClimbStats.angle,
  display_difficulty: boardClimbStats.displayDifficulty,
  benchmark_difficulty: boardClimbStats.benchmarkDifficulty,
  ascensionist_count: sql<string | null>`${boardClimbStats.ascensionistCount}::text`,
  difficulty_average: boardClimbStats.difficultyAverage,
  quality_average: boardClimbStats.qualityAverage,
  fa_username: boardClimbStats.faUsername,
  fa_at: boardClimbStats.faAt,
  updated_at: sql<string>`${boardClimbStats.updatedAt}::text`,
  sync_seq: sql<string>`${boardClimbStats.syncSeq}::text`,
};

type SavedClimbScope = {
  boardType: string;
  layoutId: number;
  climbUuid: string;
  sprayWallUuid?: string | null;
};

/**
 * Mirror a committed write immediately. Authors may read their own drafts;
 * other readable published spray rows also support wall/gym editors without
 * copying mutation permissions into a read endpoint. Ordinary pulls keep their
 * stability window and cursors: this exact UUID read never advances either.
 * The wall gate and both documents share a repeatable-read primary snapshot.
 */
export async function syncClimbDocuments(
  _: unknown,
  { boardType, layoutId, climbUuid, sprayWallUuid }: SavedClimbScope,
  ctx: ConnectionContext,
): Promise<SyncClimbDocuments | null> {
  requireAuthenticated(ctx);
  const validBoardType = validateInput(BoardNameSchema, boardType, 'boardType');
  const validLayoutId = validateInput(SyncRequiredBoardScopeIdSchema, layoutId, 'layoutId');
  const validClimbUuid = validateInput(ExternalUUIDSchema, climbUuid, 'climbUuid');
  const validWallUuid = sprayWallUuid == null ? null : validateInput(UUIDSchema, sprayWallUuid, 'sprayWallUuid');

  return db.transaction(
    async (transaction) => {
      const [climb] = await transaction
        .select(climbColumns)
        .from(boardClimbs)
        .where(
          and(
            eq(boardClimbs.uuid, validClimbUuid),
            eq(boardClimbs.boardType, validBoardType),
            eq(boardClimbs.layoutId, validLayoutId),
            or(
              eq(boardClimbs.userId, ctx.userId!),
              and(eq(boardClimbs.boardType, 'spray'), eq(boardClimbs.isDraft, false)),
            ),
            sprayClimbVisibilityCondition(boardClimbs, ctx.userId, validWallUuid),
          ),
        );
      // Missing, deleted, private and inaccessible rows deliberately look alike.
      if (!climb) return null;
      const stats = await transaction
        .select(statsColumns)
        .from(boardClimbStats)
        .where(and(eq(boardClimbStats.boardType, validBoardType), eq(boardClimbStats.climbUuid, validClimbUuid)));
      return { viewerId: ctx.userId!, climb: normalizeRow(climb), stats: stats.map(normalizeRow) };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}
