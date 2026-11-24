import { and, asc, inArray, sql } from 'drizzle-orm';
import { rowsFromResult } from '@boardsesh/db/client';
import { gymReportingObservations, userBoards } from '@boardsesh/db/schema';
import { db } from '../../../db/client';
import { resolveGymReportingTimeZone } from '../../../services/gym-reporting-time-zone';
import { isSharedConfigFeedBoard } from '../board-presence/shared';
import {
  authorizedReportingBoardCondition,
  readReportingGymIds,
  reportingBoardNotFound,
  type GymReportingScope,
  type GymReportingTransaction,
} from './gym-reporting';
import { lockGymSettings } from './gym-reporting-settings';
import { requireGymEditAccess } from './gyms';

export const GYM_REACH_CONTRACT_VERSION = 1;

/** A dated observation is a forward stored-record contract, not an event. */
export async function readGymReachObservation(tx: GymReportingTransaction, scope: GymReportingScope) {
  if (!scope.timeZoneConfigured || scope.boardIds.length === 0) {
    return { startedAt: null, needsActivation: false };
  }
  const [receipt] = rowsFromResult<{ receipts: number; latest: string | null; reached: boolean }>(
    await tx.execute(sql`
      SELECT count(*)::int AS receipts,
        to_char(max(started_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS latest,
        COALESCE(max(started_at) <= ${scope.asOf}::timestamptz, false) AS reached
      FROM gym_reporting_observations
      WHERE contract_version = ${GYM_REACH_CONTRACT_VERSION}
        AND gym_id IN (${sql.join(
          scope.canonicalGymIds.map((id) => sql`${id}`),
          sql`, `,
        )})
    `),
  );
  const needsActivation = receipt.receipts !== scope.canonicalGymIds.length;
  return { startedAt: !needsActivation && receipt.reached ? receipt.latest : null, needsActivation };
}

/**
 * The first configured, authorized observation schedules this write only after
 * its read-only snapshot commits. That response cannot borrow the new receipt.
 */
export async function activateGymReachObservation(scope: GymReportingScope): Promise<void> {
  await db.transaction(async (tx) => {
    const gym = await lockGymSettings(tx, scope.gym.uuid, scope.viewerId, requireGymEditAccess);
    if (!(await resolveGymReportingTimeZone(gym, tx, scope.addressLocation))) return;
    const readableBoards = (
      await tx
        .select()
        .from(userBoards)
        .where(and(inArray(userBoards.id, scope.boardIds), authorizedReportingBoardCondition(gym.id, scope.viewerId)))
        .orderBy(asc(userBoards.id))
    ).filter((board) => !isSharedConfigFeedBoard(board));
    if (scope.boardUuid && !readableBoards.some((board) => board.uuid === scope.boardUuid)) {
      throw reportingBoardNotFound();
    }
    if (readableBoards.length === 0) return;
    const gymIds = (await readReportingGymIds(tx, gym.id)).sort((left, right) => left - right);
    await tx
      .insert(gymReportingObservations)
      .values(gymIds.map((gymId) => ({ gymId, contractVersion: GYM_REACH_CONTRACT_VERSION })))
      .onConflictDoNothing({ target: [gymReportingObservations.gymId, gymReportingObservations.contractVersion] });
  });
}
