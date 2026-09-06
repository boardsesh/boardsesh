import { eq, and, sql } from 'drizzle-orm';
import { executeRows } from '@boardsesh/db/client';
import { db } from '../../../../db/client';
import * as dbSchema from '@boardsesh/db/schema';
import { resolveCommunitySetting } from '../community-settings';
import type { ProposalExecutor } from './lifecycle';

/**
 * Analyze if a climb's grade at a given angle is an outlier compared to adjacent angles.
 */
export async function analyzeGradeOutlier(
  climbUuid: string,
  boardType: string,
  angle: number,
): Promise<{
  isOutlier: boolean;
  currentGrade: number;
  neighborAverage: number;
  neighborCount: number;
  gradeDifference: number;
} | null> {
  try {
    // Query climb stats across all angles for this climb (unified table)
    const rows = await executeRows<{
      angle: number;
      display_difficulty: number;
      ascensionist_count: number;
    }>(
      db,
      sql`
      SELECT angle, display_difficulty, ascensionist_count
      FROM board_climb_stats
      WHERE climb_uuid = ${climbUuid}
        AND board_type = ${boardType}
      ORDER BY angle
    `,
    );
    if (!rows || rows.length < 2) return null;

    // Find the current angle's data
    const currentRow = rows.find((r) => r.angle === angle);
    if (!currentRow) return null;

    const currentGrade = Number(currentRow.display_difficulty);

    // Find adjacent angles
    const sortedAngles = rows.map((r) => r.angle).sort((a, b) => a - b);
    const currentIdx = sortedAngles.indexOf(angle);
    if (currentIdx === -1) return null;

    // Resolve outlier settings
    const minAscentsStr = await resolveCommunitySetting('outlier_min_ascents', climbUuid, angle, boardType);
    const gradeDiffStr = await resolveCommunitySetting('outlier_grade_diff', climbUuid, angle, boardType);
    const minAscents = parseInt(minAscentsStr, 10) || 10;
    const gradeDiffThreshold = parseInt(gradeDiffStr, 10) || 2;

    // Get qualifying neighbors
    const neighbors: { difficulty: number; weight: number }[] = [];
    for (let i = Math.max(0, currentIdx - 2); i <= Math.min(sortedAngles.length - 1, currentIdx + 2); i++) {
      if (i === currentIdx) continue;
      const neighborRow = rows.find((r) => r.angle === sortedAngles[i]);
      if (!neighborRow) continue;
      if (Number(neighborRow.ascensionist_count) < minAscents) continue;
      neighbors.push({
        difficulty: Number(neighborRow.display_difficulty),
        weight: Number(neighborRow.ascensionist_count),
      });
    }

    if (neighbors.length < 2) return null;

    // Compute weighted average
    const totalWeight = neighbors.reduce((acc, n) => acc + n.weight, 0);
    const neighborAverage = neighbors.reduce((acc, n) => acc + n.difficulty * n.weight, 0) / totalWeight;
    const gradeDifference = Math.abs(currentGrade - neighborAverage);

    return {
      isOutlier: gradeDifference >= gradeDiffThreshold,
      currentGrade,
      neighborAverage,
      neighborCount: neighbors.length,
      gradeDifference,
    };
  } catch {
    return null;
  }
}

/**
 * The weighted-upvote count a proposal on this climb needs to carry.
 *
 * Split out from `checkAutoApproval` because `resolveCommunitySetting` reads
 * through the `db` singleton: called from inside a locked transaction it would
 * check out a SECOND pool connection while the first is held, and a burst of
 * reports would exhaust the (max 10) pool. Callers resolve the threshold
 * BEFORE they take the proposal lock and hand the number in.
 */
export async function resolveApprovalThreshold(
  climbUuid: string,
  angle: number | null,
  boardType: string,
): Promise<number> {
  const threshold = await resolveCommunitySetting('approval_threshold', climbUuid, angle, boardType);
  return parseInt(threshold, 10) || 5;
}

/**
 * Has the proposal reached `required` weighted upvotes?
 *
 * Pure tally, one query, no settings lookup — see `resolveApprovalThreshold` for
 * why the number arrives pre-resolved.
 */
export async function checkAutoApproval(
  proposalId: number,
  required: number,
  executor: ProposalExecutor = db,
): Promise<boolean> {
  // Sum weighted upvotes — through the caller's executor so the tally that
  // approves a proposal is read inside the same locked transaction that flips it.
  const result = await executor
    .select({
      weightedSum: sql<number>`COALESCE(SUM(${dbSchema.proposalVotes.value} * ${dbSchema.proposalVotes.weight}), 0)`.as(
        'weighted_sum',
      ),
    })
    .from(dbSchema.proposalVotes)
    .where(and(eq(dbSchema.proposalVotes.proposalId, proposalId), sql`${dbSchema.proposalVotes.value} > 0`));

  const weightedSum = Number(result[0]?.weightedSum || 0);
  return weightedSum >= required;
}
