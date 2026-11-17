import { and, eq, inArray } from 'drizzle-orm';
import { boardClimbAliases, boardClimbGrades, boardClimbs, boardClimbStats } from '@boardsesh/db/schema';
import { getGradeLabel, publicClimbCondition, toConfidenceTier } from '@boardsesh/db/queries';
import type { BoardPresenceClimbGrade } from '@boardsesh/shared-schema';
import { db } from '../db/client';

/** Two set-based reads, independent of requested row count. Caller enforces board access. */
export async function readBoardPresenceClimbGrades(
  board: { boardType: string; layoutId: number },
  angle: number,
  requestedUuids: readonly string[],
  reader: Pick<typeof db, 'select'> = db,
): Promise<BoardPresenceClimbGrade[]> {
  const distinctUuids = [...new Set(requestedUuids)];
  if (!distinctUuids.length) return [];
  const aliases = await reader
    .select({ aliasUuid: boardClimbAliases.aliasUuid, canonicalUuid: boardClimbAliases.canonicalUuid })
    .from(boardClimbAliases)
    .where(and(eq(boardClimbAliases.boardType, board.boardType), inArray(boardClimbAliases.aliasUuid, distinctUuids)));
  const canonicalByAlias = new Map(aliases.map((alias) => [alias.aliasUuid, alias.canonicalUuid]));
  const canonicalUuids = [...new Set(distinctUuids.map((uuid) => canonicalByAlias.get(uuid) ?? uuid))];
  const rows = await reader
    .select({
      uuid: boardClimbs.uuid,
      displayDifficulty: boardClimbStats.displayDifficulty,
      universalGrade: boardClimbGrades.universalGrade,
      localGrade: boardClimbGrades.localGrade,
      confidence: boardClimbGrades.confidence,
    })
    .from(boardClimbs)
    .leftJoin(
      boardClimbStats,
      and(
        eq(boardClimbStats.boardType, boardClimbs.boardType),
        eq(boardClimbStats.climbUuid, boardClimbs.uuid),
        eq(boardClimbStats.angle, angle),
      ),
    )
    .leftJoin(
      boardClimbGrades,
      and(
        eq(boardClimbGrades.boardType, boardClimbs.boardType),
        eq(boardClimbGrades.climbUuid, boardClimbs.uuid),
        eq(boardClimbGrades.angle, angle),
      ),
    )
    .where(
      and(
        eq(boardClimbs.boardType, board.boardType),
        eq(boardClimbs.layoutId, board.layoutId),
        inArray(boardClimbs.uuid, canonicalUuids),
        publicClimbCondition(boardClimbs),
      ),
    );
  const rowsByUuid = new Map(rows.map((row) => [row.uuid, row]));
  return distinctUuids.flatMap((requestedUuid) => {
    const row = rowsByUuid.get(canonicalByAlias.get(requestedUuid) ?? requestedUuid);
    if (!row) return [];
    const boardseshDifficulty = row.universalGrade ?? row.localGrade;
    return [
      {
        uuid: requestedUuid,
        difficulty:
          row.displayDifficulty == null
            ? null
            : getGradeLabel(Math.round(Number(row.displayDifficulty)), board.boardType) || null,
        boardseshDifficulty: boardseshDifficulty == null ? null : Number(boardseshDifficulty),
        boardseshConfidence: toConfidenceTier(row.confidence),
      },
    ];
  });
}
